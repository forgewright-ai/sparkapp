// live -- drive the real box through the core, bypassing keyring and
// settings. Reads SPARKCHAT_TEST_URL and SPARKCHAT_TEST_TOKEN from the
// environment only; never prints the token.
//
//   SPARKCHAT_TEST_URL=http://<box>:<port> \
//   SPARKCHAT_TEST_TOKEN=$(cat ~/.local/state/spark/ember-token) \
//   cargo run --example live

use sparkchat_lib::{brain, chat, shared_client};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    let url = match std::env::var("SPARKCHAT_TEST_URL") {
        Ok(u) => u.trim_end_matches('/').to_string(),
        Err(_) => {
            eprintln!("set SPARKCHAT_TEST_URL (and SPARKCHAT_TEST_TOKEN)");
            std::process::exit(2);
        }
    };
    let token = std::env::var("SPARKCHAT_TEST_TOKEN").ok();
    let client = shared_client();

    // 1. probe
    let info = match brain::probe_url(&client, &url, token.as_deref()).await {
        Ok(i) => i,
        Err(e) => {
            eprintln!("probe failed: {} -- {}", e.kind, e.hint);
            std::process::exit(1);
        }
    };
    println!(
        "probe: kind={} name={} version={} model={} upstream={}",
        info.kind,
        info.name.as_deref().unwrap_or("-"),
        info.version.as_deref().unwrap_or("-"),
        info.model.as_deref().unwrap_or("-"),
        info.upstream.as_deref().unwrap_or("-"),
    );
    if info.kind != "forge" {
        eprintln!("expected a FORGE (forge: true) at {url}");
        std::process::exit(1);
    }

    // 2. threads
    match chat::list_threads_core(&client, &url, token.as_deref(), 5).await {
        Ok(threads) => {
            println!("threads: {}", threads.len());
            for t in &threads {
                println!("  {} turns={} title={:.40}", t.id, t.turns, t.title);
            }
        }
        Err(e) => {
            eprintln!("list_threads failed: {} -- {}", e.kind, e.hint);
            std::process::exit(1);
        }
    }

    // 3. one short chat turn
    let mut answer = String::new();
    let mut events: Vec<String> = vec![];
    let mut emit = |e: chat::ChatEvent| {
        match &e {
            chat::ChatEvent::Queued => events.push("queued".into()),
            chat::ChatEvent::Delta { t } => {
                if events.last().map(|s| s.as_str()) != Some("delta") {
                    events.push("delta".into());
                }
                answer.push_str(t);
            }
            chat::ChatEvent::Done { thread, ms, model, .. } => {
                events.push(format!(
                    "done(thread={} ms={} model={})",
                    thread.as_deref().unwrap_or("-"),
                    ms.unwrap_or(0),
                    model.as_deref().unwrap_or("-"),
                ));
            }
            chat::ChatEvent::Error { kind, hint } => events.push(format!("error({kind}: {hint})")),
        }
    };
    let cancel = CancellationToken::new();
    if let Err(e) = chat::chat_forge_core(
        &client,
        &url,
        token.as_deref(),
        "in one short sentence: what is a forge?",
        None,
        cancel,
        &mut emit,
    )
    .await
    {
        eprintln!("chat_forge failed: {} -- {}", e.kind, e.hint);
        std::process::exit(1);
    }
    println!("chat events: {}", events.join(" -> "));
    let head: String = answer.chars().take(80).collect();
    println!("answer[..80]: {}", head.replace('\n', " "));
    if events.iter().any(|e| e.starts_with("error")) || answer.is_empty() {
        std::process::exit(1);
    }

    // 4. optionally the OpenAI shape too (the FORGE proxies /v1)
    if std::env::var("SPARKCHAT_TEST_OPENAI").is_ok() {
        let mut answer = String::new();
        let mut saw_timings = false;
        let mut emit = |e: chat::ChatEvent| match e {
            chat::ChatEvent::Delta { t } => answer.push_str(&t),
            chat::ChatEvent::Done { timings, .. } => saw_timings = timings.is_some(),
            _ => {}
        };
        let messages = vec![chat::ChatMessage {
            role: "user".into(),
            content: "in one short sentence: what is an ember?".into(),
        }];
        if let Err(e) = chat::chat_openai_core(
            &client,
            &url,
            token.as_deref(),
            &messages,
            CancellationToken::new(),
            &mut emit,
        )
        .await
        {
            eprintln!("chat_openai failed: {} -- {}", e.kind, e.hint);
            std::process::exit(1);
        }
        let head: String = answer.chars().take(80).collect();
        println!("openai timings={} answer[..80]: {}", saw_timings, head.replace('\n', " "));
        if answer.is_empty() {
            std::process::exit(1);
        }
    }
    println!("live ok");
}
