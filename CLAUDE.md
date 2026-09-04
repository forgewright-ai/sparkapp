# sparkapp — the desktop shell for spark's page

## What
A thin Tauri 2 shell that ships spark's own web page (the FORGE page,
`lib/spark/forge` in github.com/forgewright-ai/spark) as a macOS/Windows
desktop app named **spark**. One page, one client: the browser and the
desktop run the same HTML/CSS/JS; the desktop swaps `fetch` for a Rust
core that holds the token and speaks HTTP.

## Shape
- `page/` — the vendored spark page, committed. Synced from the spark
  repo at the ref pinned in `scripts/spark-page.ref` by
  `scripts/sync-page.sh`, mirroring forgeserve.py's mount: index.html
  and manifest.webmanifest at the root, everything else under
  `page/static/` (the page loads /static/spark.css etc.). Never edited
  by hand; CI (`.github/workflows/page-sync.yml`) fails on drift.
  Bootstrap state: until spark tags a ref carrying the desktop-aware
  page, the CI drift check self-skips — while page/ holds the
  hand-written placeholder, or while the pinned ref's tree lacks
  lib/spark/forge/manifest.webmanifest (page/ then holds a
  worktree sync no tag can match yet). release.sh stays the hard
  stop either way. First real vendoring: tag spark, bump
  scripts/spark-page.ref, run scripts/sync-page.sh, commit page/.
- `src-tauri/src/` — the Rust core. All HTTP lives here (reqwest): the
  server sends no CORS headers and its /api/* POSTs require the X-Spark
  header, so webview fetch can never work — and the webview never sees
  the token.
  - `proxy.rs` — the page's door: forge_get / forge_post / forge_delete /
    forge_sse / forge_events / stop_stream / quit. Hard path allowlist
    (/api/ and /v1/ only, no scheme, no dot-dot, no percent-escapes);
    bearer injected from the keychain; X-Spark on POST/DELETE.
  - `cache.rs` — offline reads: successful GETs of /api/health, /api/theme,
    /api/me, /api/threads, /api/threads/<id> land in
    app_data_dir/cache/<server host>; when the box is down/slow, forge_get
    answers the cached copy with `_cached_at` (epoch seconds) injected —
    only for the configured server's own subdir, and only while a token
    is held.
  - `chat.rs` — the SSE parser everything shares + the raw llama-server
    turn (chat_openai, /v1/chat/completions).
  - `brain.rs` — the probe (FORGE vs raw) + check_token.
  - `store.rs` — server url in app_config_dir; token in the OS keychain
    (keyring service "spark").
  - `http.rs` — the shared client, request helper, and the spark error
    voice ({kind, hint}).
- No bundler, no npm build, no TypeScript. The page is plain files;
  `withGlobalTauri: true` injects `window.__TAURI__.core.invoke` and
  `.Channel` for it. `frontendDist` points straight at `../page`.

## Commands
```
npm run tauri dev                 # desktop dev (serves page/ directly)
npm run tauri build               # macOS bundle
scripts/sync-page.sh              # vendor page/ at the pinned ref
SPARK_REF=worktree SPARK_DIR=../spark scripts/sync-page.sh   # dev loop
scripts/build-production.sh all   # macOS + Windows (xwin cross-compile)
scripts/release.sh                # version bump + GitHub Release
cd src-tauri && cargo test && cargo clippy --no-deps
```

## Server contract (mirror of spark's lib/spark/wire.py)
- Probe: GET /api/health with `forge: true` => FORGE; else GET /health
  200/503 => raw llama-server.
- FORGE traffic: the page drives /api/* through the proxy commands.
  Plain POST/DELETE carry no total timeout, like the browser — a long
  /api/do/propose (cold model) or /api/do/run (a shell step run to
  completion, no server-side cap) waits as long as the server does;
  only the 5 s connect timeout catches a dead box. GETs keep the 20 s
  cap (they feed the offline-cache fallback).
  /api/chat streams via forge_sse (raw SSE pairs forwarded, the page
  parses them exactly as its browser code does; no total timeout — a
  stream lives as long as the server keeps talking, like the browser;
  a clean EOF without a done/error pair gets a synthetic error pair so
  the page's busy state always settles);
  /api/events via forge_events, which returns a stream id like forge_sse
  (stop_stream(id) cancels; the core owns the reconnect like a browser
  EventSource — server closes and transport blips are retried with
  backoff, only cancellation or an auth/locked answer ends the
  subscription; a new subscription replaces the old).
- Raw: chat_openai streams /v1/chat/completions (OpenAI SSE), timings
  harvested from the final chunk.
- Auth: `Authorization: Bearer <token>` on everything; `X-Spark: 1` on
  /api/* POST/DELETE.
- Errors: {kind, hint} — auth/loading/down/timeout/bad/locked, plus
  "role" passed through on a 403 the server marks as a role denial
  (the page's quiet "this needs the admin token", never a logout).
  A 404 hint always carries an "http 404" marker so the page's
  "not available yet" fallbacks fire across the seam. Lowercase
  hints, ` -- ` before the remedy (spark's voice).

## Rules
- The box URL, LAN IPs, tokens: NEVER committed. Config lives in the app
  config dir and the keychain. Pre-commit blocks private IPs and obvious
  secrets.
- page/ is vendored, not authored here. Change the page in the spark
  repo, tag it, bump scripts/spark-page.ref, run scripts/sync-page.sh.
- No new dependencies without justification (crates today: reqwest,
  tokio, tokio-util, keyring; npm: @tauri-apps/cli only).
- CSP stays `default-src 'self'; connect-src ipc: http://ipc.localhost`
  (the connect-src is tauri's own IPC fetch path — without it every
  session falls back to the slower postMessage transport); the page has
  no inline scripts or styles and never talks to the network itself.
