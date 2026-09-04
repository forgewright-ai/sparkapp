# sparkapp

<img src="https://raw.githubusercontent.com/forgewright-ai/spark/main/assets/banner.svg" width="400" alt="spark">

The desktop door to a [spark](https://github.com/forgewright-ai/spark)
box. The prompt has `spark chat`, the LAN has the page -- this wraps
that same page as a desktop app named **spark**, for macOS and Windows.

Point it at your box once -- server url plus the token -- and everything
the page does works on the desktop: chat with streamed answers, threads,
checks, the monitor. The token lives in the OS keychain, never in a
file, never in the page.

## How it is built

Tauri 2 around spark's own page. `page/` is the page exactly as the
spark repo ships it, vendored at the ref pinned in
`scripts/spark-page.ref` -- no framework, no bundler, no build step.
Every HTTP byte flows through the Rust core (reqwest): the webview never
fetches and never sees the token. When the box is away, cached reads
answer with an `offline -- showing <age>` note.

```
npm install
npm run tauri dev            # develop
scripts/sync-page.sh         # refresh page/ at the pinned ref
scripts/build-production.sh  # macos bundle; 'all' adds windows
scripts/release.sh 0.1.0 "summary"
```

Windows builds cross-compile from macOS via xwin -- see
`scripts/build-production.sh` for the prerequisites.

## License

MIT
