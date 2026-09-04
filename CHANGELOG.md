# Changelog

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
