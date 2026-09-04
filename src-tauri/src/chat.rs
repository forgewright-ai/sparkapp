// chat -- the raw-server chat shape (/v1/chat/completions, OpenAI SSE)
// and the byte-level SSE parser the proxy shares. The FORGE's own chat
// stream now flows raw through proxy::forge_sse; this module keeps the
// typed path a raw llama-server needs. Core functions take explicit
// url + token so the live example and tests can drive them without
// keyring or settings.

use crate::http::{self, ApiError};
use crate::{store, AppState};
use futures_util::StreamExt;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
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

/// The channel event the page's raw mode reads:
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

// ------------------------------------------------------------- chat core
/// Open the SSE POST. No total timeout -- a generation streams for as
/// long as the model keeps talking, exactly like the browser page (the
/// client's 5 s connect timeout still applies; stop_stream cancels).
async fn open_stream(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    body: &Value,
    x_spark: bool,
) -> Result<reqwest::Response, ApiError> {
    let host = http::host_of(url);
    let resp = http::request(client, Method::POST, url, token, Some(body), x_spark, None).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let bytes = resp.bytes().await.unwrap_or_default();
        return Err(http::from_status(status, &bytes, &host));
    }
    Ok(resp)
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
                    let err = http::from_transport(&e, &host, http::CONNECT_TIMEOUT);
                    emit(ChatEvent::Error { kind: err.kind, hint: err.hint });
                    return Ok(());
                }
            }
        }
    }
    emit(ChatEvent::Done { thread: None, ms: None, model: None, timings });
    Ok(())
}

// -------------------------------------------------------------- command
/// One raw-mode turn. Returns the stream id right away (stop_stream(id)
/// cancels); events arrive on the channel, open errors included.
#[tauri::command]
pub async fn chat_openai(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    messages: Vec<ChatMessage>,
    channel: tauri::ipc::Channel<ChatEvent>,
) -> Result<u64, ApiError> {
    let url = store::server_url(&app)?;
    let token = store::read_token(&app)?;
    let (id, cancel) = state.register_stream();
    let client = state.client.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut emit = |e: ChatEvent| {
            let _ = channel.send(e);
        };
        if let Err(e) =
            chat_openai_core(&client, &url, token.as_deref(), &messages, cancel, &mut emit).await
        {
            emit(ChatEvent::Error { kind: e.kind, hint: e.hint });
        }
        app2.state::<AppState>().drop_stream(id);
    });
    Ok(id)
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
    fn chat_events_serialize_like_the_page_reads() {
        let q = serde_json::to_value(ChatEvent::Queued).unwrap();
        assert_eq!(q, serde_json::json!({"type": "queued"}));
        let d = serde_json::to_value(ChatEvent::Delta { t: "hi".into() }).unwrap();
        assert_eq!(d, serde_json::json!({"type": "delta", "t": "hi"}));
        let done = serde_json::to_value(ChatEvent::Done {
            thread: Some("t-1".into()),
            ms: Some(9),
            model: Some("m".into()),
            timings: None,
        })
        .unwrap();
        assert_eq!(done, serde_json::json!({"type": "done", "thread": "t-1", "ms": 9, "model": "m"}));
        let e = serde_json::to_value(ChatEvent::Error { kind: "loading".into(), hint: "wait".into() }).unwrap();
        assert_eq!(e, serde_json::json!({"type": "error", "kind": "loading", "hint": "wait"}));
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
}
