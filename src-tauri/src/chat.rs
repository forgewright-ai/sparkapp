// chat -- the two streamed chat shapes (FORGE /api/chat SSE, raw
// /v1/chat/completions OpenAI SSE), the stop token, and the thread
// reads. Core functions take explicit url + token so the live example
// and tests can drive them without keyring or settings.

use crate::http::{self, ApiError, CHAT_TIMEOUT, GENERAL_TIMEOUT};
use crate::{store, AppState};
use futures_util::StreamExt;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

// ---------------------------------------------------------------- events
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Timings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pp_n: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pp_tps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tg_n: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tg_tps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_n: Option<u64>,
}

/// The channel event, exactly as src/api.ts types it:
/// {type:"queued"} | {type:"delta",t} | {type:"done",thread?,ms?,model?,timings?}
/// | {type:"error",kind,hint}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ChatEvent {
    Queued,
    Delta {
        t: String,
    },
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        thread: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timings: Option<Timings>,
    },
    Error {
        kind: String,
        hint: String,
    },
}

// ------------------------------------------------------------------- sse
/// Byte-chunk SSE splitter: buffers across chunk boundaries (partial
/// lines, split UTF-8 sequences), drops \r, yields (event, data) per
/// blank-line-terminated block -- the same reading spark.js does.
pub struct SseParser {
    buf: Vec<u8>,
}

impl Default for SseParser {
    fn default() -> Self {
        Self::new()
    }
}

impl SseParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<(String, String)> {
        self.buf.extend(chunk.iter().copied().filter(|&b| b != b'\r'));
        let mut out = vec![];
        while let Some(pos) = self.buf.windows(2).position(|w| w == b"\n\n") {
            let block: Vec<u8> = self.buf.drain(..pos + 2).collect();
            if let Some(parsed) = parse_block(&block[..pos]) {
                out.push(parsed);
            }
        }
        out
    }

    /// A final block the stream ended without terminating.
    pub fn finish(&mut self) -> Option<(String, String)> {
        let rest = std::mem::take(&mut self.buf);
        parse_block(&rest)
    }
}

fn parse_block(block: &[u8]) -> Option<(String, String)> {
    let text = String::from_utf8_lossy(block);
    let mut event = "message".to_string();
    let mut data: Vec<&str> = vec![];
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            event = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    if data.is_empty() {
        return None;
    }
    Some((event, data.join("\n")))
}

/// One FORGE SSE block into the channel event, or None for noise.
pub fn forge_event(event: &str, data: &str) -> Option<ChatEvent> {
    match event {
        "queued" => Some(ChatEvent::Queued),
        "delta" => {
            let v: Value = serde_json::from_str(data).ok()?;
            Some(ChatEvent::Delta { t: v.get("t")?.as_str()?.to_string() })
        }
        "done" => {
            let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
            Some(ChatEvent::Done {
                thread: v.get("thread").and_then(|t| t.as_str()).map(String::from),
                ms: v.get("ms").and_then(|m| m.as_f64()).map(|m| m as u64),
                model: v.get("model").and_then(|m| m.as_str()).map(String::from),
                timings: None,
            })
        }
        "error" => {
            let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
            let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("bad");
            let hint = v.get("hint").and_then(|h| h.as_str()).unwrap_or("the server sent a broken error");
            Some(ChatEvent::Error {
                kind: http::normalize_kind(kind).to_string(),
                hint: hint.to_string(),
            })
        }
        _ => None,
    }
}

/// llama-server's per-request throughput, mapped as spark records it.
pub fn timings_of(chunk: &Value) -> Option<Timings> {
    let t = chunk.get("timings")?.as_object()?;
    let round1 = |f: f64| (f * 10.0).round() / 10.0;
    let count = |k: &str| t.get(k).and_then(|v| v.as_f64()).map(|f| f as u64);
    let rate = |k: &str| t.get(k).and_then(|v| v.as_f64()).map(round1);
    let out = Timings {
        pp_n: count("prompt_n"),
        pp_tps: rate("prompt_per_second"),
        tg_n: count("predicted_n"),
        tg_tps: rate("predicted_per_second"),
        cache_n: count("cache_n"),
    };
    if out == Timings::default() {
        return None;
    }
    Some(out)
}

// ------------------------------------------------------------ chat cores
async fn open_stream(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    body: &Value,
    x_spark: bool,
) -> Result<reqwest::Response, ApiError> {
    let host = http::host_of(url);
    let resp = http::request(client, Method::POST, url, token, Some(body), x_spark, CHAT_TIMEOUT).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let bytes = resp.bytes().await.unwrap_or_default();
        return Err(http::from_status(status, &bytes, &host));
    }
    Ok(resp)
}

/// One FORGE turn: POST /api/chat, forward its SSE as channel events.
/// An HTTP error before the stream is Err; mid-stream trouble becomes a
/// channel error event and Ok. A cancel just stops reading.
pub async fn chat_forge_core(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    text: &str,
    thread: Option<&str>,
    cancel: CancellationToken,
    emit: &mut (dyn FnMut(ChatEvent) + Send),
) -> Result<(), ApiError> {
    let mut body = json!({"text": text, "mode": "chat"});
    if let Some(t) = thread {
        body["thread"] = json!(t);
    }
    let endpoint = format!("{url}/api/chat");
    let resp = open_stream(client, &endpoint, token, &body, true).await?;
    let host = http::host_of(url);
    let mut parser = SseParser::new();
    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            chunk = stream.next() => match chunk {
                None => break,
                Some(Ok(bytes)) => {
                    for (event, data) in parser.push(&bytes) {
                        if let Some(e) = forge_event(&event, &data) {
                            emit(e);
                        }
                    }
                }
                Some(Err(e)) => {
                    let err = http::from_transport(&e, &host, CHAT_TIMEOUT);
                    emit(ChatEvent::Error { kind: err.kind, hint: err.hint });
                    return Ok(());
                }
            }
        }
    }
    if let Some((event, data)) = parser.finish() {
        if let Some(e) = forge_event(&event, &data) {
            emit(e);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// One raw-server turn: POST /v1/chat/completions (OpenAI SSE), deltas
/// forwarded, timings harvested from whichever chunk carries them, one
/// final done event.
pub async fn chat_openai_core(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    messages: &[ChatMessage],
    cancel: CancellationToken,
    emit: &mut (dyn FnMut(ChatEvent) + Send),
) -> Result<(), ApiError> {
    let body = json!({
        "messages": messages,
        "max_tokens": 600,
        "temperature": 0.3,
        "stream": true,
        "cache_prompt": true,
        "model": "ember",
    });
    let endpoint = format!("{url}/v1/chat/completions");
    let resp = open_stream(client, &endpoint, token, &body, false).await?;
    let host = http::host_of(url);
    let mut parser = SseParser::new();
    let mut stream = resp.bytes_stream();
    let mut timings: Option<Timings> = None;
    'read: loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            chunk = stream.next() => match chunk {
                None => break 'read,
                Some(Ok(bytes)) => {
                    for (_event, data) in parser.push(&bytes) {
                        if data.trim() == "[DONE]" {
                            break 'read;
                        }
                        let chunk: Value = match serde_json::from_str(&data) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if let Some(t) = timings_of(&chunk) {
                            timings = Some(t);
                        }
                        let delta = chunk
                            .get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("delta"))
                            .and_then(|d| d.get("content"))
                            .and_then(|t| t.as_str())
                            .unwrap_or("");
                        if !delta.is_empty() {
                            emit(ChatEvent::Delta { t: delta.to_string() });
                        }
                    }
                }
                Some(Err(e)) => {
                    let err = http::from_transport(&e, &host, CHAT_TIMEOUT);
                    emit(ChatEvent::Error { kind: err.kind, hint: err.hint });
                    return Ok(());
                }
            }
        }
    }
    emit(ChatEvent::Done { thread: None, ms: None, model: None, timings });
    Ok(())
}

// -------------------------------------------------------------- commands
/// One active turn at a time: a new one cancels the old token first.
fn new_turn(state: &AppState) -> CancellationToken {
    let mut active = state.active.lock().unwrap();
    if let Some(old) = active.take() {
        old.cancel();
    }
    let token = CancellationToken::new();
    *active = Some(token.clone());
    token
}

#[tauri::command]
pub async fn chat_forge(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    text: String,
    thread: Option<String>,
    channel: tauri::ipc::Channel<ChatEvent>,
) -> Result<(), ApiError> {
    let url = store::server_url(&app)?;
    let token = store::read_token(&app)?;
    let cancel = new_turn(&state);
    let mut emit = |e: ChatEvent| {
        let _ = channel.send(e);
    };
    chat_forge_core(&state.client, &url, token.as_deref(), &text, thread.as_deref(), cancel, &mut emit).await
}

#[tauri::command]
pub async fn chat_openai(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    messages: Vec<ChatMessage>,
    channel: tauri::ipc::Channel<ChatEvent>,
) -> Result<(), ApiError> {
    let url = store::server_url(&app)?;
    let token = store::read_token(&app)?;
    let cancel = new_turn(&state);
    let mut emit = |e: ChatEvent| {
        let _ = channel.send(e);
    };
    chat_openai_core(&state.client, &url, token.as_deref(), &messages, cancel, &mut emit).await
}

#[tauri::command]
pub async fn stop_chat(state: tauri::State<'_, AppState>) -> Result<(), ApiError> {
    if let Some(token) = state.active.lock().unwrap().take() {
        token.cancel();
    }
    Ok(())
}

// --------------------------------------------------------------- threads
/// The FORGE writes thread timestamps as "YYYY-MM-DD HH:MM:SS" strings;
/// the contract types ts as a number, so they land as epoch seconds
/// (naive -- the box's local time read as UTC; fine for ordering and
/// day labels). A numeric ts passes through as-is.
fn epoch_of(v: &Value) -> f64 {
    if let Some(n) = v.as_f64() {
        return n;
    }
    let s = match v.as_str() {
        Some(s) => s,
        None => return 0.0,
    };
    let mut it = s.split(&[' ', '-', ':'][..]).filter_map(|p| p.parse::<i64>().ok());
    let (y, mo, d) = match (it.next(), it.next(), it.next()) {
        (Some(y), Some(mo), Some(d)) => (y, mo, d),
        _ => return 0.0,
    };
    let (h, mi, sec) = (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0));
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return 0.0;
    }
    // days-from-civil (Howard Hinnant), no chrono needed
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    (days * 86400 + h * 3600 + mi * 60 + sec) as f64
}

fn de_epoch<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(epoch_of(&v))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMeta {
    pub id: String,
    #[serde(default, deserialize_with = "de_epoch")]
    pub ts: f64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub turns: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessage {
    #[serde(default, deserialize_with = "de_epoch")]
    pub ts: f64,
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Thread {
    pub id: String,
    pub messages: Vec<ThreadMessage>,
}

/// GET /api/threads?n= unwrapped, explicit url + token (live example).
pub async fn list_threads_core(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    n: u32,
) -> Result<Vec<ThreadMeta>, ApiError> {
    let resp = http::request(client, Method::GET, &format!("{url}/api/threads?n={n}"), token, None, false, GENERAL_TIMEOUT).await?;
    let v = http::ok_json(resp).await?;
    let threads = v.get("threads").cloned().unwrap_or_else(|| json!([]));
    serde_json::from_value(threads)
        .map_err(|_| ApiError::bad("the server's thread list did not parse"))
}

#[tauri::command]
pub async fn list_threads(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    n: u32,
) -> Result<Vec<ThreadMeta>, ApiError> {
    let url = store::server_url(&app)?;
    let token = store::read_token(&app)?;
    list_threads_core(&state.client, &url, token.as_deref(), n).await
}

#[tauri::command]
pub async fn get_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Thread, ApiError> {
    let url = store::server_url(&app)?;
    let token = store::read_token(&app)?;
    let endpoint = format!("{url}/api/threads/{}", http::encode_segment(&id));
    let resp = http::request(&state.client, Method::GET, &endpoint, token.as_deref(), None, false, GENERAL_TIMEOUT).await?;
    let v = http::ok_json(resp).await?;
    let messages: Vec<ThreadMessage> = serde_json::from_value(v.get("messages").cloned().unwrap_or_else(|| json!([])))
        .map_err(|_| ApiError::bad("the server's thread did not parse"))?;
    let id = v.get("id").and_then(|i| i.as_str()).unwrap_or(&id).to_string();
    Ok(Thread { id, messages })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed one byte string in pieces; collect every (event, data).
    fn feed(chunks: &[&[u8]]) -> Vec<(String, String)> {
        let mut p = SseParser::new();
        let mut out = vec![];
        for c in chunks {
            out.extend(p.push(c));
        }
        out.extend(p.finish());
        out
    }

    #[test]
    fn blocks_across_awkward_boundaries() {
        // A captured FORGE stream, split mid-line and mid-block.
        let out = feed(&[
            b"event: del",
            b"ta\ndata: {\"t\":\"hi",
            b" there\"}\n",
            b"\nevent: done\ndata: {\"thread\":\"t-1\",\"ms\":420,\"model\":\"llama\"}\n\n",
        ]);
        assert_eq!(out, vec![
            ("delta".into(), "{\"t\":\"hi there\"}".into()),
            ("done".into(), "{\"thread\":\"t-1\",\"ms\":420,\"model\":\"llama\"}".into()),
        ]);
    }

    #[test]
    fn utf8_split_across_chunks() {
        // "é" is 0xC3 0xA9; the chunk boundary lands between the bytes.
        let whole = "event: delta\ndata: {\"t\":\"caf\u{e9}\"}\n\n".as_bytes();
        let cut = whole.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let out = feed(&[&whole[..cut], &whole[cut..]]);
        assert_eq!(out, vec![("delta".into(), "{\"t\":\"caf\u{e9}\"}".into())]);
    }

    #[test]
    fn crlf_and_multiline_data() {
        let out = feed(&[b"event: x\r\ndata: a\r\ndata: b\r\n\r\n"]);
        assert_eq!(out, vec![("x".into(), "a\nb".into())]);
    }

    #[test]
    fn unterminated_final_block_is_flushed() {
        let out = feed(&[b"data: tail"]);
        assert_eq!(out, vec![("message".into(), "tail".into())]);
    }

    #[test]
    fn queued_event_without_event_line_data_only() {
        // event with data {} and no space after the colon
        let out = feed(&[b"event:queued\ndata:{}\n\n"]);
        assert_eq!(out, vec![("queued".into(), "{}".into())]);
    }

    #[test]
    fn forge_events_serialize_like_api_ts() {
        let q = serde_json::to_value(forge_event("queued", "{}").unwrap()).unwrap();
        assert_eq!(q, serde_json::json!({"type": "queued"}));
        let d = serde_json::to_value(forge_event("delta", r#"{"t":"hi"}"#).unwrap()).unwrap();
        assert_eq!(d, serde_json::json!({"type": "delta", "t": "hi"}));
        let done = serde_json::to_value(
            forge_event("done", r#"{"thread":"t-1","ms":9,"model":"m"}"#).unwrap(),
        ).unwrap();
        assert_eq!(done, serde_json::json!({"type": "done", "thread": "t-1", "ms": 9, "model": "m"}));
        let e = serde_json::to_value(forge_event("error", r#"{"kind":"loading","hint":"wait"}"#).unwrap()).unwrap();
        assert_eq!(e, serde_json::json!({"type": "error", "kind": "loading", "hint": "wait"}));
    }

    #[test]
    fn unknown_error_kind_folds_to_bad() {
        let e = forge_event("error", r#"{"kind":"ref","hint":"no such file"}"#).unwrap();
        assert_eq!(e, ChatEvent::Error { kind: "bad".into(), hint: "no such file".into() });
    }

    #[test]
    fn timings_map_and_round() {
        let chunk = serde_json::json!({"timings": {
            "prompt_n": 42, "prompt_per_second": 512.3456,
            "predicted_n": 100, "predicted_per_second": 33.29, "cache_n": 40
        }});
        let t = timings_of(&chunk).unwrap();
        assert_eq!(t, Timings {
            pp_n: Some(42), pp_tps: Some(512.3), tg_n: Some(100),
            tg_tps: Some(33.3), cache_n: Some(40),
        });
        assert!(timings_of(&serde_json::json!({"choices": []})).is_none());
    }

    #[test]
    fn epoch_of_reads_both_shapes() {
        assert_eq!(epoch_of(&serde_json::json!(1725000000)), 1725000000.0);
        // 1970-01-01 00:00:00 is 0; 2026-09-03 10:00:00 is a sane epoch
        assert_eq!(epoch_of(&serde_json::json!("1970-01-01 00:00:00")), 0.0);
        let e = epoch_of(&serde_json::json!("2026-09-03 10:00:00"));
        assert_eq!(e, 1788429600.0);
        assert_eq!(epoch_of(&serde_json::json!("")), 0.0);
    }

    #[test]
    fn thread_meta_parses_string_ts() {
        let rows: Vec<ThreadMeta> = serde_json::from_value(serde_json::json!([
            {"id": "2026-09-03-101530", "ts": "2026-09-03 10:15:30", "title": "hello", "turns": 2},
            {"id": "x", "ts": "", "title": "t", "turns": 1}
        ])).unwrap();
        assert!(rows[0].ts > 1.7e9);
        assert_eq!(rows[1].ts, 0.0);
    }
}
