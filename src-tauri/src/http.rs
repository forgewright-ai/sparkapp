// http -- the one reqwest client, the spark error voice, and the request
// helpers every command goes through. Core functions take an explicit
// url + token so the live example (and tests) can bypass keyring/settings.

use serde::Serialize;
use std::time::Duration;

pub const GENERAL_TIMEOUT: Duration = Duration::from_secs(20);
pub const CHAT_TIMEOUT: Duration = Duration::from_secs(120);

/// {kind, hint} -- the same shape wire.BrainError and the FORGE speak.
/// kind: auth | loading | down | timeout | bad | locked
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ApiError {
    pub kind: String,
    pub hint: String,
}

impl ApiError {
    pub fn new(kind: &str, hint: impl Into<String>) -> Self {
        Self { kind: kind.into(), hint: hint.into() }
    }

    pub fn bad(hint: impl Into<String>) -> Self {
        Self::new("bad", hint)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.hint)
    }
}

impl std::error::Error for ApiError {}

/// The six kinds the contract names; anything else the server invents
/// (e.g. "ref") folds into "bad" so the UI's union always holds.
pub fn normalize_kind(kind: &str) -> &str {
    match kind {
        "auth" | "loading" | "down" | "timeout" | "bad" | "locked" => kind,
        _ => "bad",
    }
}

/// host[:port] of a URL, for runtime hints ("no server at ...").
pub fn host_of(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => {
            let host = u.host_str().unwrap_or("?").to_string();
            match u.port() {
                Some(p) => format!("{host}:{p}"),
                None => host,
            }
        }
        Err(_) => url.to_string(),
    }
}

/// A transport failure (never got a status line) into spark's voice.
pub fn from_transport(e: &reqwest::Error, host: &str, timeout: Duration) -> ApiError {
    if e.is_timeout() {
        ApiError::new("timeout", format!("{host} took longer than {}s -- try again", timeout.as_secs()))
    } else if e.is_connect() {
        ApiError::new("down", format!("no server at {host} -- is the box up?"))
    } else {
        ApiError::bad(format!("request to {host} failed -- {}", lc(e)))
    }
}

/// An HTTP status (with the response body, when read) into spark's voice.
/// 401/503/429 get the fixed hints; anything else prefers the server's
/// own {error: {kind, hint}} body when it sent one.
pub fn from_status(status: u16, body: &[u8], host: &str) -> ApiError {
    match status {
        401 => ApiError::new("auth", "wrong or missing token -- check settings"),
        403 => ApiError::new("auth", "the server refused this request -- check settings"),
        503 => ApiError::new("loading", "the model is still loading -- wait a moment"),
        429 => ApiError::new("locked", "too many wrong tokens -- wait a minute"),
        _ => {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) {
                if let Some(err) = v.get("error") {
                    let kind = err.get("kind").and_then(|k| k.as_str());
                    let hint = err.get("hint").and_then(|h| h.as_str());
                    if let (Some(k), Some(h)) = (kind, hint) {
                        return ApiError::new(normalize_kind(k), h);
                    }
                }
            }
            ApiError::bad(format!("{host} answered http {status} -- unexpected"))
        }
    }
}

/// lowercase a displayable error for a hint (spark hints are lowercase).
pub fn lc(e: impl std::fmt::Display) -> String {
    e.to_string().to_lowercase()
}

/// One request through the shared client. `token` becomes the bearer,
/// `x_spark` adds the header every /api/* POST needs, `body` goes as
/// JSON (Content-Type set by reqwest). Only transport failures error
/// here; the caller reads the status.
pub async fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    token: Option<&str>,
    body: Option<&serde_json::Value>,
    x_spark: bool,
    timeout: Duration,
) -> Result<reqwest::Response, ApiError> {
    let host = host_of(url);
    let mut rb = client.request(method, url).timeout(timeout);
    if let Some(t) = token {
        rb = rb.bearer_auth(t);
    }
    if x_spark {
        rb = rb.header("X-Spark", "1");
    }
    if let Some(b) = body {
        rb = rb.json(b);
    }
    rb.send().await.map_err(|e| from_transport(&e, &host, timeout))
}

/// The response as JSON, or the mapped error for a non-2xx status.
pub async fn ok_json(resp: reqwest::Response) -> Result<serde_json::Value, ApiError> {
    let host = host_of(resp.url().as_str());
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.map_err(|e| from_transport(&e, &host, GENERAL_TIMEOUT))?;
    if !(200..300).contains(&status) {
        return Err(from_status(status, &bytes, &host));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad(format!("{host} returned something that is not json")))
}

/// %-encode one path segment (thread ids travel in the path).
pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_401_is_auth() {
        let e = from_status(401, b"", "box:8081");
        assert_eq!(e.kind, "auth");
        assert_eq!(e.hint, "wrong or missing token -- check settings");
    }

    #[test]
    fn status_503_is_loading() {
        let e = from_status(503, b"", "box:8081");
        assert_eq!(e.kind, "loading");
        assert_eq!(e.hint, "the model is still loading -- wait a moment");
    }

    #[test]
    fn status_429_is_locked() {
        let e = from_status(429, b"", "box:8081");
        assert_eq!(e.kind, "locked");
    }

    #[test]
    fn other_status_prefers_server_body() {
        let body = br#"{"error":{"kind":"bad","hint":"text is empty"}}"#;
        let e = from_status(400, body, "box:8081");
        assert_eq!(e.kind, "bad");
        assert_eq!(e.hint, "text is empty");
    }

    #[test]
    fn unknown_server_kind_folds_to_bad() {
        let body = br#"{"error":{"kind":"ref","hint":"no such file"}}"#;
        let e = from_status(400, body, "box:8081");
        assert_eq!(e.kind, "bad");
        assert_eq!(e.hint, "no such file");
    }

    #[test]
    fn other_status_without_body_is_bad() {
        let e = from_status(500, b"boom", "box:8081");
        assert_eq!(e.kind, "bad");
        assert!(e.hint.contains("http 500"));
    }

    #[test]
    fn host_of_keeps_the_port() {
        assert_eq!(host_of("http://192.0.2.7:8081/api/chat"), "192.0.2.7:8081");
        assert_eq!(host_of("http://box"), "box");
    }

    #[test]
    fn encode_segment_escapes() {
        assert_eq!(encode_segment("2026-09-03-101530"), "2026-09-03-101530");
        assert_eq!(encode_segment("a/b c"), "a%2Fb%20c");
    }

    #[test]
    fn api_error_serializes_flat() {
        let v = serde_json::to_value(ApiError::new("down", "no server at box -- is the box up?")).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "down", "hint": "no server at box -- is the box up?"}));
    }
}
