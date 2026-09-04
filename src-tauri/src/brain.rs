// brain -- which server answers (a FORGE or a raw llama-server), the
// mirror of spark's wire.resolve_brain for one configured URL, cached
// for 60 s in managed state.

use crate::http::{self, ApiError, GENERAL_TIMEOUT};
use crate::{store, AppState};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

pub const CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelEntry {
    pub alias: String,
    pub stem: String,
    pub loaded: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct BrainInfo {
    pub kind: String, // "forge" | "raw"
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roles: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_list: Option<Vec<ModelEntry>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenCheck {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

pub struct CachedBrain {
    pub info: BrainInfo,
    pub at: Instant,
}

// --------------------------------------------------------------- parsing
fn stem_of(s: &str) -> String {
    s.rsplit('/').next().unwrap_or(s).replace(".gguf", "")
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn str_map_of(v: Option<&Value>) -> Option<BTreeMap<String, String>> {
    let obj = v?.as_object()?;
    Some(
        obj.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect(),
    )
}

/// /v1/models entries as (alias, file stem, loaded) rows -- the mirror
/// of wire.models. The router lists one entry per role (id = the alias,
/// status.value loaded|unloaded, the file in status.args after --model);
/// a single server lists its one model (id = the file stem, `spark`
/// among its aliases, loaded). Anything malformed means [] (as in wire,
/// where a KeyError abandons the whole parse).
pub fn parse_models(v: &Value) -> Vec<ModelEntry> {
    let data = match v.get("data").and_then(|d| d.as_array()) {
        Some(d) => d,
        None => return vec![],
    };
    let mut out = vec![];
    for e in data {
        let id = match e.get("id").and_then(|i| i.as_str()) {
            Some(i) => i.to_string(),
            None => return vec![],
        };
        let status = e.get("status").and_then(|s| s.as_object());
        let args: Vec<String> = status
            .and_then(|s| s.get("args"))
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .map(|x| x.as_str().map(|s| s.to_string()).unwrap_or_else(|| x.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let mut stem = args
            .iter()
            .position(|a| a == "--model")
            .filter(|i| i + 1 < args.len())
            .map(|i| stem_of(&args[i + 1]))
            .unwrap_or_default();
        let mut names = vec![id.clone()];
        if let Some(aliases) = e.get("aliases").and_then(|a| a.as_array()) {
            names.extend(aliases.iter().filter_map(|a| a.as_str()).map(|s| s.to_string()));
        }
        let alias = if names.iter().any(|n| n == "spark") {
            "spark".to_string()
        } else if names.iter().any(|n| n == "ember") {
            "ember".to_string()
        } else {
            id.clone()
        };
        if stem.is_empty() {
            let src = names
                .iter()
                .find(|n| *n != "spark" && *n != "ember")
                .map(|s| s.as_str())
                .unwrap_or(&id);
            stem = stem_of(src);
        }
        let loaded = match status {
            Some(st) if !st.is_empty() => match st.get("value") {
                None => true,
                Some(v) => v.as_str() == Some("loaded"),
            },
            _ => true,
        };
        out.push(ModelEntry { alias, stem, loaded });
    }
    out
}

// --------------------------------------------------------------- probing
/// The brain behind one URL, no cache, explicit token -- callable by the
/// live example without keyring or settings.
pub async fn probe_url(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> Result<BrainInfo, ApiError> {
    let host = http::host_of(url);

    // A FORGE answers /api/health without a token, "forge": true.
    let forge = http::request(client, Method::GET, &format!("{url}/api/health"), None, None, false, Some(GENERAL_TIMEOUT)).await;
    if let Ok(resp) = forge {
        if resp.status().is_success() {
            if let Ok(v) = resp.json::<Value>().await {
                if v.get("forge").and_then(|f| f.as_bool()) == Some(true) {
                    return Ok(BrainInfo {
                        kind: "forge".to_string(),
                        url: url.to_string(),
                        name: str_of(v.get("name")),
                        version: str_of(v.get("version")),
                        model: str_of(v.get("model")),
                        upstream: str_of(v.get("upstream")),
                        models: str_map_of(v.get("models")),
                        roles: str_map_of(v.get("roles")),
                        model_list: None,
                    });
                }
            }
        }
        // 404/503/not-a-forge: fall through to the raw probe.
    }

    // A raw llama-server: /health 200 (ok) or 503 (alive, loading).
    let resp = http::request(client, Method::GET, &format!("{url}/health"), None, None, false, Some(GENERAL_TIMEOUT)).await?;
    let status = resp.status().as_u16();
    if status != 200 && status != 503 {
        return Err(ApiError::new("down", format!("no spark server at {host} -- is the box up?")));
    }
    let mut info = BrainInfo {
        kind: "raw".to_string(),
        url: url.to_string(),
        upstream: Some(if status == 200 { "ok" } else { "loading" }.to_string()),
        model_list: Some(vec![]),
        ..Default::default()
    };

    // Its models, with the bearer. 401 is a real answer; anything else
    // that fails just leaves the list empty (as wire.models does).
    let models = http::request(client, Method::GET, &format!("{url}/v1/models"), token, None, false, Some(GENERAL_TIMEOUT)).await;
    if let Ok(resp) = models {
        if resp.status().as_u16() == 401 {
            return Err(http::from_status(401, b"", &host));
        }
        if resp.status().is_success() {
            if let Ok(v) = resp.json::<Value>().await {
                let list = parse_models(&v);
                info.model = list
                    .iter()
                    .find(|m| m.alias == "spark")
                    .or(list.first())
                    .map(|m| m.stem.clone());
                info.model_list = Some(list);
            }
        }
    }
    Ok(info)
}

/// The cached probe every command shares: 60 s TTL, keyed on the URL so
/// a settings change is never answered from the old server's cache.
pub async fn resolve(
    app: &tauri::AppHandle,
    state: &AppState,
    fresh: bool,
) -> Result<BrainInfo, ApiError> {
    let url = store::server_url(app)?;
    if !fresh {
        let cache = state.brain.lock().unwrap();
        if let Some(c) = cache.as_ref() {
            if c.info.url == url && c.at.elapsed() < CACHE_TTL {
                return Ok(c.info.clone());
            }
        }
    }
    let token = store::read_token(app)?;
    let info = probe_url(&state.client, &url, token.as_deref()).await?;
    *state.brain.lock().unwrap() = Some(CachedBrain { info: info.clone(), at: Instant::now() });
    Ok(info)
}

#[tauri::command]
pub async fn probe_brain(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    fresh: bool,
) -> Result<BrainInfo, ApiError> {
    resolve(&app, &state, fresh).await
}

#[tauri::command]
pub async fn check_token(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<TokenCheck, ApiError> {
    let url = store::server_url(&app)?;
    let token = store::read_token(&app)?;
    let host = http::host_of(&url);
    let info = resolve(&app, &state, false).await?;
    let path = if info.kind == "forge" { "/api/me" } else { "/v1/models" }; // /health is tokenless on a raw server
    let resp = http::request(&state.client, Method::GET, &format!("{url}{path}"), token.as_deref(), None, false, Some(GENERAL_TIMEOUT)).await?;
    match resp.status().as_u16() {
        200 => {
            if info.kind == "forge" {
                let v = resp.json::<Value>().await.unwrap_or(Value::Null);
                Ok(TokenCheck { ok: true, name: str_of(v.get("name")), role: str_of(v.get("role")) })
            } else {
                Ok(TokenCheck { ok: true, name: None, role: None })
            }
        }
        401 => Ok(TokenCheck { ok: false, name: None, role: None }),
        s => {
            let bytes = resp.bytes().await.unwrap_or_default();
            Err(http::from_status(s, &bytes, &host))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn router_shape_parses() {
        // The llama-server router: one entry per role, status carries
        // value and the launch args.
        let v = json!({"object": "list", "data": [
            {"id": "spark", "object": "model",
             "status": {"value": "loaded", "args": ["--port", "9000", "--model", "/models/qwen2.5-3b-instruct-q4_k_m.gguf"]}},
            {"id": "ember", "object": "model",
             "status": {"value": "unloaded", "args": ["--model", "/models/llama-3.1-8b-instruct-q4_k_m.gguf"]}}
        ]});
        let rows = parse_models(&v);
        assert_eq!(rows, vec![
            ModelEntry { alias: "spark".into(), stem: "qwen2.5-3b-instruct-q4_k_m".into(), loaded: true },
            ModelEntry { alias: "ember".into(), stem: "llama-3.1-8b-instruct-q4_k_m".into(), loaded: false },
        ]);
    }

    #[test]
    fn single_model_shape_parses() {
        // A single llama-server: id = the file stem, `spark` among the
        // aliases, no status at all (loaded).
        let v = json!({"object": "list", "data": [
            {"id": "qwen2.5-3b-instruct-q4_k_m", "object": "model", "aliases": ["spark", "ember"]}
        ]});
        let rows = parse_models(&v);
        assert_eq!(rows, vec![
            ModelEntry { alias: "spark".into(), stem: "qwen2.5-3b-instruct-q4_k_m".into(), loaded: true },
        ]);
    }

    #[test]
    fn gguf_id_becomes_the_stem() {
        let v = json!({"data": [{"id": "/models/tiny.gguf", "object": "model"}]});
        let rows = parse_models(&v);
        assert_eq!(rows, vec![
            ModelEntry { alias: "/models/tiny.gguf".into(), stem: "tiny".into(), loaded: true },
        ]);
    }

    #[test]
    fn model_flag_last_is_ignored() {
        // "--model" as the very last arg names no file (wire: args[:-1]).
        let v = json!({"data": [
            {"id": "ember", "status": {"value": "loaded", "args": ["--model"]}}
        ]});
        let rows = parse_models(&v);
        assert_eq!(rows[0].stem, "ember");
    }

    #[test]
    fn missing_id_abandons_the_parse() {
        let v = json!({"data": [{"object": "model"}, {"id": "spark"}]});
        assert_eq!(parse_models(&v), vec![]);
    }

    #[test]
    fn not_a_list_is_empty() {
        assert_eq!(parse_models(&json!({"error": "nope"})), vec![]);
        assert_eq!(parse_models(&json!(null)), vec![]);
    }
}
