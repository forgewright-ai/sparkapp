# sparkchat

A light desktop chat client for a [spark](https://github.com/forgewright-ai/spark)
box. The terminal has `spark chat`; the desktop has sparkchat.

Point it at your box once -- server url plus the token -- and chat.
It speaks to a FORGE (`spark forge`) for server-side threads, or to a
raw llama-server (`spark serve`) over the OpenAI shape. It probes and
picks by itself.

## What it does

- streaming answers, stop with Esc (the partial stays, marked `* (stopped)`)
- threads: list, resume, start new (FORGE)
- the token lives in the OS keychain, never in a file, never in the page
- slash verbs in the input: `/help /new /last /model /q`
- tok/s readout after each answer
- light and dark, follows the system

## How it is built

Tauri 2. The window is vanilla TypeScript -- no framework, no runtime
dependencies. Every HTTP byte flows through the Rust core (reqwest):
the webview never fetches and never sees the token.

```
npm install
npm run tauri dev            # develop
scripts/build-production.sh  # macos bundle; 'all' adds windows
scripts/release.sh 0.1.0 "summary"
```

Windows builds cross-compile from macOS via xwin -- see
`scripts/build-production.sh` for the prerequisites.

## License

MIT
