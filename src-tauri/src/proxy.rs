// proxy -- the page's one door to the box. The webview never fetches;
// it invokes these commands and the core injects the bearer, adds
// X-Spark on writes, and speaks HTTP. A hard path allowlist keeps the
// core from ever being an open proxy for the webview.

use crate::chat::SseParser;
use crate::http::{self, ApiError, GENERAL_TIMEOUT};
use crate::{cache, store, AppState};
use futures_util::StreamExt;
use reqwest::Method;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

/// Only spark's own API may pass: an absolute /api/ or /v1/ path with
/// no scheme, no dot-dot, no whitespace, no percent-escapes (the url
/// crate would decode %2e%2e into dot-dot before the request goes out,
/// and no spark path needs a '%' -- thread ids are letters/digits/-/_).
/// Anything else is "bad".
pub fn check_path(path: &str) -> Result<(), ApiError> {
    let rest = path
        .strip_prefix("/api/")
        .or_else(|| path.strip_prefix("/v1/"));
    let ok = rest.is_some_and(|r| !r.is_empty())
        && !path.contains("..")
        && !path.contains("://")
        && !path.contains('\\')
        && !path.contains('%')
        && !path.chars().any(|c| c.is_ascii_control() || c == ' ');
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad("that path is not spark's api -- /api/ and /v1/ only"))
    }
}

fn creds(app: &tauri::AppHandle) -> Result<(String, Option<String>), ApiError> {
    Ok((store::server_url(app)?, store::read_token(app)?))
}

/// The cache directory for the CONFIGURED server: one subdir per host,
/// so a settings change never answers offline reads with another box's
/// data.
fn cache_dir(app: &tauri::AppHandle, base: &str) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| cache::dir_for(&d.join("cache"), base))
}

/// GET path as JSON, explicit url + token (live example, tests).
pub async fn get_json(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    path: &str,
) -> Result<Value, ApiError> {
    let url = format!("{base}{path}");
    let resp =
        http::request(client, Method::GET, &url, token, None, false, Some(GENERAL_TIMEOUT)).await?;
    http::ok_json(resp).await
}

/// POST/DELETE with X-Spark: JSON out when the server sent any, null
/// when the body is empty. No total timeout, same principle as sse():
/// the browser page sets no cap on a plain POST, so neither does the
/// desktop -- /api/do/propose can straddle a cold-model generation and
/// /api/do/run runs its shell step to completion with no server-side
/// cap, and an abort here would show "timeout" while the step (possibly
/// a danger step) kept running on the box, inviting a double Run. The
/// client's 5 s connect timeout still catches a dead box.
pub async fn send_json(
    client: &reqwest::Client,
    method: Method,
    base: &str,
    token: Option<&str>,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let url = format!("{base}{path}");
    let resp = http::request(client, method, &url, token, body, true, None).await?;
    let host = http::host_of(resp.url().as_str());
    let status = resp.status().as_u16();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| http::from_transport(&e, &host, http::CONNECT_TIMEOUT))?;
    if !(200..300).contains(&status) {
        return Err(http::from_status(status, &bytes, &host));
    }
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad(format!("{host} returned something that is not json")))
}

/// POST an SSE endpoint and hand every raw (event, data) block to emit,
/// exactly as the page's browser stream() reads them. No total timeout:
/// the browser page sets no cap on a streamed answer, so neither does
/// the desktop -- a long generation or a slow verb streams for as long
/// as the server keeps talking (the client's 5 s connect timeout still
/// applies; stop_stream cancels). Trouble -- an HTTP status, a transport
/// failure -- becomes one ("error", {kind, hint}) pair; the FORGE's own
/// error events pass through untouched. A stream that ends without any
/// terminal pair (the server died mid-answer and the socket closed with
/// a clean EOF) gets a synthetic one: the page's host.sse settles only
/// on done/error or an explicit abort, so a silent EOF would otherwise
/// leave chat.busy/run.busy stuck forever on the desktop -- the browser
/// recovers on its own when the reader drains, and so must we.
pub async fn sse(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    path: &str,
    body: Option<&Value>,
    cancel: CancellationToken,
    emit: &mut (dyn FnMut(String, String) + Send),
) {
    let url = format!("{base}{path}");
    let host = http::host_of(&url);
    let resp = match http::request(client, Method::POST, &url, token, body, true, None).await {
        Ok(r) => r,
        Err(e) => return fail(e, emit),
    };
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let bytes = resp.bytes().await.unwrap_or_default();
        return fail(http::from_status(status, &bytes, &host), emit);
    }
    let mut terminal = false;
    {
        let mut track = |event: String, data: String| {
            if event == "done" || event == "error" {
                terminal = true;
            }
            emit(event, data);
        };
        read_sse(resp, &host, cancel.clone(), &mut track).await;
    }
    if !terminal && !cancel.is_cancelled() {
        fail(ApiError::new("down", "the stream ended early -- is the box up?"), emit);
    }
}

fn fail(e: ApiError, emit: &mut (dyn FnMut(String, String) + Send)) {
    emit("error".into(), json!({"kind": e.kind, "hint": e.hint}).to_string());
}

/// The shared read loop: forward raw blocks until EOF, cancel, or a
/// transport error; flush the unterminated tail.
async fn read_sse(
    resp: reqwest::Response,
    host: &str,
    cancel: CancellationToken,
    emit: &mut (dyn FnMut(String, String) + Send),
) {
    let mut parser = SseParser::new();
    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            chunk = stream.next() => match chunk {
                None => break,
                Some(Ok(bytes)) => {
                    for (event, data) in parser.push(&bytes) {
                        emit(event, data);
                    }
                }
                Some(Err(e)) =>
                    return fail(http::from_transport(&e, host, http::CONNECT_TIMEOUT), emit),
            }
        }
    }
    if let Some((event, data)) = parser.finish() {
        emit(event, data);
    }
}

// -------------------------------------------------------------- commands

#[tauri::command]
pub async fn forge_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Value, ApiError> {
    check_path(&path)?;
    let (base, token) = creds(&app)?;
    match get_json(&state.client, &base, token.as_deref(), &path).await {
        Ok(v) => {
            if let Some(dir) = cache_dir(&app, &base) {
                cache::write(&dir, &path, &v);
            }
            Ok(v)
        }
        // Offline fallback: only for this server's own cache, and only
        // while a token is held -- a logged-out user gets no thread
        // content just because the box is unplugged.
        Err(e) if token.is_some() && (e.kind == "down" || e.kind == "timeout") => {
            cache_dir(&app, &base).and_then(|d| cache::read(&d, &path)).ok_or(e)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn forge_post(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    body: Option<Value>,
) -> Result<Value, ApiError> {
    check_path(&path)?;
    let (base, token) = creds(&app)?;
    send_json(&state.client, Method::POST, &base, token.as_deref(), &path, body.as_ref()).await
}

#[tauri::command]
pub async fn forge_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Value, ApiError> {
    check_path(&path)?;
    let (base, token) = creds(&app)?;
    send_json(&state.client, Method::DELETE, &base, token.as_deref(), &path, None).await
}

/// Start a POST SSE stream (the FORGE's /api/chat). Returns the stream
/// id right away; raw {event, data} pairs arrive on the channel, and
/// stop_stream(id) cancels. Errors after this returns arrive on the
/// channel as an "error" pair.
#[tauri::command]
pub async fn forge_sse(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    body: Option<Value>,
    channel: Channel<Value>,
) -> Result<u64, ApiError> {
    check_path(&path)?;
    let (base, token) = creds(&app)?;
    let (id, cancel) = state.register_stream();
    let client = state.client.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut emit = |event: String, data: String| {
            let _ = channel.send(json!({"event": event, "data": data}));
        };
        sse(&client, &base, token.as_deref(), &path, body.as_ref(), cancel, &mut emit).await;
        app2.state::<AppState>().drop_stream(id);
    });
    Ok(id)
}

/// Cancel one live stream (a chat turn or an SSE read) by its id.
#[tauri::command]
pub async fn stop_stream(state: tauri::State<'_, AppState>, id: u64) -> Result<(), ApiError> {
    if let Some(token) = state.streams.lock().unwrap().remove(&id) {
        token.cancel();
    }
    Ok(())
}

/// Subscribe to GET /api/events, the box's long-lived SSE feed. Returns
/// a stream id like forge_sse so the page's shared channel plumbing
/// (ctl.abort -> stop_stream(id)) works unchanged; raw pairs arrive on
/// the channel. The core owns the reconnect, like a browser EventSource:
/// a server close or a transport blip is retried with backoff (1 s
/// doubling to 30 s, reset once connected), so one subscription outlives
/// drops. Only cancellation (stop_stream, or a new subscription
/// replacing this one) or an auth/locked answer ends it -- retrying a
/// bad token would only feed the server's lockout.
#[tauri::command]
pub async fn forge_events(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    channel: Channel<Value>,
) -> Result<u64, ApiError> {
    let (base, token) = creds(&app)?;
    let (id, cancel) = state.register_stream();
    {
        let mut events = state.events.lock().unwrap();
        if let Some(old) = events.take() {
            old.cancel();
        }
        *events = Some(cancel.clone());
    }
    let client = state.client.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut emit = |event: String, data: String| {
            let _ = channel.send(json!({"event": event, "data": data}));
        };
        events_stream(&client, &base, token.as_deref(), cancel, &mut emit).await;
        app2.state::<AppState>().drop_stream(id);
    });
    Ok(id)
}

async fn events_stream(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    cancel: CancellationToken,
    emit: &mut (dyn FnMut(String, String) + Send),
) {
    let url = format!("{base}/api/events");
    let host = http::host_of(&url);
    let mut delay = Duration::from_secs(1);
    loop {
        // One attempt: connect, then read until the server closes or the
        // transport breaks. No overall timeout -- this stream lives as
        // long as the page does (only the 5 s connect timeout applies).
        let mut rb = client.get(&url);
        if let Some(t) = token {
            rb = rb.bearer_auth(t);
        }
        match rb.send().await {
            Err(e) => fail(http::from_transport(&e, &host, http::CONNECT_TIMEOUT), emit),
            Ok(resp) => {
                let status = resp.status().as_u16();
                if (200..300).contains(&status) {
                    delay = Duration::from_secs(1); // connected: backoff resets
                    read_sse(resp, &host, cancel.clone(), emit).await;
                } else {
                    let bytes = resp.bytes().await.unwrap_or_default();
                    let e = http::from_status(status, &bytes, &host);
                    let fatal = e.kind == "auth" || e.kind == "locked";
                    fail(e, emit);
                    if fatal {
                        return; // the page sends the user back to login
                    }
                }
            }
        }
        if cancel.is_cancelled() {
            return;
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

/// Close the app (the page's /q).
#[tauri::command]
pub async fn quit(app: tauri::AppHandle) -> Result<(), ApiError> {
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_spark_paths() {
        for p in [
            "/api/health",
            "/api/me",
            "/api/theme",
            "/api/threads",
            "/api/threads?n=50",
            "/api/threads/2026-09-03-101530",
            "/api/chat",
            "/v1/models",
            "/v1/chat/completions",
        ] {
            assert!(check_path(p).is_ok(), "{p}");
        }
    }

    #[test]
    fn allowlist_rejects_everything_else() {
        for p in [
            "",
            "/",
            "/health",
            "api/health",
            "/api",
            "/api/",
            "/apifoo/x",
            "/v1",
            "/api/../etc/passwd",
            "/api/threads/..",
            "/api/%2e%2e/etc/passwd",
            "/api/%2E%2E/x",
            "/api/.%2e/x",
            "/api/%2e./x",
            "http://evil/api/health",
            "https://evil/v1/models",
            "/api/x?u=http://evil",
            "/api/a b",
            "/api/a\\b",
            "/api/a\nb",
            "/api/a\tb",
        ] {
            assert!(check_path(p).is_err(), "{p:?}");
        }
    }

    #[test]
    fn allowlist_rejection_speaks_spark() {
        let e = check_path("/etc/passwd").unwrap_err();
        assert_eq!(e.kind, "bad");
        assert!(e.hint.contains(" -- "));
    }

    /// A one-shot HTTP server: answers the first request with an SSE
    /// body and closes the socket -- the clean EOF a killed FORGE
    /// leaves behind. Returns the base url.
    fn one_shot_sse(body: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    async fn collect(base: &str) -> Vec<(String, String)> {
        let client = reqwest::Client::new();
        let mut got: Vec<(String, String)> = Vec::new();
        let mut emit = |e: String, d: String| got.push((e, d));
        sse(&client, base, None, "/api/chat", None, CancellationToken::new(), &mut emit).await;
        got
    }

    #[tokio::test]
    async fn sse_eof_without_terminal_emits_a_synthetic_error() {
        let base = one_shot_sse("event: token\ndata: {\"text\":\"hi\"}\n\n");
        let got = collect(&base).await;
        assert_eq!(got[0].0, "token");
        let last = got.last().unwrap();
        assert_eq!(last.0, "error");
        assert!(last.1.contains("ended early"), "{}", last.1);
    }

    #[tokio::test]
    async fn sse_done_gets_no_synthetic_error() {
        let base = one_shot_sse("event: done\ndata: {\"ms\": 5}\n\n");
        let got = collect(&base).await;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "done");
    }
}
