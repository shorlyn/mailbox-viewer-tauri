use arboard::Clipboard;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::Client;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};
use url::Url;

const CLIENT_ID: &str = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
const SCOPE: &str = "offline_access https://graph.microsoft.com/Mail.Read";
const REDIRECT_URI: &str = "https://localhost";
const CACHE_LIMIT: u32 = 100;

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Mailbox Viewer")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[derive(Clone)]
struct Account {
    email: String,
    password: String,
    refresh_token: String,
}

#[derive(Clone)]
struct CachedToken {
    access_token: String,
    expires_at: u64,
}

struct AppState {
    http: Client,
    token_cache: Mutex<HashMap<String, CachedToken>>,
    auth_sessions: Mutex<HashMap<String, String>>,
}

#[derive(Serialize)]
struct AccountInfo {
    email: String,
    display_name: String,
    status: String,
    error: String,
    count: Option<usize>,
}

#[derive(Serialize)]
struct StartAuthResult {
    state: String,
    auth_url: String,
    redirect_uri: String,
}

#[derive(Serialize)]
struct ExchangeResult {
    status: String,
    email: String,
}

#[derive(Serialize)]
struct AccountStatus {
    email: String,
    display_name: String,
    count: usize,
    last_received_at: Option<String>,
    status: String,
    error: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}

fn token_file(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("create app data dir: {e}"))?;
    let target = data_dir.join("mailbox_tokens.txt");
    let should_import = !target.exists()
        || fs::metadata(&target)
            .map(|meta| meta.len() == 0)
            .unwrap_or(true);
    if should_import {
        for candidate in token_import_candidates() {
            if candidate.exists() {
                fs::copy(&candidate, &target).map_err(|e| format!("import token file: {e}"))?;
                break;
            }
        }
    }
    Ok(target)
}

fn token_import_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("mailbox_tokens.txt"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("mailbox_tokens.txt"));
        }
        if let Some(parent) = cwd.parent().and_then(|p| p.parent()) {
            candidates.push(parent.join("mailbox_tokens.txt"));
        }
    }
    candidates
}

fn cache_db_file(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(data_dir.join("mailbox_cache.sqlite"))
}

fn ensure_db_writable(path: &PathBuf) {
    // Windows 有时会给 SQLite 文件打上只读属性，导致 WAL 写入失败，这里主动清掉。
    for suffix in ["", "-shm", "-wal"] {
        let p = if suffix.is_empty() {
            path.clone()
        } else {
            let mut s = path.as_os_str().to_owned();
            s.push(suffix);
            PathBuf::from(s)
        };
        if p.exists() {
            if let Ok(meta) = fs::metadata(&p) {
                let mut perms = meta.permissions();
                if perms.readonly() {
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&p, perms);
                }
            }
        }
    }
}

fn open_cache_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = cache_db_file(app)?;
    ensure_db_writable(&db_path);
    let conn = Connection::open(&db_path).map_err(|e| format!("open cache db: {e}"))?;
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS messages (
            account_email TEXT NOT NULL,
            message_id TEXT NOT NULL,
            received_at TEXT NOT NULL,
            subject TEXT NOT NULL DEFAULT '',
            from_email TEXT NOT NULL DEFAULT '',
            raw_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_email, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_account_received
            ON messages(account_email, received_at DESC);
        CREATE TABLE IF NOT EXISTS account_profiles (
            email TEXT PRIMARY KEY,
            display_name TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS message_flags (
            account_email TEXT NOT NULL,
            message_id TEXT NOT NULL,
            flagged INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_email, message_id)
        );
        CREATE TABLE IF NOT EXISTS local_read_state (
            account_email TEXT NOT NULL,
            message_id TEXT NOT NULL,
            is_read INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_email, message_id)
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )
    .map_err(|e| format!("init cache db: {e}"))?;
    Ok(conn)
}

fn account_display_name(app: &AppHandle, email: &str) -> Result<String, String> {
    let conn = open_cache_db(app)?;
    let mut stmt = conn
        .prepare("SELECT display_name FROM account_profiles WHERE email = ?1")
        .map_err(|e| format!("account profile prepare: {e}"))?;
    let display_name = stmt
        .query_row(params![email], |row| row.get::<_, String>(0))
        .unwrap_or_default();
    if display_name.trim().is_empty() {
        Ok(email.to_string())
    } else {
        Ok(display_name)
    }
}

fn cached_message_count(app: &AppHandle, email: &str) -> Result<usize, String> {
    let conn = open_cache_db(app)?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE account_email = ?1",
            params![email],
            |row| row.get(0),
        )
        .map_err(|e| format!("count cached messages: {e}"))?;
    Ok(count.max(0) as usize)
}

fn is_message_flagged(conn: &Connection, account_email: &str, message_id: &str) -> bool {
    conn.query_row(
        "
        SELECT flagged
        FROM message_flags
        WHERE account_email = ?1 AND message_id = ?2
        ",
        params![account_email, message_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .unwrap_or(false)
}

fn local_read_state(conn: &Connection, account_email: &str, message_id: &str) -> Option<bool> {
    conn.query_row(
        "
        SELECT is_read
        FROM local_read_state
        WHERE account_email = ?1 AND message_id = ?2
        ",
        params![account_email, message_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| Some(value == 1))
    .unwrap_or(None)
}

fn attach_local_fields(
    conn: &Connection,
    app: &AppHandle,
    account_email: &str,
    mut value: Value,
) -> Value {
    let id = message_id(&value);
    value["_accountEmail"] = Value::String(account_email.to_string());
    value["_accountDisplayName"] = Value::String(
        account_display_name(app, account_email).unwrap_or_else(|_| account_email.to_string()),
    );
    value["_flagged"] = Value::Bool(is_message_flagged(conn, account_email, &id));
    // Read state: local override > graph isRead > default false
    let graph_read = value.get("isRead").and_then(Value::as_bool);
    value["_graphRead"] = match graph_read {
        Some(b) => Value::Bool(b),
        None => Value::Null,
    };
    let local = local_read_state(conn, account_email, &id);
    let is_read = match local {
        Some(b) => b,
        None => graph_read.unwrap_or(false),
    };
    value["_localRead"] = Value::Bool(is_read);
    value
}

fn value_text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn message_id(message: &Value) -> String {
    let id = value_text(message, "id");
    if !id.is_empty() {
        return id.to_string();
    }
    let from = message
        .pointer("/from/emailAddress/address")
        .and_then(Value::as_str)
        .unwrap_or("");
    [
        from,
        value_text(message, "subject"),
        value_text(message, "receivedDateTime"),
    ]
    .join("|")
}

fn cache_messages(app: &AppHandle, account_email: &str, data: &Value) -> Result<(), String> {
    let messages = data
        .get("value")
        .and_then(Value::as_array)
        .ok_or_else(|| "graph response missing value".to_string())?;
    let mut conn = open_cache_db(app)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("cache transaction: {e}"))?;
    for message in messages {
        let id = message_id(message);
        let received_at = value_text(message, "receivedDateTime");
        let subject = value_text(message, "subject");
        let from_email = message
            .pointer("/from/emailAddress/address")
            .and_then(Value::as_str)
            .unwrap_or("");
        let raw_json =
            serde_json::to_string(message).map_err(|e| format!("serialize message cache: {e}"))?;
        tx.execute(
            "
            INSERT INTO messages (
                account_email, message_id, received_at, subject, from_email, raw_json, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(account_email, message_id) DO UPDATE SET
                received_at = excluded.received_at,
                subject = excluded.subject,
                from_email = excluded.from_email,
                raw_json = excluded.raw_json,
                updated_at = excluded.updated_at
            ",
            params![
                account_email,
                id,
                received_at,
                subject,
                from_email,
                raw_json,
                now_secs() as i64
            ],
        )
        .map_err(|e| format!("write message cache: {e}"))?;
    }
    tx.execute(
        "
        DELETE FROM messages
        WHERE account_email = ?1
          AND message_id NOT IN (
            SELECT message_id
            FROM messages
            WHERE account_email = ?1
            ORDER BY received_at DESC
            LIMIT ?2
          )
        ",
        params![account_email, CACHE_LIMIT],
    )
    .map_err(|e| format!("trim message cache: {e}"))?;
    tx.commit().map_err(|e| format!("commit cache: {e}"))?;
    Ok(())
}

fn cached_messages(app: &AppHandle, email: &str, top: u32) -> Result<Value, String> {
    let conn = open_cache_db(app)?;
    let mut stmt = conn
        .prepare(
            "
            SELECT raw_json
            FROM messages
            WHERE account_email = ?1
            ORDER BY received_at DESC
            LIMIT ?2
            ",
        )
        .map_err(|e| format!("read cache prepare: {e}"))?;
    let rows = stmt
        .query_map(params![email, top], |row| row.get::<_, String>(0))
        .map_err(|e| format!("read cache: {e}"))?;
    let mut messages = Vec::new();
    for row in rows {
        let text = row.map_err(|e| format!("read cache row: {e}"))?;
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            messages.push(attach_local_fields(&conn, app, email, value));
        }
    }
    Ok(json!({ "value": messages, "source": "cache" }))
}

fn setting_value(conn: &Connection, key: &str, fallback: &str) -> String {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| fallback.to_string())
}

fn load_accounts_from_path(path: PathBuf) -> Result<Vec<Account>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("read token file: {e}"))?;
    let mut accounts = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split("---").collect();
        if parts.len() >= 3 {
            accounts.push(Account {
                email: parts[0].to_string(),
                password: parts[1].to_string(),
                refresh_token: parts[2].to_string(),
            });
        }
    }
    Ok(accounts)
}

fn load_accounts(app: &AppHandle) -> Result<Vec<Account>, String> {
    load_accounts_from_path(token_file(app)?)
}

fn save_account(
    app: &AppHandle,
    email: &str,
    password: &str,
    refresh_token: &str,
) -> Result<(), String> {
    let path = token_file(app)?;
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut lines = Vec::new();
    let mut replaced = false;

    for line in existing.lines() {
        let raw = line.trim_end();
        if raw.is_empty() || raw.starts_with('#') {
            lines.push(line.to_string());
            continue;
        }
        let parts: Vec<&str> = raw.split("---").collect();
        if parts.len() >= 3 && parts[0] == email {
            lines.push(format!("{email}---{password}---{refresh_token}---0"));
            replaced = true;
        } else {
            lines.push(line.to_string());
        }
    }

    if !replaced {
        lines.push(format!("{email}---{password}---{refresh_token}---0"));
    }

    fs::write(path, format!("{}\n", lines.join("\n"))).map_err(|e| format!("write token file: {e}"))
}

fn build_auth_url(state: &str) -> String {
    let mut url =
        Url::parse("https://login.microsoftonline.com/common/oauth2/v2.0/authorize").unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("response_mode", "query")
        .append_pair("scope", SCOPE)
        .append_pair("state", state);
    url.to_string()
}

fn extract_code(input: &str) -> String {
    if input.contains("code=") {
        if let Ok(url) = Url::parse(input) {
            for (key, value) in url.query_pairs() {
                if key == "code" {
                    return value.to_string();
                }
            }
        }
    }
    input.trim().to_string()
}

async fn exchange_code_for_token(http: &Client, code: &str) -> Result<TokenResponse, String> {
    let params = [
        ("client_id", CLIENT_ID),
        ("code", code),
        ("redirect_uri", REDIRECT_URI),
        ("grant_type", "authorization_code"),
        ("scope", SCOPE),
    ];
    token_request(http, &params).await
}

async fn refresh_access_token(http: &Client, refresh_token: &str) -> Result<TokenResponse, String> {
    let params = [
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
        ("scope", SCOPE),
    ];
    token_request(http, &params).await
}

async fn token_request(http: &Client, params: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let resp = http
        .post("https://login.microsoftonline.com/common/oauth2/v2.0/token")
        .form(params)
        .send()
        .await
        .map_err(|e| format!("token request: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("token response: {e}"))?;
    let data: TokenResponse = serde_json::from_str(&body).map_err(|_| body.clone())?;
    if !status.is_success() || data.error.is_some() {
        return Err(data
            .error_description
            .or(data.error)
            .unwrap_or_else(|| body));
    }
    Ok(data)
}

fn email_from_access_token(access_token: &str) -> Option<String> {
    let payload = access_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let data: Value = serde_json::from_slice(&bytes).ok()?;
    for key in ["preferred_username", "upn", "email", "unique_name"] {
        let value = data.get(key).and_then(Value::as_str).unwrap_or("");
        if value.contains('@') {
            return Some(value.to_string());
        }
    }
    None
}

async fn fetch_me_email(http: &Client, access_token: &str) -> Option<String> {
    let resp = http
        .get("https://graph.microsoft.com/v1.0/me")
        .bearer_auth(access_token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let data: Value = resp.json().await.ok()?;
    data.get("mail")
        .or_else(|| data.get("userPrincipalName"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

async fn email_for_token(http: &Client, access_token: &str) -> String {
    if let Some(email) = email_from_access_token(access_token) {
        return email;
    }
    if let Some(email) = fetch_me_email(http, access_token).await {
        return email;
    }
    format!("unknown-{}", now_secs())
}

async fn access_token_for_account(
    app: &AppHandle,
    state: &AppState,
    account: &Account,
) -> Result<String, String> {
    if let Some(cached) = state
        .token_cache
        .lock()
        .map_err(|_| "token cache lock failed".to_string())?
        .get(&account.email)
        .cloned()
    {
        if cached.expires_at > now_secs() + 60 {
            return Ok(cached.access_token);
        }
    }

    let token = refresh_access_token(&state.http, &account.refresh_token).await?;
    if let Some(new_refresh) = token.refresh_token.as_deref() {
        save_account(app, &account.email, &account.password, new_refresh)?;
    }

    let expires_at = now_secs() + token.expires_in.unwrap_or(3600);
    state
        .token_cache
        .lock()
        .map_err(|_| "token cache lock failed".to_string())?
        .insert(
            account.email.clone(),
            CachedToken {
                access_token: token.access_token.clone(),
                expires_at,
            },
        );

    Ok(token.access_token)
}

#[tauri::command]
fn list_accounts(app: AppHandle) -> Result<Vec<AccountInfo>, String> {
    let accounts = load_accounts(&app)?;
    let mut result = Vec::new();
    for acc in accounts {
        let display_name = account_display_name(&app, &acc.email)?;
        let count = cached_message_count(&app, &acc.email).ok();
        result.push(AccountInfo {
            email: acc.email,
            display_name,
            status: "saved".to_string(),
            error: String::new(),
            count,
        });
    }
    Ok(result)
}

#[tauri::command]
fn set_account_display_name(
    app: AppHandle,
    email: String,
    display_name: String,
) -> Result<AccountInfo, String> {
    let accounts = load_accounts(&app)?;
    if !accounts.iter().any(|acc| acc.email == email) {
        return Err("account not found".to_string());
    }
    let name = display_name.trim();
    let conn = open_cache_db(&app)?;
    conn.execute(
        "
        INSERT INTO account_profiles (email, display_name, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(email) DO UPDATE SET
            display_name = excluded.display_name,
            updated_at = excluded.updated_at
        ",
        params![&email, name, now_secs() as i64],
    )
    .map_err(|e| format!("save account profile: {e}"))?;
    Ok(AccountInfo {
        display_name: if name.is_empty() {
            email.clone()
        } else {
            name.to_string()
        },
        count: cached_message_count(&app, &email).ok(),
        email,
        status: "saved".to_string(),
        error: String::new(),
    })
}

#[tauri::command]
async fn start_auth(state: State<'_, AppState>) -> Result<StartAuthResult, String> {
    let state_id = format!("{}{}", now_secs(), rand_suffix());
    state
        .auth_sessions
        .lock()
        .map_err(|_| "auth session lock failed".to_string())?
        .insert(state_id.clone(), String::new());
    let auth_url = build_auth_url(&state_id);
    open::that(&auth_url).map_err(|e| format!("open browser: {e}"))?;
    Ok(StartAuthResult {
        state: state_id,
        auth_url,
        redirect_uri: REDIRECT_URI.to_string(),
    })
}

fn rand_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_nanos();
    format!("{nanos:x}")
}

#[tauri::command]
async fn exchange_code(
    app: AppHandle,
    state: State<'_, AppState>,
    state_id: String,
    code_or_url: String,
) -> Result<ExchangeResult, String> {
    let known = state
        .auth_sessions
        .lock()
        .map_err(|_| "auth session lock failed".to_string())?
        .remove(&state_id);
    if known.is_none() {
        return Err("login session not found".to_string());
    }

    let code = extract_code(&code_or_url);
    let token = exchange_code_for_token(&state.http, &code).await?;
    let refresh_token = token
        .refresh_token
        .as_deref()
        .ok_or_else(|| "refresh_token missing".to_string())?;
    let email = email_for_token(&state.http, &token.access_token).await;
    save_account(&app, &email, "", refresh_token)?;

    state
        .token_cache
        .lock()
        .map_err(|_| "token cache lock failed".to_string())?
        .insert(
            email.clone(),
            CachedToken {
                access_token: token.access_token,
                expires_at: now_secs() + token.expires_in.unwrap_or(3600),
            },
        );

    Ok(ExchangeResult {
        status: "done".to_string(),
        email,
    })
}

#[tauri::command]
async fn start_reauth(
    state: State<'_, AppState>,
    email: String,
) -> Result<StartAuthResult, String> {
    let state_id = format!("{}{}", now_secs(), rand_suffix());
    state
        .auth_sessions
        .lock()
        .map_err(|_| "auth session lock failed".to_string())?
        .insert(state_id.clone(), email);
    let auth_url = build_auth_url(&state_id);
    open::that(&auth_url).map_err(|e| format!("open browser: {e}"))?;
    Ok(StartAuthResult {
        state: state_id,
        auth_url,
        redirect_uri: REDIRECT_URI.to_string(),
    })
}

#[tauri::command]
async fn exchange_reauth_code(
    app: AppHandle,
    state: State<'_, AppState>,
    state_id: String,
    expected_email: String,
    code_or_url: String,
) -> Result<ExchangeResult, String> {
    let stored_email = state
        .auth_sessions
        .lock()
        .map_err(|_| "auth session lock failed".to_string())?
        .remove(&state_id);
    match stored_email {
        Some(ref e) if e == &expected_email => {}
        Some(_) => {
            return Err("login session email mismatch".to_string());
        }
        None => {
            return Err("login session not found".to_string());
        }
    }

    let code = extract_code(&code_or_url);
    let token = exchange_code_for_token(&state.http, &code).await?;
    let refresh_token = token
        .refresh_token
        .as_deref()
        .ok_or_else(|| "refresh_token missing".to_string())?;
    let resolved = email_for_token(&state.http, &token.access_token).await;
    // 如果 token 中无法解析出邮箱（个人 Outlook 账号缺少 User.Read 权限导致
    // /me 接口返回 403，JWT payload 也可能没有对应字段），则直接信任调用方
    // 传入的 expected_email，因为 reauth 流程本身已锁定目标账号。
    let actual_email = if resolved.starts_with("unknown-") {
        expected_email.clone()
    } else {
        if resolved.to_lowercase() != expected_email.to_lowercase() {
            return Err(format!(
                "登录邮箱不一致：期望 {}，实际 {}",
                expected_email, resolved
            ));
        }
        resolved
    };

    save_account(&app, &actual_email, "", refresh_token)?;

    state
        .token_cache
        .lock()
        .map_err(|_| "token cache lock failed".to_string())?
        .insert(
            actual_email.clone(),
            CachedToken {
                access_token: token.access_token,
                expires_at: now_secs() + token.expires_in.unwrap_or(3600),
            },
        );

    Ok(ExchangeResult {
        status: "done".to_string(),
        email: actual_email,
    })
}

fn simplify_graph_error(status_code: u16, body: &str) -> String {
    if status_code == 401 || status_code == 403 {
        return "NEED_RELOGIN: 需要重新登录".to_string();
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = parsed
            .pointer("/error/message")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return msg.to_string();
        }
        if let Some(desc) = parsed
            .get("error_description")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return desc.to_string();
        }
    }
    if body.len() > 200 {
        return format!("请求失败 (HTTP {})", status_code);
    }
    body.to_string()
}

#[tauri::command]
async fn fetch_emails(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    top: Option<u32>,
) -> Result<Value, String> {
    let top = top.unwrap_or(CACHE_LIMIT).clamp(1, CACHE_LIMIT);
    let accounts = load_accounts(&app)?;
    let account = accounts
        .into_iter()
        .find(|acc| acc.email == email)
        .ok_or_else(|| "account not found".to_string())?;
    let access_token = access_token_for_account(&app, &state, &account).await?;
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages?$top={top}&$orderby=receivedDateTime%20desc&$select=id,from,toRecipients,subject,bodyPreview,receivedDateTime,body,isRead"
    );
    let resp = state
        .http
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("graph request: {e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("graph response: {e}"))?;
    if !status.is_success() {
        return Err(simplify_graph_error(status.as_u16(), &body));
    }
    let mut data: Value = serde_json::from_str(&body).map_err(|e| format!("graph json: {e}"))?;
    cache_messages(&app, &email, &data)?;
    let conn = open_cache_db(&app)?;
    if let Some(messages) = data.get_mut("value").and_then(Value::as_array_mut) {
        for message in messages {
            let current = std::mem::take(message);
            *message = attach_local_fields(&conn, &app, &email, current);
        }
    }
    Ok(data)
}

#[tauri::command]
fn get_cached_emails(app: AppHandle, email: String, top: Option<u32>) -> Result<Value, String> {
    cached_messages(&app, &email, top.unwrap_or(CACHE_LIMIT).clamp(1, CACHE_LIMIT))
}

#[tauri::command]
fn get_all_cached_emails(app: AppHandle, top: Option<u32>) -> Result<Value, String> {
    let top = top.unwrap_or(CACHE_LIMIT).clamp(1, CACHE_LIMIT) as i64;
    let conn = open_cache_db(&app)?;
    let mut stmt = conn
        .prepare(
            "
            SELECT account_email, raw_json
            FROM messages
            ORDER BY received_at DESC
            LIMIT ?1
            ",
        )
        .map_err(|e| format!("all cached prepare: {e}"))?;
    let rows = stmt
        .query_map(params![top], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("all cached query: {e}"))?;
    let mut messages = Vec::new();
    for row in rows {
        let (account_email, text) = row.map_err(|e| format!("all cached row: {e}"))?;
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            messages.push(attach_local_fields(&conn, &app, &account_email, value));
        }
    }
    Ok(json!({ "value": messages, "source": "cache" }))
}

#[tauri::command]
fn get_flagged_emails(app: AppHandle, top: Option<u32>) -> Result<Value, String> {
    let top = top.unwrap_or(CACHE_LIMIT).clamp(1, CACHE_LIMIT) as i64;
    let conn = open_cache_db(&app)?;
    let mut stmt = conn
        .prepare(
            "
            SELECT m.account_email, m.raw_json
            FROM messages m
            JOIN message_flags f
              ON f.account_email = m.account_email AND f.message_id = m.message_id
            WHERE f.flagged = 1
            ORDER BY m.received_at DESC
            LIMIT ?1
            ",
        )
        .map_err(|e| format!("flagged prepare: {e}"))?;
    let rows = stmt
        .query_map(params![top], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("flagged query: {e}"))?;
    let mut messages = Vec::new();
    for row in rows {
        let (account_email, text) = row.map_err(|e| format!("flagged row: {e}"))?;
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            messages.push(attach_local_fields(&conn, &app, &account_email, value));
        }
    }
    Ok(json!({ "value": messages, "source": "cache" }))
}

#[tauri::command]
fn set_message_flag(
    app: AppHandle,
    account_email: String,
    message_id: String,
    flagged: bool,
) -> Result<(), String> {
    let conn = open_cache_db(&app)?;
    conn.execute(
        "
        INSERT INTO message_flags (account_email, message_id, flagged, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(account_email, message_id) DO UPDATE SET
            flagged = excluded.flagged,
            updated_at = excluded.updated_at
        ",
        params![
            account_email,
            message_id,
            if flagged { 1 } else { 0 },
            now_secs() as i64
        ],
    )
    .map_err(|e| format!("set message flag: {e}"))?;
    Ok(())
}

#[tauri::command]
fn set_message_read(
    app: AppHandle,
    account_email: String,
    message_id: String,
    is_read: bool,
) -> Result<(), String> {
    let conn = open_cache_db(&app)?;
    conn.execute(
        "
        INSERT INTO local_read_state (account_email, message_id, is_read, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(account_email, message_id) DO UPDATE SET
            is_read = excluded.is_read,
            updated_at = excluded.updated_at
        ",
        params![
            account_email,
            message_id,
            if is_read { 1 } else { 0 },
            now_secs() as i64
        ],
    )
    .map_err(|e| format!("set message read: {e}"))?;
    Ok(())
}

#[tauri::command]
fn get_app_settings(app: AppHandle) -> Result<Value, String> {
    let conn = open_cache_db(&app)?;
    Ok(json!({
        "cacheLimit": setting_value(&conn, "cacheLimit", "100"),
        "autoInterval": setting_value(&conn, "autoInterval", "300000"),
        "autoEnabled": setting_value(&conn, "autoEnabled", "false"),
        "dataDir": app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?.display().to_string(),
    }))
}

#[tauri::command]
fn save_app_settings(app: AppHandle, cache_limit: String, auto_interval: String, auto_enabled: String) -> Result<(), String> {
    let cache_limit_num = cache_limit.parse::<u32>().unwrap_or(CACHE_LIMIT).clamp(50, 200);
    let auto_interval_num = auto_interval
        .parse::<u32>()
        .unwrap_or(300000)
        .clamp(180000, 600000);
    let auto_enabled_val = if auto_enabled == "true" { "true" } else { "false" };
    let conn = open_cache_db(&app)?;
    conn.execute(
        "
        INSERT INTO app_settings (key, value)
        VALUES ('cacheLimit', ?1)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        ",
        params![cache_limit_num.to_string()],
    )
    .map_err(|e| format!("save cache setting: {e}"))?;
    conn.execute(
        "
        INSERT INTO app_settings (key, value)
        VALUES ('autoInterval', ?1)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        ",
        params![auto_interval_num.to_string()],
    )
    .map_err(|e| format!("save interval setting: {e}"))?;
    conn.execute(
        "
        INSERT INTO app_settings (key, value)
        VALUES ('autoEnabled', ?1)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        ",
        params![auto_enabled_val],
    )
    .map_err(|e| format!("save auto-enabled setting: {e}"))?;
    Ok(())
}

#[tauri::command]
fn clear_message_cache(app: AppHandle) -> Result<(), String> {
    let conn = open_cache_db(&app)?;
    conn.execute("DELETE FROM messages", [])
        .map_err(|e| format!("clear messages: {e}"))?;
    conn.execute("DELETE FROM message_flags", [])
        .map_err(|e| format!("clear flags: {e}"))?;
    conn.execute("DELETE FROM local_read_state", [])
        .map_err(|e| format!("clear read state: {e}"))?;
    Ok(())
}

#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("create app data dir: {e}"))?;
    open::that(data_dir).map_err(|e| format!("open data dir: {e}"))
}

#[tauri::command]
fn get_account_statuses(app: AppHandle) -> Result<Vec<AccountStatus>, String> {
    let accounts = load_accounts(&app)?;
    let conn = open_cache_db(&app)?;
    let mut result = Vec::new();
    for acc in accounts {
        let display_name = account_display_name(&app, &acc.email)?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE account_email = ?1",
                params![&acc.email],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let last_received_at: Option<String> = conn
            .query_row(
                "SELECT MAX(received_at) FROM messages WHERE account_email = ?1",
                params![&acc.email],
                |row| row.get(0),
            )
            .ok();
        result.push(AccountStatus {
            email: acc.email,
            display_name,
            count: count.max(0) as usize,
            last_received_at,
            status: "ok".to_string(),
            error: String::new(),
        });
    }
    Ok(result)
}

fn remove_account_from_file(app: &AppHandle, email: &str) -> Result<(), String> {
    let path = token_file(app)?;
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut lines = Vec::new();
    for line in existing.lines() {
        let raw = line.trim_end();
        if raw.is_empty() || raw.starts_with('#') {
            lines.push(line.to_string());
            continue;
        }
        let parts: Vec<&str> = raw.split("---").collect();
        if parts.len() >= 3 && parts[0] == email {
            continue;
        }
        lines.push(line.to_string());
    }
    fs::write(path, format!("{}\n", lines.join("\n"))).map_err(|e| format!("write token file: {e}"))
}

#[tauri::command]
fn remove_account(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    remove_cache: bool,
) -> Result<(), String> {
    remove_account_from_file(&app, &email)?;
    state
        .token_cache
        .lock()
        .map_err(|_| "token cache lock failed".to_string())?
        .remove(&email);
    if remove_cache {
        let conn = open_cache_db(&app)?;
        conn.execute(
            "DELETE FROM messages WHERE account_email = ?1",
            params![&email],
        )
        .map_err(|e| format!("clear messages: {e}"))?;
        conn.execute(
            "DELETE FROM message_flags WHERE account_email = ?1",
            params![&email],
        )
        .map_err(|e| format!("clear flags: {e}"))?;
        conn.execute(
            "DELETE FROM local_read_state WHERE account_email = ?1",
            params![&email],
        )
        .map_err(|e| format!("clear read state: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn clear_account_cache(app: AppHandle, email: String) -> Result<(), String> {
    let conn = open_cache_db(&app)?;
    conn.execute(
        "DELETE FROM messages WHERE account_email = ?1",
        params![&email],
    )
    .map_err(|e| format!("clear messages: {e}"))?;
    conn.execute(
        "DELETE FROM message_flags WHERE account_email = ?1",
        params![&email],
    )
    .map_err(|e| format!("clear flags: {e}"))?;
    conn.execute(
        "DELETE FROM local_read_state WHERE account_email = ?1",
        params![&email],
    )
    .map_err(|e| format!("clear read state: {e}"))?;
    Ok(())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("clipboard set text: {e}"))
}

#[tauri::command]
fn token_file_location(app: AppHandle) -> Result<String, String> {
    Ok(token_file(&app)?.display().to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            http: Client::new(),
            token_cache: Mutex::new(HashMap::new()),
            auth_sessions: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(target_os = "windows")]
            WindowEvent::Resized(size) if size.width == 0 && size.height == 0 => {
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            list_accounts,
            start_auth,
            exchange_code,
            set_account_display_name,
            fetch_emails,
            get_cached_emails,
            get_all_cached_emails,
            get_flagged_emails,
            set_message_flag,
            set_message_read,
            get_app_settings,
            save_app_settings,
            clear_message_cache,
            open_data_dir,
            get_account_statuses,
            remove_account,
            clear_account_cache,
            start_reauth,
            exchange_reauth_code,
            copy_text,
            token_file_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}
