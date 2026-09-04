# Changelog

## unreleased

The one-client reshape: the desktop now ships spark's own page.

- the TypeScript window is gone; page/ vendors the spark repo's FORGE
  page at the ref pinned in scripts/spark-page.ref (scripts/sync-page.sh,
  drift checked in CI)
- new Rust proxy commands (forge_get/post/delete, forge_sse,
  forge_events, stop_stream, quit) with a hard /api/ + /v1/ path
  allowlist -- the page invokes, the core speaks http
- offline reads: allowlisted GETs are cached in the app data dir and
  answered with _cached_at when the box is down or slow
- app renamed spark (product name, window title,
  identifier com.forgewright.spark, keychain service "spark")
- csp tightened to default-src 'self'; no bundler, no npm build --
  withGlobalTauri hands the plain page invoke + Channel

## v0.1.0

The first release. A light desktop chat client for a spark box.

- streaming chat against a FORGE (/api/chat) or a raw llama-server
  (/v1/chat/completions), picked by probing the server
- thread drawer: list, resume, new (FORGE)
- token pasted once, kept in the OS keychain; server url in app config
- stop mid-answer keeps the partial, marked * (stopped)
- slash verbs: /help /new /last /model /q
- tok/s readout (exact from timings on the raw path, estimated on FORGE)
- dependency-free markdown rendering; light and dark themes
- macOS (.dmg, Apple silicon) and Windows (.exe, x64) -- unsigned
