// Настоящий `codex exec` против мок-сервера Responses API: проверяем то, что реально уходит модели
// (наш системный промпт вместо встроенного, история между ходами) и разбор событий. Без
// установленного Codex (переменная CODEX_BIN или `codex` в PATH) тест пропускается.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Arc, Mutex};
use termiinal_lib::codex::{run_turn, CodexConfig, CodexSession};

const SYSTEM_PROMPT: &str = "ТЕСТОВЫЙ СИСТЕМНЫЙ ПРОМПТ\nвторая строка";

fn codex_bin() -> Option<String> {
    let bin = std::env::var("CODEX_BIN").unwrap_or_else(|_| "codex".into());
    let ok = Command::new(&bin)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    ok.then_some(bin)
}

fn sse(text: &str) -> String {
    let item = json!({"type": "message", "role": "assistant", "id": "msg_1",
                      "content": [{"type": "output_text", "text": text}]});
    let ev = |t: &str, d: Value| format!("event: {t}\ndata: {d}\n\n");
    let mut s = ev("response.created", json!({"type": "response.created", "response": {"id": "r1"}}));
    s += &ev("response.output_item.added", json!({"type": "response.output_item.added", "output_index": 0,
        "item": {"type": "message", "role": "assistant", "id": "msg_1", "content": [{"type": "output_text", "text": ""}]}}));
    s += &ev("response.output_text.delta", json!({"type": "response.output_text.delta", "item_id": "msg_1",
        "output_index": 0, "content_index": 0, "delta": text}));
    s += &ev("response.output_item.done", json!({"type": "response.output_item.done", "output_index": 0, "item": item}));
    s += &ev("response.completed", json!({"type": "response.completed", "response": {"id": "r1", "output": [item],
        "usage": {"input_tokens": 1, "input_tokens_details": null, "output_tokens": 1, "output_tokens_details": null, "total_tokens": 2}}}));
    s
}

/// Мок Responses API: на каждый запрос отвечает "Ответ-N" и запоминает тело запроса.
fn mock_server() -> (u16, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen2 = seen.clone();
    std::thread::spawn(move || {
        for (n, conn) in listener.incoming().enumerate() {
            let Ok(mut sock) = conn else { break };
            let seen = seen2.clone();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 8192];
                let (head_end, len) = loop {
                    let Ok(k) = sock.read(&mut tmp) else { return };
                    if k == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..k]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        break (i + 4, len);
                    }
                };
                while buf.len() < head_end + len {
                    let Ok(k) = sock.read(&mut tmp) else { return };
                    if k == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..k]);
                }
                if let Ok(v) = serde_json::from_slice::<Value>(&buf[head_end..buf.len().min(head_end + len)]) {
                    seen.lock().unwrap().push(v);
                }
                let payload = sse(&format!("Ответ-{}", n + 1));
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = sock.write_all(reply.as_bytes());
            });
        }
    });
    (port, seen)
}

fn texts(item: &Value) -> String {
    match item["content"].as_array() {
        Some(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
        None => String::new(),
    }
}

#[test]
fn codex_gets_our_prompt_and_history_through_a_mock_provider() {
    let Some(bin) = codex_bin() else {
        eprintln!("codex не найден (CODEX_BIN / PATH) — тест пропущен");
        return;
    };
    let (port, seen) = mock_server();
    let home = std::env::temp_dir().join(format!("termiinal-codex-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();

    let cfg = CodexConfig {
        bin,
        model: "gpt-6.1-sol".into(),
        system_prompt: SYSTEM_PROMPT.into(),
        extra_args: [
            "-c", "model_provider=mock",
            "-c", "model_providers.mock.name=mock",
            "-c", &format!("model_providers.mock.base_url=http://127.0.0.1:{port}/v1"),
            "-c", "model_providers.mock.env_key=MOCK_KEY",
            "-c", "model_providers.mock.wire_api=responses",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        extra_env: vec![
            ("CODEX_HOME".into(), home.display().to_string()),
            ("MOCK_KEY".into(), "x".into()),
            ("NO_PROXY".into(), "127.0.0.1,localhost".into()),
            ("no_proxy".into(), "127.0.0.1,localhost".into()),
        ],
    };
    let session = CodexSession::new(cfg, &format!("test-{}", std::process::id())).unwrap();

    let turn = |text: &str, first: bool| -> Vec<Value> {
        let mut events = Vec::new();
        let mut history = session.history.lock();
        run_turn(
            &session.cfg, &mut history, text, first, "sid",
            &session.instructions_file(), &session.work_dir(),
            &AtomicBool::new(false), &AtomicU32::new(0),
            &mut |e| events.push(e),
        );
        events
    };

    let ev1 = turn("первый вопрос", true);
    assert_eq!(ev1[0]["subtype"], "init");
    assert_eq!(ev1[0]["model"], "gpt-6.1-sol");
    let result1 = ev1.last().unwrap();
    assert_eq!(result1["type"], "result", "события: {ev1:?}");
    assert_eq!(result1["is_error"], false, "события: {ev1:?}");
    assert_eq!(result1["result"], "Ответ-1");
    assert!(ev1.iter().any(|e| e["event"]["delta"]["text"] == "Ответ-1"));

    let ev2 = turn("второй вопрос", false);
    assert!(ev2.iter().all(|e| e["subtype"] != "init"), "init только на первый ход");
    assert_eq!(ev2.last().unwrap()["result"], "Ответ-2");

    let seen = seen.lock().unwrap();
    assert!(seen.len() >= 2, "запросов к модели: {}", seen.len());
    let input = |req: &Value| req["input"].as_array().cloned().unwrap_or_default();
    let first = input(&seen[0]);

    // Наш промпт — ровно как есть, встроенного промпта Codex нет.
    let dev: Vec<String> = first.iter().filter(|i| i["role"] == "developer").map(texts).collect();
    assert!(dev.iter().any(|t| t == SYSTEM_PROMPT), "developer-сообщения: {dev:?}");
    assert!(dev.iter().all(|t| !t.contains("You are Codex")), "встроенный промпт Codex не заменён");
    assert!(first.iter().any(|i| i["role"] == "user" && texts(i) == "первый вопрос"));

    // На втором ходу в запросе есть история и новое сообщение.
    let second = input(&seen[1]);
    let last_user = second.iter().filter(|i| i["role"] == "user").map(texts).last().unwrap();
    assert!(last_user.contains("[Пользователь]\nпервый вопрос"), "{last_user}");
    assert!(last_user.contains("Ответ-1"), "{last_user}");
    assert!(last_user.ends_with("второй вопрос"), "{last_user}");

    session.shutdown();
    assert!(!session.dir.exists(), "рабочая папка должна удаляться");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn missing_codex_binary_gives_a_clear_error() {
    let cfg = CodexConfig {
        bin: "codex-которого-нет".into(),
        model: "m".into(),
        system_prompt: "p".into(),
        extra_args: vec![],
        extra_env: vec![],
    };
    let session = CodexSession::new(cfg, &format!("missing-{}", std::process::id())).unwrap();
    let mut events = Vec::new();
    let mut history = session.history.lock();
    run_turn(
        &session.cfg, &mut history, "x", true, "sid",
        &session.instructions_file(), &session.work_dir(),
        &AtomicBool::new(false), &AtomicU32::new(0),
        &mut |e| events.push(e),
    );
    drop(history);
    let last = events.last().unwrap();
    assert_eq!(last["is_error"], true);
    assert!(last["result"].as_str().unwrap().contains("Codex не запустился"));
    session.shutdown();
}
