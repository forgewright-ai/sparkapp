// sparkchat -- the Rust core. Every HTTP byte flows through here: the
// webview never fetches, never sees the token.

pub mod brain;
pub mod chat;
pub mod http;
pub mod store;

use std::sync::Mutex;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct AppState {
    /// The one shared reqwest client.
    pub client: reqwest::Client,
    /// The brain probe, cached 60 s (brain::CACHE_TTL), keyed on the URL.
    pub brain: Mutex<Option<brain::CachedBrain>>,
    /// The active chat turn's stop token; one turn at a time.
    pub active: Mutex<Option<CancellationToken>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            client: shared_client(),
            brain: Mutex::new(None),
            active: Mutex::new(None),
        }
    }
}

/// The client every request shares: quick to notice a dead box, no
/// overall timeout here (each request sets its own 20 s / 120 s).
pub fn shared_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("reqwest client")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            store::get_settings,
            store::set_settings,
            store::has_token,
            store::set_token,
            store::clear_token,
            brain::probe_brain,
            brain::check_token,
            chat::chat_forge,
            chat::chat_openai,
            chat::stop_chat,
            chat::list_threads,
            chat::get_thread,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
