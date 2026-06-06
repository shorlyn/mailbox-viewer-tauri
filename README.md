# Mailbox Viewer Tauri

Local Outlook/Hotmail mailbox viewer built with Tauri and Rust.

## Run

```bash
npm install
npm run tauri dev
```

Local account tokens are stored in the Tauri app data directory. For migration from the old Python version, the app can import a local `mailbox_tokens.txt`, but that file is intentionally ignored by Git.

## 生成图标
```bash
rm -rf src-tauri/icons
npm run tauri icon /Users/shorlyn/Downloads/mail.png
```
