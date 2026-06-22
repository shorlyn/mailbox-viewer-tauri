const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;

let accounts = [];
let activeIndex = -1;
let selectedMessage = -1;
let currentFilter = 'all';
let autoTimer = null;
let authState = '';
let modalMode = 'account';
let editingAccountIndex = -1;
let toastTimer = null;
let navMode = 'inbox';
let allMailMessages = [];
let flaggedMessages = [];
let allMailSelected = -1;
let appSettings = { cacheLimit: '100', autoInterval: '300000', dataDir: '' };
let accountStatuses = [];
let deleteConfirmEmail = '';
let deleteRemoveCache = false;
let reauthEmail = '';
let autoIntervalValue = '300000';
let isRefreshing = false;
let refreshingAccounts = new Set();
let autoRefreshInFlight = false;
let recentNewMessageKeys = new Set();

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlToText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  doc.querySelectorAll('script, style, link, meta, title').forEach((node) => node.remove());
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function messageBodyText(message) {
  const content = (message.body ? message.body.content : '') || message.bodyPreview || '';
  if (message.body && message.body.contentType === 'html') return htmlToText(content);
  return content;
}

function looksLikeOtpMail(message) {
  if (!message) return false;
  const from = message.from && message.from.emailAddress ? message.from.emailAddress.address : '';
  const text = [
    from,
    message.subject || '',
    message.bodyPreview || ''
  ].join(' ').toLowerCase();
  return /验证码|安全代码|一次性|验证|代码|校验码|security code|verification code|one[-\s]?time|otp|passcode|auth code|verify|accountprotection|security|noreply/.test(text);
}

function findOtp(text) {
  if (!text) return '';
  const codePatterns = [
    /(?:验证码|安全代码|一次性代码|校验码|代码|security code|verification code|one[-\s]?time code|otp|passcode|auth code)[^\d]{0,24}(\d{4,8})/i,
    /(?<!\d)(\d{4,8})(?!\d)/
  ];
  for (const pattern of codePatterns) {
    const match = String(text).match(pattern);
    if (match) return match[1];
  }
  return '';
}

function otpOf(message) {
  if (!message) return '';
  const brief = [message.subject, message.bodyPreview].join(' ');
  const briefCode = findOtp(brief);
  if (briefCode) return briefCode;
  if (!looksLikeOtpMail(message)) return '';
  return findOtp(messageBodyText(message));
}

function shortTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function fullDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function avatarLetter(email) {
  return (email || '?').trim().slice(0, 1).toUpperCase();
}

function avatarClass(i) {
  const colors = ['#2d6bff', '#48b985', '#8b5cf6', '#f5a623', '#ec5f91', '#2aa6b8'];
  return colors[i % colors.length];
}

function messageKey(message) {
  if (!message) return '';
  const from = message.from && message.from.emailAddress ? message.from.emailAddress.address : '';
  return message.id || message.internetMessageId || [from, message.subject, message.receivedDateTime].join('|');
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = 'toast show' + (isError ? ' error' : '');
  toastTimer = setTimeout(() => {
    toast.className = 'toast' + (isError ? ' error' : '');
  }, 1500);
}

async function ensureNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission !== 'default') return false;
  const permission = await Notification.requestPermission();
  return permission === 'granted';
}

function notificationBody(message) {
  const from = message.from && message.from.emailAddress ? message.from.emailAddress.address : '未知发件人';
  const code = otpOf(message);
  if (code) return `${from}\n验证码：${code}`;
  return `${from}\n${message.subject || '(无主题)'}`;
}

async function notifyNewEmails(acc, messages) {
  if (!messages.length || !(await ensureNotificationPermission())) return;
  const first = messages[0];
  const code = otpOf(first);
  const title = messages.length > 1
    ? `${acc.email} 收到 ${messages.length} 封新邮件`
    : (code ? `收到验证码 ${code}` : '收到新邮件');
  const body = messages.length > 1
    ? `${first.subject || '(无主题)'} 等`
    : notificationBody(first);
  new Notification(title, {
    body,
    tag: `mailbox-viewer-${acc.email}`
  });
}

async function loadAccounts() {
  if (!invoke) {
    document.getElementById('accountList').innerHTML = '<div class="empty-state">Tauri API 不可用，请重新构建并启动应用。</div>';
    return;
  }
  document.getElementById('accountList').innerHTML = '<div class="soft-loading"><span class="spinner"></span>加载账号...</div>';
  try {
    const data = await invoke('list_accounts');
    accounts = (data || []).map((acc) => ({
      email: acc.email,
      displayName: acc.display_name || acc.email,
      status: acc.status,
      error: acc.error || '',
      messages: null,
      count: acc.count === undefined ? null : acc.count,
      loadedAt: null,
      fromCache: false
    }));
    if (activeIndex >= accounts.length) activeIndex = -1;
    try {
      appSettings = await invoke('get_app_settings');
      autoIntervalValue = appSettings.autoInterval || '300000';
      renderAutoInterval();
      if (appSettings.autoEnabled === 'true') {
        toggleAuto();
      }
    } catch (_) {}
    renderAccounts();
    renderList();
    renderDetail();
    loadAllCachedAccounts();
  } catch (e) {
    document.getElementById('accountList').innerHTML = '<div class="empty-state">加载失败：' + esc(e) + '</div>';
  }
}

function renderAccounts() {
  const box = document.getElementById('accountList');
  if (!accounts.length) {
    box.innerHTML = '<div class="empty-state">暂无账号。</div>';
    updateCounters();
    return;
  }
  let html = '';
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const cls = 'account-row' + (i === activeIndex ? ' active' : '');
    const count = acc.count === null ? '' : acc.count;
    const displayName = acc.displayName || acc.email;
    const spinning = refreshingAccounts.has(acc.email);
    html += '<div class="' + cls + '">'
      + '<button class="account-select" onclick="selectAccount(' + i + ')">'
      + '<span class="avatar" style="background:' + avatarClass(i) + '">' + esc(avatarLetter(displayName)) + '</span>'
      + '<span class="account-email" title="' + esc(acc.email) + '">' + esc(displayName) + '</span>'
      + (spinning ? '<span class="account-spinner"></span>' : '<span class="account-count">' + esc(count) + '</span>')
      + '</button>'
      + '<button class="account-edit" onclick="editAccountName(event, ' + i + ')" title="编辑显示名">✎</button>'
      + '</div>';
  }
  box.innerHTML = html;
  updateCounters();
}

function selectAccount(i) {
  activeIndex = i;
  selectedMessage = -1;
  renderAccounts();
  if (!accounts[i].messages && !accounts[i].error) {
    loadEmails(i);
  } else {
    renderList();
    renderDetail();
  }
}

function selectNav(mode) {
  navMode = mode;
  document.getElementById('navInbox').classList.toggle('active', mode === 'inbox');
  document.getElementById('navOtp').classList.toggle('active', mode === 'otp');
  document.getElementById('navFlagged').classList.toggle('active', mode === 'flagged');
  document.getElementById('navAllMail').classList.toggle('active', mode === 'allmail');
  document.getElementById('navAccounts').classList.toggle('active', mode === 'accounts');
  document.getElementById('navSettings').classList.toggle('active', mode === 'settings');
  selectedMessage = -1;
  allMailSelected = -1;
  currentFilter = mode === 'otp' ? 'otp' : 'all';
  document.querySelectorAll('.pill').forEach(function (el) { el.classList.remove('active'); });
  document.getElementById(currentFilter === 'otp' ? 'filterOtp' : 'filterAll').classList.add('active');
  if (mode === 'allmail' && !allMailMessages.length) {
    loadAllMail();
  } else if (mode === 'flagged') {
    loadFlaggedMail();
  } else if (mode === 'settings') {
    loadSettings();
  } else if (mode === 'accounts') {
    loadAccountStatuses();
  } else {
    renderList();
    renderDetail();
  }
}

async function loadAllMail() {
  try {
    var data = await invoke('get_all_cached_emails', { top: 100 });
    allMailMessages = data.value || [];
  } catch (_) {
    allMailMessages = [];
  }
  renderList();
  renderDetail();
  updateCounters();
}

async function loadFlaggedMail() {
  try {
    var data = await invoke('get_flagged_emails', { top: 100 });
    flaggedMessages = data.value || [];
  } catch (_) {
    flaggedMessages = [];
  }
  renderList();
  renderDetail();
  updateCounters();
}

async function loadSettings() {
  try {
    appSettings = await invoke('get_app_settings');
    autoIntervalValue = appSettings.autoInterval || '300000';
    renderAutoInterval();
  } catch (_) {}
  renderList();
  renderDetail();
}

async function loadAccountStatuses() {
  try {
    accountStatuses = await invoke('get_account_statuses');
  } catch (_) {
    accountStatuses = [];
  }
  renderList();
  renderDetail();
  updateCounters();
}

function refreshAccount(email) {
  var idx = -1;
  for (var i = 0; i < accounts.length; i++) {
    if (accounts[i].email === email) { idx = i; break; }
  }
  if (idx < 0) return;
  selectNav('inbox');
  selectAccount(idx);
  loadEmails(idx);
}

function deleteAccount(email) {
  deleteConfirmEmail = email;
  deleteRemoveCache = false;
  document.getElementById('modalTitle').textContent = '删除账号';
  document.getElementById('modalMsg').textContent = '确定要删除 ' + email + ' 吗？此操作只删除本地登录 token，不会影响微软账号本身。';
  document.getElementById('codeInput').style.display = 'none';
  document.getElementById('modalResult').innerHTML =
    '<label class="delete-cache-row"><input type="checkbox" id="deleteCacheCheck" onchange="deleteRemoveCache=this.checked"> 同时删除该账号的本地邮件缓存</label>';
  document.getElementById('modalAdd').textContent = '删除';
  document.getElementById('modalAdd').className = 'primary-btn danger-btn';
  document.getElementById('modalAdd').onclick = confirmDeleteAccount;
  document.getElementById('modalAdd').disabled = false;
  document.getElementById('modal').className = 'modal-overlay show';
}

async function confirmDeleteAccount() {
  if (!deleteConfirmEmail) return;
  var btn = document.getElementById('modalAdd');
  btn.disabled = true;
  btn.textContent = '删除中...';
  try {
    await invoke('remove_account', { email: deleteConfirmEmail, removeCache: deleteRemoveCache });
    var removedEmail = deleteConfirmEmail;
    accounts = accounts.filter(function (acc) { return acc.email !== removedEmail; });
    if (deleteRemoveCache) {
      allMailMessages = allMailMessages.filter(function (m) { return m._accountEmail !== removedEmail; });
      flaggedMessages = flaggedMessages.filter(function (m) { return m._accountEmail !== removedEmail; });
    }
    if (activeIndex >= accounts.length) activeIndex = accounts.length - 1;
    accountStatuses = accountStatuses.filter(function (s) { return s.email !== removedEmail; });
    closeModal();
    btn.className = 'primary-btn';
    renderAccounts();
    renderList();
    renderDetail();
    buildAllMailMessages();
    showToast('已删除账号 ' + removedEmail);
  } catch (e) {
    document.getElementById('modalResult').innerHTML = '<span style="color:#d32f2f;">删除失败：' + esc(e) + '</span>';
    btn.disabled = false;
    btn.textContent = '删除';
  }
}

async function reauthAccount(email) {
  reauthEmail = email;
  document.getElementById('modalTitle').textContent = '重新登录账号';
  document.getElementById('modalMsg').textContent = '将为 ' + email + ' 重新登录微软账号。请在浏览器中完成登录。';
  document.getElementById('codeInput').style.display = 'none';
  document.getElementById('codeInput').value = '';
  document.getElementById('modalResult').innerHTML = '';
  document.getElementById('modalAdd').textContent = '登录';
  document.getElementById('modalAdd').className = 'primary-btn';
  document.getElementById('modalAdd').onclick = startReauth;
  document.getElementById('modalAdd').disabled = false;
  document.getElementById('modal').className = 'modal-overlay show';
}

async function startReauth() {
  if (!reauthEmail) return;
  var btn = document.getElementById('modalAdd');
  btn.disabled = true;
  document.getElementById('modalResult').innerHTML = '<span class="spinner"></span>准备登录...';
  try {
    var data = await invoke('start_reauth', { email: reauthEmail });
    authState = data.state;
    document.getElementById('codeInput').style.display = 'block';
    document.getElementById('codeInput').focus();
    document.getElementById('modalResult').innerHTML =
      '<div style="color:#536782;">登录后复制浏览器地址栏里的完整 localhost 地址。</div>'
      + '<div style="color:#8a98ac;margin-top:6px;">预期回调：' + esc(data.redirect_uri) + '</div>';
    btn.textContent = '提交地址';
    btn.onclick = submitReauthCode;
    btn.disabled = false;
  } catch (e) {
    document.getElementById('modalResult').innerHTML = '<span style="color:#d32f2f;">错误：' + esc(e) + '</span>';
    btn.disabled = false;
  }
}

async function submitReauthCode() {
  var code = document.getElementById('codeInput').value.trim();
  if (!authState || !code || !reauthEmail) return;
  var btn = document.getElementById('modalAdd');
  btn.disabled = true;
  document.getElementById('modalResult').innerHTML = '<span class="spinner"></span>验证中...';
  try {
    var data = await invoke('exchange_reauth_code', { stateId: authState, expectedEmail: reauthEmail, codeOrUrl: code });
    document.getElementById('modalResult').innerHTML = '<span style="color:#2e7d32;">已重新登录：<b>' + esc(data.email) + '</b></span>';
    btn.textContent = '完成';
    btn.onclick = function () {
      closeModal();
      loadAccountStatuses();
    };
    btn.disabled = false;
    var idx = accountIndexByEmail(reauthEmail);
    if (idx >= 0) {
      accounts[idx].error = '';
    }
  } catch (e) {
    document.getElementById('modalResult').innerHTML = '<span style="color:#d32f2f;">' + esc(e) + '</span>';
    btn.disabled = false;
    btn.textContent = '重试';
    btn.onclick = startReauth;
  }
}

async function selectAllMailMessage(index) {
  allMailSelected = index;
  var source = navMode === 'flagged' ? flaggedMessages : allMailMessages;
  if (source[index]) {
    var msg = source[index];
    if (!isMessageRead(msg)) {
      var accountEmail = msg._accountEmail || '';
      if (accountEmail) await markMessageRead(accountEmail, messageKey(msg), true);
    }
  }
  renderList();
  renderDetail();
}

function selectedCurrentMessage() {
  if (navMode === 'allmail' || navMode === 'flagged') {
    const source = navMode === 'flagged' ? flaggedMessages : allMailMessages;
    return source[allMailSelected] || null;
  }
  const acc = activeAccount();
  return acc && acc.messages ? acc.messages[selectedMessage] : null;
}

async function loadEmails(i, options = {}) {
  const acc = accounts[i];
  const previousMessages = Array.isArray(acc.messages) ? acc.messages : null;
  const previousKeys = new Set((previousMessages || []).map(messageKey));
  if (!previousMessages && !options.skipCache) {
    await loadCachedEmails(i);
  }
  if (!acc.messages && !options.silent) {
    document.getElementById('messageList').innerHTML = '<div class="soft-loading"><span class="spinner"></span>加载邮件...</div>';
  }
  if (!options.silent) {
    setRefreshing(true);
  }
  refreshingAccounts.add(acc.email);
  renderAccounts();
  try {
    const data = await invoke('fetch_emails', { email: acc.email, top: 100 });
    const nextMessages = data.value || [];
    acc.error = '';
    acc.messages = nextMessages;
    acc.count = acc.messages.length;
    acc.loadedAt = new Date();
    acc.fromCache = false;
    if (options.notify && previousMessages) {
      const freshMessages = nextMessages.filter((message) => !previousKeys.has(messageKey(message)));
      if (freshMessages.length > 0) {
        notifyNewEmails(acc, freshMessages).catch(() => {});
        showToast(acc.email + ' 收到 ' + freshMessages.length + ' 封新邮件');
        for (const msg of freshMessages) {
          recentNewMessageKeys.add(acc.email + ':' + messageKey(msg));
        }
        setTimeout(function () {
          for (const msg of freshMessages) {
            recentNewMessageKeys.delete(acc.email + ':' + messageKey(msg));
          }
          renderList();
        }, 1600);
      }
    }
    if (!options.silent || !previousMessages) {
      selectedMessage = acc.messages.length ? 0 : -1;
    }
  } catch (e) {
    var errStr = String(e);
    console.error('[fetch_emails error]', acc.email, errStr);
    acc.error = errStr;
    if (!Array.isArray(acc.messages) || !acc.messages.length) {
      acc.messages = [];
      acc.count = 0;
    }
    if (!options.silent) {
      selectedMessage = acc.messages.length ? 0 : -1;
    }
    if (needsReauth(errStr)) {
      showToast('账号需要重新登录', true);
    }
  }
  refreshingAccounts.delete(acc.email);
  if (!options.silent) {
    setRefreshing(false);
    lastRefreshTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    updateRefreshUI();
  }
  renderAccounts();
  if (!options.silent) {
    renderList();
    renderDetail();
  }
}

async function loadCachedEmails(i) {
  const acc = accounts[i];
  try {
    const data = await invoke('get_cached_emails', { email: acc.email, top: 100 });
    const cached = data.value || [];
    if (!cached.length) return;
    acc.messages = cached;
    acc.count = cached.length;
    acc.loadedAt = null;
    acc.fromCache = true;
    selectedMessage = cached.length ? 0 : -1;
    renderAccounts();
    renderList();
    renderDetail();
  } catch (_) {
    // Cache is only an accelerator; network loading below remains the source of truth.
  }
}

async function loadAllCachedAccounts() {
  await Promise.all(accounts.map(async (acc) => {
    try {
      const data = await invoke('get_cached_emails', { email: acc.email, top: 100 });
      const cached = data.value || [];
      if (!cached.length) return;
      acc.messages = cached;
      acc.count = cached.length;
      acc.loadedAt = null;
      acc.fromCache = true;
    } catch (_) {}
  }));
  buildAllMailMessages();
  renderAccounts();
  renderList();
  renderDetail();
}

function buildAllMailMessages() {
  var merged = [];
  for (var i = 0; i < accounts.length; i++) {
    var acc = accounts[i];
    if (!acc.messages) continue;
    for (var j = 0; j < acc.messages.length; j++) {
      var msg = Object.assign({}, acc.messages[j]);
      msg._accountEmail = acc.email;
      msg._accountDisplayName = acc.displayName || acc.email;
      merged.push(msg);
    }
  }
  merged.sort(function (a, b) {
    return (b.receivedDateTime || '').localeCompare(a.receivedDateTime || '');
  });
  allMailMessages = merged;
  flaggedMessages = merged.filter(function (message) { return !!message._flagged; });
  updateCounters();
}

function activeAccount() {
  return activeIndex >= 0 ? accounts[activeIndex] : null;
}

function accountIndexByEmail(email) {
  for (var i = 0; i < accounts.length; i++) {
    if (accounts[i].email === email) return i;
  }
  return -1;
}

function needsReauth(error) {
  return typeof error === 'string' && error.indexOf('NEED_RELOGIN') >= 0;
}

function isMessageRead(message) {
  if (message._localRead !== undefined) return !!message._localRead;
  if (message._graphRead !== undefined && message._graphRead !== null) return !!message._graphRead;
  if (message.isRead !== undefined) return !!message.isRead;
  return false;
}

function applyReadState(accountEmail, id, isRead) {
  for (const acc of accounts) {
    if (acc.email !== accountEmail || !acc.messages) continue;
    for (const message of acc.messages) {
      if (messageKey(message) === id) {
        message._localRead = isRead;
      }
    }
  }
  for (const message of allMailMessages) {
    if ((message._accountEmail || accountEmail) === accountEmail && messageKey(message) === id) {
      message._localRead = isRead;
    }
  }
  for (const message of flaggedMessages) {
    if ((message._accountEmail || accountEmail) === accountEmail && messageKey(message) === id) {
      message._localRead = isRead;
    }
  }
}

async function markMessageRead(accountEmail, messageId, isRead) {
  try {
    await invoke('set_message_read', { accountEmail, messageId, isRead });
    applyReadState(accountEmail, messageId, isRead);
  } catch (_) {}
}

function markSelectedAsRead() {
  const message = selectedCurrentMessage();
  if (!message || isMessageRead(message)) return;
  const accountEmail = message._accountEmail || (activeAccount() ? activeAccount().email : '');
  const id = messageKey(message);
  if (!accountEmail || !id) return;
  markMessageRead(accountEmail, id, true);
}

async function toggleReadForSelected() {
  const message = selectedCurrentMessage();
  if (!message) return;
  const accountEmail = message._accountEmail || (activeAccount() ? activeAccount().email : '');
  const id = messageKey(message);
  if (!accountEmail || !id) return;
  const next = !isMessageRead(message);
  await markMessageRead(accountEmail, id, next);
  showToast(next ? '已标为已读' : '已标为未读');
  renderList();
  renderDetail();
  updateCounters();
}

async function markVisibleAsRead() {
  const items = visibleMessages();
  const unread = items.filter(function (item) { return !isMessageRead(item.message); });
  if (!unread.length) {
    showToast('没有未读邮件');
    return;
  }
  for (const item of unread) {
    var email = item.message._accountEmail || '';
    var id = messageKey(item.message);
    if (email && id) {
      item.message._localRead = true;
      try { await invoke('set_message_read', { accountEmail: email, messageId: id, isRead: true }); } catch (_) {}
    }
  }
  showToast('已将 ' + unread.length + ' 封邮件标为已读');
  renderList();
  renderDetail();
  updateCounters();
}

function setAutoInterval(value) {
  autoIntervalValue = value;
  document.querySelectorAll('.interval-segment button').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.interval === value);
  });
  if (appSettings.autoEnabled === 'true') {
    toggleAuto();
  }
}

function renderAutoInterval() {
  document.querySelectorAll('.interval-segment button').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.interval === autoIntervalValue);
  });
}

function updateRefreshUI() {
  var icon = document.getElementById('refreshIcon');
  var btn = document.getElementById('refreshBtn');
  if (icon) {
    if (isRefreshing) {
      icon.classList.add('spinning');
      btn.disabled = true;
    } else {
      icon.classList.remove('spinning');
      btn.disabled = (activeIndex < 0 && navMode !== 'allmail');
    }
  }
  var status = document.getElementById('autoStatus');
  if (status) {
    if (isRefreshing) {
      status.textContent = '正在刷新...';
    } else if (lastRefreshTime) {
      status.textContent = '刚刚刷新 ' + lastRefreshTime;
    }
  }
}

var lastRefreshTime = '';

function setRefreshing(val) {
  isRefreshing = val;
  updateRefreshUI();
}

function isNewMail(message) {
  var email = message._accountEmail || '';
  return email && recentNewMessageKeys.has(email + ':' + messageKey(message));
}

function visibleMessages() {
  if (navMode === 'allmail' || navMode === 'flagged') {
    var source = navMode === 'flagged' ? flaggedMessages : allMailMessages;
    var q = document.getElementById('searchInput').value.trim().toLowerCase();
    return source
      .map(function (message, index) { return { message: message, index: index }; })
      .filter(function (item) {
        if (currentFilter === 'otp' && !otpOf(item.message)) return false;
        if (currentFilter === 'flag' && !item.message._flagged) return false;
        if (currentFilter === 'unread' && isMessageRead(item.message)) return false;
        if (q) {
          var from = (item.message.from && item.message.from.emailAddress ? item.message.from.emailAddress.address : '').toLowerCase();
          var subject = (item.message.subject || '').toLowerCase();
          var preview = (item.message.bodyPreview || '').toLowerCase();
          var account = (item.message._accountDisplayName || item.message._accountEmail || '').toLowerCase();
          if (!(from + ' ' + subject + ' ' + preview + ' ' + otpOf(item.message) + ' ' + account).includes(q)) return false;
        }
        return true;
      });
  }
  const acc = activeAccount();
  if (!acc || !acc.messages) return [];
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  return acc.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => {
      if (currentFilter === 'otp' && !otpOf(message)) return false;
      if (currentFilter === 'flag' && !message._flagged) return false;
      if (currentFilter === 'unread' && isMessageRead(message)) return false;
      if (query) {
        const from = (message.from && message.from.emailAddress ? message.from.emailAddress.address : '').toLowerCase();
        const subject = (message.subject || '').toLowerCase();
        const preview = (message.bodyPreview || '').toLowerCase();
        if (!(from + ' ' + subject + ' ' + preview + ' ' + otpOf(message)).includes(query)) return false;
      }
      return true;
    });
}

function setFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('.pill').forEach((el) => el.classList.remove('active'));
  const map = { all: 'filterAll', otp: 'filterOtp', flag: 'filterFlag', unread: 'filterUnread' };
  if (map[filter]) document.getElementById(map[filter]).classList.add('active');
  renderList();
}

function renderList() {
  const list = document.getElementById('messageList');
  const meta = document.getElementById('listMeta');
  const refresh = document.getElementById('refreshBtn');

  if (navMode === 'settings') {
    refresh.disabled = true;
    meta.textContent = '设置';
    var autoChecked = appSettings.autoEnabled === 'true';
    list.innerHTML = '<div class="settings-panel">'
      + '<div class="settings-section">'
      + '<div class="settings-section-title">自动刷新</div>'
      + '<label class="auto-row settings-auto-row">启用自动刷新<input id="settingAutoEnabled" type="checkbox"' + (autoChecked ? ' checked' : '') + ' onchange="toggleSettingAuto()"><span></span></label>'
      + '<div class="settings-label">刷新间隔</div>'
      + '<div class="interval-segment" id="settingIntervalSegment">'
      + '<button data-interval="180000" onclick="setAutoInterval(\'180000\')">3 分钟</button>'
      + '<button data-interval="300000" onclick="setAutoInterval(\'300000\')">5 分钟</button>'
      + '<button data-interval="600000" onclick="setAutoInterval(\'600000\')">10 分钟</button>'
      + '</div>'
      + '</div>'
      + '<div class="settings-section">'
      + '<div class="settings-section-title">缓存</div>'
      + '<label><span>每个账号缓存数量</span><select id="settingCacheLimit"><option value="50">50 封</option><option value="100">100 封</option><option value="200">200 封</option></select></label>'
      + '</div>'
      + '<button class="settings-action primary-btn" onclick="saveSettings()">保存设置</button>'
      + '<button class="settings-action toolbar-btn" onclick="openDataDir()">打开数据目录</button>'
      + '<button class="settings-action danger-btn" onclick="clearCache()">清空邮件缓存</button>'
      + '<div class="settings-path">' + esc(appSettings.dataDir || '') + '</div>'
      + '</div>';
    document.getElementById('settingCacheLimit').value = appSettings.cacheLimit || '100';
    renderAutoInterval();
    updateCounters();
    return;
  }

  if (navMode === 'accounts') {
    refresh.disabled = true;
    meta.textContent = '账号管理 · ' + accountStatuses.length + ' 个账号';
    if (!accountStatuses.length) {
      list.innerHTML = '<div class="empty-state">暂无账号，点击右上角"添加账号"开始。</div>';
      updateCounters();
      return;
    }
    let html = '<div class="account-mgmt-list">';
    for (let ai = 0; ai < accountStatuses.length; ai++) {
      const s = accountStatuses[ai];
      var letter = avatarLetter(s.display_name || s.email);
      var color = avatarClass(ai);
      var lastTime = s.last_received_at ? shortTime(s.last_received_at) + ' ' + s.last_received_at.slice(0, 10) : '未刷新';
      var accObj = accounts[accountIndexByEmail(s.email)];
      var accError = accObj ? accObj.error : '';
      var badgeCls = 'ok';
      var statusText = '正常';
      if (needsReauth(accError)) {
        badgeCls = 'bad';
        statusText = '需重登';
      } else if (accError) {
        badgeCls = 'warn';
        statusText = '刷新失败';
      }
      html += '<div class="account-mgmt-card">'
        + '<div class="account-mgmt-avatar" style="background:' + color + '">' + esc(letter) + '</div>'
        + '<div class="account-mgmt-main">'
        + '<div class="account-mgmt-title">' + esc(s.display_name) + '</div>'
        + '<div class="account-mgmt-sub">' + esc(s.email) + '</div>'
        + '<div class="account-mgmt-badges">'
        + '<span class="account-mgmt-badge">' + s.count + ' 封</span>'
        + '<span class="account-mgmt-badge">' + esc(lastTime) + '</span>'
        + '<span class="account-mgmt-badge ' + badgeCls + '">' + statusText + '</span>'
        + '</div>'
        + '</div>'
        + '<div class="account-mgmt-actions">'
        + '<button onclick="editAccountName(event, ' + accountIndexByEmail(s.email) + ')" title="编辑显示名">编辑</button>'
        + '<button onclick="refreshAccount(\'' + esc(s.email) + '\')" title="刷新邮件">刷新</button>'
        + '<button onclick="reauthAccount(\'' + esc(s.email) + '\')" title="重新登录">重登</button>'
        + '<button class="danger-btn" onclick="deleteAccount(\'' + esc(s.email) + '\')" title="删除账号">删除</button>'
        + '</div>'
        + '</div>';
    }
    html += '</div>';
    list.innerHTML = html;
    updateCounters();
    return;
  }

  if (navMode === 'allmail' || navMode === 'flagged') {
    refresh.disabled = true;
    const items = visibleMessages();
    const source = navMode === 'flagged' ? flaggedMessages : allMailMessages;
    meta.textContent = (navMode === 'flagged' ? '已标记' : '全部邮件') + ' · ' + items.length + '/' + source.length + ' 封';
    if (!items.length) {
      list.innerHTML = '<div class="empty-state">' + (source.length ? '没有匹配的邮件。' : (navMode === 'flagged' ? '暂无已标记邮件。' : '暂无缓存邮件，请先刷新账号。')) + '</div>';
      updateCounters();
      return;
    }
    let html = '';
    for (const { message, index } of items) {
      const from = message.from && message.from.emailAddress ? message.from.emailAddress.address : '?';
      const code = otpOf(message);
      const accountName = message._accountDisplayName || message._accountEmail || '';
      const read = isMessageRead(message);
      const newCls = isNewMail(message) ? ' new-mail' : '';
      const cls = 'message-card' + (index === allMailSelected ? ' active' : '') + (read ? '' : ' is-unread') + newCls;
      // 全部邮件/已标记视图：显示账号名标签；OTP 邮件用验证码替代 preview
      const previewText = code ? '验证码：' + code : (message.bodyPreview || '');
      html += '<button class="' + cls + '" onclick="selectAllMailMessage(' + index + ')">'
        + '<span class="unread-dot"></span>'
        + '<span class="message-main">'
        + '<span class="sender">' + esc(from) + '</span>'
        + '<span class="subject">' + esc(message.subject || '(无主题)') + '</span>'
        + '<span class="preview">' + esc(previewText) + '</span>'
        + (accountName ? '<span class="tag-account">' + esc(accountName) + '</span>' : '')
        + '</span>'
        + '<span class="message-side">'
        + '<span class="message-time">' + esc(shortTime(message.receivedDateTime)) + '</span>'
        + '</span>'
        + (code ? '<span class="otp-mini" title="复制验证码" onclick="copyOtp(event, \'' + esc(code) + '\')">' + esc(code) + '</span>' : '')
        + '</button>';
    }
    list.innerHTML = html;
    updateCounters();
    return;
  }

  const acc = activeAccount();

  if (!acc) {
    meta.textContent = '选择一个账号开始加载邮件';
    list.innerHTML = '<div class="empty-state">从左侧选择一个邮箱。</div>';
    refresh.disabled = true;
    updateCounters();
    return;
  }

  refresh.disabled = false;

  if (acc.error && !acc.messages) {
    meta.textContent = acc.displayName || acc.email;
    list.innerHTML = '<div class="empty-state">账号错误：' + esc(acc.error) + '</div>';
    updateCounters();
    return;
  }
  if (!acc.messages) {
    meta.textContent = acc.displayName || acc.email;
    list.innerHTML = '<div class="empty-state">点击刷新加载这个邮箱。</div>';
    updateCounters();
    return;
  }

  const items = visibleMessages();
  const loaded = acc.loadedAt
    ? '，' + acc.loadedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : (acc.fromCache ? '，本地缓存' : '');
  const errorBanner = acc.error ? ' ⚠ 刷新失败：' + acc.error : '';
  meta.textContent = `${acc.displayName || acc.email} · ${items.length}/${acc.count} 封${loaded}${errorBanner}`;
  if (!items.length) {
    list.innerHTML = '<div class="empty-state">没有匹配的邮件。</div>';
    updateCounters();
    return;
  }

  let html = '';
  for (const { message, index } of items) {
    const from = message.from && message.from.emailAddress ? message.from.emailAddress.address : '?';
    const to = (message.toRecipients || []).find((item) => item && item.emailAddress);
    const toAddr = to ? to.emailAddress.address : acc.email;
    const code = otpOf(message);
    const read = isMessageRead(message);
    const newCls = isNewMail(message) ? ' new-mail' : '';
    const cls = 'message-card' + (index === selectedMessage ? ' active' : '') + (read ? '' : ' is-unread') + newCls;
    // 单账号视图：不显示收件邮箱标签；OTP 邮件用验证码替代 preview
    const previewText = code ? '验证码：' + code : (message.bodyPreview || '');
    html += '<button class="' + cls + '" onclick="selectMessage(' + index + ')">'
      + '<span class="unread-dot"></span>'
      + '<span class="message-main">'
      + '<span class="sender">' + esc(from) + '</span>'
      + '<span class="subject">' + esc(message.subject || '(无主题)') + '</span>'
      + '<span class="preview">' + esc(previewText) + '</span>'
      + '</span>'
      + '<span class="message-side">'
      + '<span class="message-time">' + esc(shortTime(message.receivedDateTime)) + '</span>'
      + '</span>'
      + (code ? '<span class="otp-mini" title="复制验证码" onclick="copyOtp(event, \'' + esc(code) + '\')">' + esc(code) + '</span>' : '')
      + '</button>';
  }
  list.innerHTML = html;
  updateCounters();
}

function selectMessage(index) {
  selectedMessage = index;
  var acc = activeAccount();
  if (acc && acc.messages && acc.messages[index]) {
    var msg = acc.messages[index];
    if (!isMessageRead(msg)) {
      markMessageRead(acc.email, messageKey(msg), true);
    }
  }
  renderList();
  renderDetail();
}

function renderDetail() {
  const box = document.getElementById('detailContent');
  let message = null;
  if (navMode === 'settings') {
    box.innerHTML = '<div class="empty-detail"><div class="empty-orb">⚙</div><h2>本地设置</h2><p>设置只保存在这台电脑，不会同步到微软账号。</p></div>';
    return;
  }
  if (navMode === 'accounts') {
    box.innerHTML = '<div class="empty-detail"><div class="empty-orb">👤</div><h2>账号管理</h2><p>在这里管理你的 Outlook 账号：编辑显示名、刷新邮件、或删除不再使用的账号。删除账号不会影响微软账号本身。</p></div>';
    return;
  }
  if (navMode === 'allmail' || navMode === 'flagged') {
    const source = navMode === 'flagged' ? flaggedMessages : allMailMessages;
    message = allMailSelected >= 0 && allMailSelected < source.length ? source[allMailSelected] : null;
  } else {
    const acc = activeAccount();
    message = acc && acc.messages ? acc.messages[selectedMessage] : null;
  }
  if (!message) {
    box.innerHTML = '<div class="empty-detail"><div class="empty-orb">✉</div><h2>选择一封邮件</h2><p>邮件正文会在这里显示。</p></div>';
    return;
  }

  const from = message.from && message.from.emailAddress ? message.from.emailAddress.address : '?';
  const fromName = message.from && message.from.emailAddress ? (message.from.emailAddress.name || '') : '';
  const toParts = (message.toRecipients || []).filter((item) => item && item.emailAddress).map((item) => item.emailAddress.address);
  const isHtml = message.body && message.body.contentType === 'html';
  const rawBody = (message.body ? message.body.content : '') || message.bodyPreview || '';

  // 正文区：HTML 邮件用 iframe 沙箱渲染，纯文本美化排版
  const bodyContentHtml = isHtml
    ? '<div class="mail-content">'
      + '<iframe class="mail-iframe" sandbox="allow-same-origin" srcdoc="" frameborder="0"></iframe>'
      + '</div>'
    : '<div class="mail-content">'
      + '<div class="mail-body mail-body-plain">' + esc(messageBodyText(message) || message.bodyPreview || '') + '</div>'
      + '</div>';

  var read = isMessageRead(message);
  const fromLabel = fromName ? esc(fromName) + ' <span class="from-addr">&lt;' + esc(from) + '&gt;</span>' : esc(from);
  box.innerHTML = '<div class="mail-head">'
    + '<div class="mail-head-left">'
    + '<div class="from-line">' + fromLabel + '</div>'
    + '<div class="to-line">收件人：' + esc(toParts.join(', ') || '-') + '</div>'
    + '</div>'
    + '<div class="mail-head-right">'
    + '<div class="detail-date">' + esc(fullDate(message.receivedDateTime)) + '</div>'
    + '<div class="detail-actions">'
    + '<button class="flag-detail-btn' + (read ? '' : ' active') + '" onclick="toggleReadForSelected()" title="' + (read ? '标为未读' : '标为已读') + '">' + (read ? '✉' : '￭') + '</button>'
    + '<button class="flag-detail-btn' + (message._flagged ? ' active' : '') + '" onclick="toggleFlagForSelected()" title="标记邮件">' + (message._flagged ? '★' : '☆') + '</button>'
    + '</div>'
    + '</div>'
    + '</div>'
    + bodyContentHtml;

  // HTML 邮件：将原始 HTML 注入 iframe，并注入统一字体样式
  if (isHtml) {
    const iframe = box.querySelector('.mail-iframe');
    if (iframe) {
      const styledHtml = '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + '<style>'
        + 'body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
        + 'font-size:13px;line-height:1.75;color:#142033;word-break:break-word;background:#fff;}'
        + 'img{max-width:100%;height:auto;border-radius:4px;}'
        + 'a{color:#2d6bff;text-decoration:none;}'
        + 'a:hover{text-decoration:underline;}'
        + 'table{border-collapse:collapse;max-width:100%;}'
        + 'td,th{padding:6px 10px;}'
        + 'hr{border:none;border-top:1px solid #e8edf5;margin:12px 0;}'
        + 'blockquote{margin:10px 0;padding:8px 14px;border-left:3px solid #d0daf0;color:#5a6b82;}'
        + 'pre,code{font-family:ui-monospace,monospace;font-size:12px;background:#f4f7fb;border-radius:4px;padding:2px 5px;}'
        + '</style></head><body>' + rawBody + '</body></html>';
      iframe.srcdoc = styledHtml;
      // 内容加载后自动调整 iframe 高度，撑满邮件正文
      iframe.onload = function () {
        try {
          const h = iframe.contentDocument.body.scrollHeight;
          if (h > 0) iframe.style.height = h + 8 + 'px';
        } catch (_) {}
      };
    }
  }
}

async function copyOtp(event, code) {
  if (event && event.stopPropagation) event.stopPropagation();
  if (event && event.preventDefault) event.preventDefault();
  try {
    if (invoke) {
      await invoke('copy_text', { text: code });
      showToast('已复制验证码');
      return;
    }
    await navigator.clipboard.writeText(code);
    showToast('已复制验证码');
  } catch (_) {
    try {
      const input = document.createElement('textarea');
      input.value = code;
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      input.focus();
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      showToast(copied ? '已复制验证码' : '复制失败', !copied);
    } catch (_) {
      showToast('复制失败', true);
    }
  }
}

function copyOtpFromButton(button) {
  copyOtp(null, button.dataset.code || '');
}

function updateCounters() {
  const all = accounts.reduce((sum, acc) => sum + (acc.count || 0), 0);
  const messages = accounts.flatMap((acc) => acc.messages || []);
  const otp = messages.filter(otpOf).length;
  const flagged = allMailMessages.filter(function (message) { return !!message._flagged; }).length || flaggedMessages.length;
  document.getElementById('navInboxCount').textContent = all || accounts.length;
  document.getElementById('navOtpCount').textContent = otp;
  document.getElementById('navFlaggedCount').textContent = flagged || '';
  document.getElementById('navAllMailCount').textContent = allMailMessages.length || all;
  document.getElementById('navAccountsCount').textContent = accounts.length;
  document.getElementById('otpPillCount').textContent = otp || '';
}

function applyFlagState(accountEmail, id, flagged) {
  for (const acc of accounts) {
    if (acc.email !== accountEmail || !acc.messages) continue;
    for (const message of acc.messages) {
      if (messageKey(message) === id) message._flagged = flagged;
    }
  }
  for (const message of allMailMessages) {
    if ((message._accountEmail || accountEmail) === accountEmail && messageKey(message) === id) {
      message._flagged = flagged;
    }
  }
  flaggedMessages = allMailMessages.filter(function (message) { return !!message._flagged; });
  if (navMode === 'flagged' && !flagged) {
    allMailSelected = -1;
  }
}

async function toggleFlagForSelected() {
  const message = selectedCurrentMessage();
  if (!message) return;
  const acc = activeAccount();
  const accountEmail = message._accountEmail || (acc ? acc.email : '');
  const id = messageKey(message);
  if (!accountEmail || !id) return;
  const next = !message._flagged;
  try {
    await invoke('set_message_flag', {
      accountEmail,
      messageId: id,
      flagged: next
    });
    applyFlagState(accountEmail, id, next);
    showToast(next ? '已标记邮件' : '已取消标记');
    renderAccounts();
    renderList();
    renderDetail();
    updateCounters();
  } catch (e) {
    showToast('标记失败', true);
  }
}

async function saveSettings() {
  const cacheLimit = document.getElementById('settingCacheLimit').value;
  const autoInterval = autoIntervalValue;
  const autoEnabled = appSettings.autoEnabled || 'false';
  try {
    await invoke('save_app_settings', { cacheLimit, autoInterval, autoEnabled });
    appSettings.cacheLimit = cacheLimit;
    appSettings.autoInterval = autoInterval;
    showToast('设置已保存');
  } catch (_) {
    showToast('保存失败', true);
  }
}

async function openDataDir() {
  try {
    await invoke('open_data_dir');
  } catch (_) {
    showToast('打开失败', true);
  }
}

async function clearCache() {
  if (!window.confirm('确定清空本地邮件缓存吗？账号登录信息会保留。')) return;
  try {
    await invoke('clear_message_cache');
    for (const acc of accounts) {
      acc.messages = null;
      acc.count = 0;
      acc.loadedAt = null;
      acc.fromCache = false;
    }
    allMailMessages = [];
    flaggedMessages = [];
    selectedMessage = -1;
    allMailSelected = -1;
    renderAccounts();
    renderList();
    renderDetail();
    updateCounters();
    showToast('缓存已清空');
  } catch (_) {
    showToast('清空失败', true);
  }
}

function refreshCurrent() {
  if (isRefreshing) return;
  if (navMode === 'allmail') {
    setRefreshing(true);
    loadAllMail().then(function () {
      setRefreshing(false);
      lastRefreshTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      updateRefreshUI();
    });
    return;
  }
  if (activeIndex < 0 || !accounts[activeIndex]) return;
  loadEmails(activeIndex);
}

function editAccountName(event, i) {
  if (event && event.stopPropagation) event.stopPropagation();
  const acc = accounts[i];
  if (!acc) return;
  modalMode = 'rename';
  editingAccountIndex = i;
  document.getElementById('modalTitle').textContent = '编辑账号';
  document.getElementById('modalMsg').textContent = '只修改本地显示名，不会改真实邮箱或登录信息。';
  document.getElementById('codeInput').value = acc.displayName || acc.email;
  document.getElementById('codeInput').placeholder = '例如：注册账号 / Kraken / OpenAI';
  document.getElementById('codeInput').style.display = 'block';
  document.getElementById('modalResult').innerHTML = '<div style="color:#8a98ac;">真实邮箱：' + esc(acc.email) + '</div>';
  document.getElementById('modalAdd').disabled = false;
  document.getElementById('modalAdd').textContent = '保存';
  document.getElementById('modalAdd').onclick = saveAccountName;
  document.getElementById('modal').className = 'modal-overlay show';
  document.getElementById('codeInput').focus();
  document.getElementById('codeInput').select();
}

async function saveAccountName() {
  const acc = accounts[editingAccountIndex];
  if (!acc) return;
  const name = document.getElementById('codeInput').value.trim();
  const btn = document.getElementById('modalAdd');
  btn.disabled = true;
  document.getElementById('modalResult').innerHTML = '<span class="spinner"></span>保存中...';
  try {
    const data = await invoke('set_account_display_name', {
      email: acc.email,
      displayName: name
    });
    acc.displayName = data.display_name || acc.email;
    renderAccounts();
    closeModal();
  } catch (e) {
    document.getElementById('modalResult').innerHTML = '<span style="color:#d32f2f;">保存失败：' + esc(e) + '</span>';
    btn.disabled = false;
  }
}

function toggleSettingAuto() {
  var checkbox = document.getElementById('settingAutoEnabled');
  appSettings.autoEnabled = checkbox && checkbox.checked ? 'true' : 'false';
  toggleAuto();
}

async function toggleAuto() {
  const enabled = appSettings.autoEnabled === 'true';
  const interval = Number(autoIntervalValue || 300000);
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  if (enabled) {
    await ensureNotificationPermission();
    autoRefreshAllAccounts();
    autoTimer = setInterval(function () {
      autoRefreshAllAccounts();
    }, interval);
  }
}

async function autoRefreshAllAccounts() {
  if (autoRefreshInFlight) return;
  if (!accounts.length) return;
  autoRefreshInFlight = true;
  setRefreshing(true);
  try {
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].status === 'saved') {
        try {
          await loadEmails(i, { notify: true, silent: true });
        } catch (_) {}
        if (i < accounts.length - 1) {
          await new Promise(function (r) { setTimeout(r, 400 + Math.random() * 400); });
        }
      }
    }
    buildAllMailMessages();
    renderAccounts();
    renderList();
    renderDetail();
    updateCounters();
  } finally {
    autoRefreshInFlight = false;
    setRefreshing(false);
    lastRefreshTime = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    updateRefreshUI();
  }
}

function addAccount() {
  modalMode = 'account';
  editingAccountIndex = -1;
  authState = '';
  document.getElementById('modalTitle').textContent = '添加账号';
  document.getElementById('modalMsg').textContent = '登录打开的浏览器页面，然后把跳转后的 localhost 地址粘贴到这里。';
  document.getElementById('codeInput').value = '';
  document.getElementById('codeInput').placeholder = 'https://localhost/?code=...';
  document.getElementById('codeInput').style.display = 'none';
  document.getElementById('modalResult').innerHTML = '';
  document.getElementById('modalAdd').disabled = false;
  document.getElementById('modalAdd').textContent = '登录';
  document.getElementById('modalAdd').onclick = startAuth;
  document.getElementById('modal').className = 'modal-overlay show';
}

function closeModal() {
  document.getElementById('modal').className = 'modal-overlay';
  document.getElementById('modalAdd').className = 'primary-btn';
}

async function startAuth() {
  const btn = document.getElementById('modalAdd');
  btn.disabled = true;
  document.getElementById('modalResult').innerHTML = '<span class="spinner"></span>准备登录...';
  try {
    const data = await invoke('start_auth');
    authState = data.state;
    document.getElementById('codeInput').style.display = 'block';
    document.getElementById('codeInput').focus();
    document.getElementById('modalResult').innerHTML =
      '<div style="color:#536782;">登录后复制浏览器地址栏里的完整 localhost 地址。</div>'
      + '<div style="color:#8a98ac;margin-top:6px;">预期回调：' + esc(data.redirect_uri) + '</div>';
    btn.textContent = '提交地址';
    btn.onclick = submitCode;
    btn.disabled = false;
  } catch (e) {
    document.getElementById('modalResult').innerHTML = '<span style="color:#d32f2f;">错误：' + esc(e) + '</span>';
    btn.disabled = false;
  }
}

async function submitCode() {
  const code = document.getElementById('codeInput').value.trim();
  if (!authState || !code) return;
  const btn = document.getElementById('modalAdd');
  btn.disabled = true;
  document.getElementById('modalResult').innerHTML = '<span class="spinner"></span>保存账号...';
  try {
    const data = await invoke('exchange_code', { stateId: authState, codeOrUrl: code });
    document.getElementById('modalResult').innerHTML = '<span style="color:#2e7d32;">已添加：<b>' + esc(data.email) + '</b></span>';
    setTimeout(() => {
      closeModal();
      loadAccounts();
    }, 1200);
  } catch (e) {
    document.getElementById('modalResult').innerHTML = '<span style="color:#d32f2f;">错误：' + esc(e) + '</span>';
    btn.disabled = false;
  }
}

Object.assign(window, {
  loadAccounts,
  selectAccount,
  selectMessage,
  selectNav,
  selectAllMailMessage,
  setFilter,
  renderList,
  refreshCurrent,
  refreshAccount,
  toggleAuto,
  toggleSettingAuto,
  toggleFlagForSelected,
  toggleReadForSelected,
  markVisibleAsRead,
  saveSettings,
  openDataDir,
  clearCache,
  editAccountName,
  saveAccountName,
  deleteAccount,
  confirmDeleteAccount,
  reauthAccount,
  submitReauthCode,
  addAccount,
  closeModal,
  startAuth,
  submitCode,
  copyOtp,
  copyOtpFromButton,
  setAutoInterval
});

loadAccounts();
