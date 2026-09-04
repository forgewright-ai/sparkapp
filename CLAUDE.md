# sparkchat — Desktop GUI client for spark/FORGE

## What
Light Tauri 2 desktop chat client for a spark box (github.com/forgewright-ai/spark).
Talks to the FORGE (`spark forge`) or a raw llama-server (`spark serve`).
The terminal has `spark chat`; the desktop has sparkchat.

## Stack
- Frontend: vanilla TypeScript + Vite. No framework. No runtime deps beyond @tauri-apps/api.
- Shell: Tauri 2, Rust. ALL HTTP lives in Rust (reqwest) — the server sends no CORS
  headers and its /api/* POSTs require the X-Spark header; webview fetch can never work.
- Token storage: OS keychain (keyring crate). Server URL: JSON in app_config_dir.

## Commands
```
npm run tauri dev        # desktop dev
npm run tauri build      # macOS bundle
scripts/build-production.sh all   # macOS + Windows (xwin cross-compile)
scripts/release.sh       # version bump + GitHub Release
cd src-tauri && cargo check && cargo test
npx tsc --noEmit
```

## Server contract (mirror of spark's lib/spark/wire.py)
- Probe: GET /api/health with `forge: true` => FORGE; else GET /health 200 => raw.
- Chat: FORGE => POST /api/chat (SSE: queued/delta/done/error); raw => POST
  /v1/chat/completions (OpenAI SSE, final chunk carries timings).
- Auth: `Authorization: Bearer <token>` on everything; `X-Spark: 1` on /api/* POSTs.
- Errors: {kind, hint} — auth/loading/down/timeout/bad/locked. Lowercase hints,
  `--` before the remedy (spark's voice).

## Rules
- The box URL, LAN IPs, tokens: NEVER committed. Config lives in the app config dir
  and the keychain. Pre-commit blocks private IPs and obvious secrets.
- No new dependencies without justification (crates today: reqwest, tokio,
  tokio-util, keyring).
- Strict TypeScript; DOM built with createElement, never innerHTML.
- Mirror spark chat UX: answer mark `*`, `* (stopped)` keeps the partial,
  slash verbs /help /new /last /model /q.
