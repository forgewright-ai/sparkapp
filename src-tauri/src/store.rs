// store -- settings on disk, the token in the OS keychain. The token is
// read here at call time and handed to http as a &str; it never crosses
// to the webview (has_token answers bool only).

use crate::http::{lc, ApiError};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub server_url: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, ApiError> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("config.json"))
        .map_err(|e| ApiError::bad(format!("no config dir -- {}", lc(e))))
}

pub fn load_settings(app: &tauri::AppHandle) -> Result<Settings, ApiError> {
    let path = config_path(app)?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::bad("config.json is unreadable -- set the server again in settings")),
        Err(_) => Ok(Settings::default()),
    }
}

/// The configured base URL, trailing slash trimmed. kind "bad" when none.
pub fn server_url(app: &tauri::AppHandle) -> Result<String, ApiError> {
    let s = load_settings(app)?;
    let url = s.server_url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err(ApiError::bad("no server configured -- set one in settings"));
    }
    Ok(url)
}

fn entry_for(url: &str) -> Result<keyring::Entry, ApiError> {
    let host = crate::http::host_of(url);
    keyring::Entry::new("spark", &host)
        .map_err(|e| ApiError::bad(format!("keychain error -- {}", lc(e))))
}

/// The token for the configured server, from the keychain. None when the
/// keychain has no entry.
pub fn read_token(app: &tauri::AppHandle) -> Result<Option<String>, ApiError> {
    let url = server_url(app)?;
    match entry_for(&url)?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(ApiError::bad(format!("keychain error -- {}", lc(e)))),
    }
}

#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> Result<Settings, ApiError> {
    load_settings(&app)
}

#[tauri::command]
pub async fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), ApiError> {
    let path = config_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| ApiError::bad(format!("cannot create the config dir -- {}", lc(e))))?;
    }
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|e| ApiError::bad(format!("cannot encode settings -- {}", lc(e))))?;
    std::fs::write(&path, bytes)
        .map_err(|e| ApiError::bad(format!("cannot write config.json -- {}", lc(e))))
}

#[tauri::command]
pub async fn has_token(app: tauri::AppHandle) -> Result<bool, ApiError> {
    if server_url(&app).is_err() {
        return Ok(false); // no server yet: nothing to have a token for
    }
    Ok(read_token(&app)?.is_some())
}

#[tauri::command]
pub async fn set_token(app: tauri::AppHandle, token: String) -> Result<(), ApiError> {
    let url = server_url(&app)?;
    entry_for(&url)?
        .set_password(&token)
        .map_err(|e| ApiError::bad(format!("keychain error -- {}", lc(e))))
}

#[tauri::command]
pub async fn clear_token(app: tauri::AppHandle) -> Result<(), ApiError> {
    let url = server_url(&app)?;
    // Logout means the machine holds nothing: the offline cache of this
    // server's threads goes with the token (best effort -- a locked file
    // never blocks the logout itself).
    if let Ok(data) = app.path().app_data_dir() {
        let _ = std::fs::remove_dir_all(crate::cache::dir_for(&data.join("cache"), &url));
    }
    match entry_for(&url)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(ApiError::bad(format!("keychain error -- {}", lc(e)))),
    }
}
