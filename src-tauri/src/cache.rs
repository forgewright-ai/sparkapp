// cache -- offline reads, v1. A successful GET of an allowlisted /api
// path is written to <app_data_dir>/cache/<server host>; when the box is
// down or slow, forge_get answers from that copy with "_cached_at"
// (epoch seconds) injected so the page can say `offline -- showing
// <age>`. One subdir per server host, so pointing settings at another
// box never replays the old box's data as the new one's.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Only reads the page can usefully replay offline are cached.
pub fn cacheable(path: &str) -> bool {
    let p = path.split('?').next().unwrap_or(path);
    matches!(p, "/api/health" | "/api/theme" | "/api/me" | "/api/threads")
        || p.starts_with("/api/threads/")
}

/// Every non-alphanumeric byte becomes '_' -- one safe flat name.
fn slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// The cache subdir for one server: <root>/<host:port slugged>. Keyed by
/// host so caches never cross servers.
pub fn dir_for(root: &Path, base_url: &str) -> PathBuf {
    root.join(slug(&crate::http::host_of(base_url)))
}

/// One flat file per path.
fn file_name(path: &str) -> String {
    let mut out = slug(path);
    out.push_str(".json");
    out
}

fn epoch_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Remember a successful read. Best effort: a full disk or an odd path
/// never breaks the live answer.
pub fn write(dir: &Path, path: &str, v: &Value) {
    if !cacheable(path) {
        return;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let wrapped = json!({ "at": epoch_now(), "v": v });
    if let Ok(bytes) = serde_json::to_vec(&wrapped) {
        let _ = std::fs::write(dir.join(file_name(path)), bytes);
    }
}

/// The cached copy, "_cached_at" injected. None when there is none.
pub fn read(dir: &Path, path: &str) -> Option<Value> {
    let bytes = std::fs::read(dir.join(file_name(path))).ok()?;
    let wrapped: Value = serde_json::from_slice(&bytes).ok()?;
    let at = wrapped.get("at").and_then(|a| a.as_u64()).unwrap_or(0);
    let mut v = wrapped.get("v")?.clone();
    if let Some(obj) = v.as_object_mut() {
        obj.insert("_cached_at".into(), json!(at));
    }
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkchat-cache-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn cacheable_is_the_read_allowlist() {
        for p in [
            "/api/health",
            "/api/theme",
            "/api/me",
            "/api/threads",
            "/api/threads?n=50",
            "/api/threads/2026-09-03-101530",
        ] {
            assert!(cacheable(p), "{p}");
        }
        for p in ["/api/chat", "/api/events", "/v1/models", "/api/threadsx"] {
            assert!(!cacheable(p), "{p}");
        }
    }

    #[test]
    fn round_trip_injects_cached_at() {
        let dir = tmp("round-trip");
        let v = json!({"forge": true, "model": "ember"});
        write(&dir, "/api/health", &v);
        let back = read(&dir, "/api/health").expect("cached copy");
        assert_eq!(back.get("forge"), Some(&json!(true)));
        assert_eq!(back.get("model"), Some(&json!("ember")));
        assert!(back.get("_cached_at").and_then(|a| a.as_u64()).unwrap() > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_for_keys_the_cache_by_host() {
        let root = Path::new("/data/cache");
        let a = dir_for(root, "http://192.0.2.7:8081");
        let b = dir_for(root, "http://box:8081");
        assert_eq!(a, root.join("192_0_2_7_8081"));
        assert_eq!(b, root.join("box_8081"));
        assert_ne!(a, b);
    }

    #[test]
    fn caches_do_not_cross_servers() {
        let root = tmp("two-servers");
        let old = dir_for(&root, "http://192.0.2.7:8081");
        write(&old, "/api/threads", &json!({"threads": ["old"]}));
        let new = dir_for(&root, "http://192.0.2.9:8081");
        assert!(read(&new, "/api/threads").is_none());
        assert!(read(&old, "/api/threads").is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn uncacheable_writes_nothing_and_misses_are_none() {
        let dir = tmp("miss");
        write(&dir, "/api/chat", &json!({"x": 1}));
        assert!(read(&dir, "/api/chat").is_none());
        assert!(read(&dir, "/api/health").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
