// sparkchat -- the Rust core under spark's page. Every HTTP byte flows
// through here: the webview never fetches, never sees the token.

pub mod brain;
pub mod cache;
pub mod chat;
pub mod http;
pub mod proxy;
pub mod store;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub struct AppState {
    /// The one shared reqwest client.
    pub client: reqwest::Client,
    /// The brain probe, cached 60 s (brain::CACHE_TTL), keyed on the URL.
    pub brain: Mutex<Option<brain::CachedBrain>>,
    /// Live streams by id (chat turns, /api/chat SSE); stop_stream(id)
    /// cancels one.
    pub streams: Mutex<HashMap<u64, CancellationToken>>,
    next_stream: AtomicU64,
    /// The one /api/events subscription; a new one replaces the old.
    pub events: Mutex<Option<CancellationToken>>,
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
            streams: Mutex::new(HashMap::new()),
            next_stream: AtomicU64::new(0),
            events: Mutex::new(None),
        }
    }

    /// A fresh stream id + its stop token, registered for stop_stream.
    pub fn register_stream(&self) -> (u64, CancellationToken) {
        let id = self.next_stream.fetch_add(1, Ordering::Relaxed) + 1;
        let token = CancellationToken::new();
        self.streams.lock().unwrap().insert(id, token.clone());
        (id, token)
    }

    /// Forget a finished stream (its token dies with it).
    pub fn drop_stream(&self, id: u64) {
        self.streams.lock().unwrap().remove(&id);
    }
}

/// The client every request shares: quick to notice a dead box, no
/// overall timeout here (plain requests set their own 20 s cap; SSE
/// streams set none, living as long as the server keeps talking).
pub fn shared_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(http::CONNECT_TIMEOUT)
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
            chat::chat_openai,
            proxy::forge_get,
            proxy::forge_post,
            proxy::forge_delete,
            proxy::forge_sse,
            proxy::forge_events,
            proxy::stop_stream,
            proxy::quit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
