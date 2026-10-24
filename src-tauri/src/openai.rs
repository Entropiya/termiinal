// Адаптер ChatGPT (OpenAI Chat Completions, потоковый SSE) под тот же интерфейс, что и
// Claude CLI в agent.rs: фронтенд не знает разницы — он получает те же события в формате
// stream-json (`system/init`, `stream_event` с text_delta, `result`) и шлёт те же сообщения.
//
// Отличия от Claude-адаптера, осознанные:
// - нет процесса: это HTTPS-запросы, историю диалога держим здесь, в `OpenAiSession`;
// - у модели нет инструментов вообще (мы их просто не передаём в запросе) — изоляция та же;
// - системный промпт — ТОТ ЖЕ файл src/system-prompt.md, первым сообщением `system`;
// - стоимость не считаем (total_cost_usd всегда 0): цен модели в приложении нет.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
/// Сколько последних сообщений истории (без системного) отправляем в запросе.
const MAX_HISTORY_MESSAGES: usize = 80;

#[derive(Clone, Debug)]
pub struct OpenAiConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub system_prompt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, PartialEq)]
pub enum SseItem {
    Delta(String),
    Done,
    Error(String),
    Ignore,
}

/// Разбор одной строки SSE-потока Chat Completions.
pub fn parse_sse_line(line: &str) -> SseItem {
    let Some(data) = line.strip_prefix("data:") else {
        return SseItem::Ignore;
    };
    let data = data.trim();
    if data == "[DONE]" {
        return SseItem::Done;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return SseItem::Ignore;
    };
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("unknown error");
        return SseItem::Error(msg.to_string());
    }
    match v["choices"][0]["delta"]["content"].as_str() {
        Some(t) if !t.is_empty() => SseItem::Delta(t.to_string()),
        _ => SseItem::Ignore,
    }
}

/// Текст пользовательского сообщения из JSON-строки, которую фронтенд шлёт в `agent_send`
/// (формат Claude stream-json: `{"type":"user","message":{"content":[{"type":"text","text":…}]}}`).
pub fn extract_user_text(json_line: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(json_line).map_err(|e| format!("bad json: {e}"))?;
    let content = &v["message"]["content"];
    if let Some(s) = content.as_str() {
        return Ok(s.to_string());
    }
    let parts: Vec<&str> = content
        .as_array()
        .ok_or("message.content is missing")?
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect();
    if parts.is_empty() {
        return Err("no text in message".into());
    }
    Ok(parts.join("\n"))
}

/// Тело запроса: системный промпт первым сообщением, затем (обрезанная) история.
pub fn build_request_body(cfg: &OpenAiConfig, history: &[ChatMessage]) -> Value {
    let start = history.len().saturating_sub(MAX_HISTORY_MESSAGES);
    let mut messages = vec![json!({"role": "system", "content": cfg.system_prompt})];
    messages.extend(history[start..].iter().map(|m| json!({"role": m.role, "content": m.content})));
    json!({"model": cfg.model, "messages": messages, "stream": true})
}

fn init_event(cfg: &OpenAiConfig, session_id: &str) -> Value {
    json!({"type": "system", "subtype": "init", "session_id": session_id,
           "tools": [], "mcp_servers": [], "model": cfg.model})
}

fn delta_event(text: &str) -> Value {
    json!({"type": "stream_event",
           "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}})
}

fn result_event(text: &str, is_error: bool, started: Instant) -> Value {
    json!({"type": "result", "subtype": if is_error { "error" } else { "success" },
           "is_error": is_error, "result": text, "total_cost_usd": 0.0,
           "duration_ms": started.elapsed().as_millis() as u64})
}

/// Один ход диалога. Дописывает историю, шлёт события через `emit`. `first_turn` — послать
/// `system/init` (Claude CLI тоже присылает его только на первое сообщение).
pub fn run_turn(
    cfg: &OpenAiConfig,
    history: &mut Vec<ChatMessage>,
    user_text: &str,
    first_turn: bool,
    session_id: &str,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(Value),
) {
    let started = Instant::now();
    if first_turn {
        emit(init_event(cfg, session_id));
    }
    history.push(ChatMessage { role: "user".into(), content: user_text.into() });

    let fail = |history: &mut Vec<ChatMessage>, emit: &mut dyn FnMut(Value), msg: String| {
        history.pop(); // реплика без ответа не остаётся в истории — повтор отправит её заново
        emit(result_event(&msg, true, started));
    };

    let body = match serde_json::to_vec(&build_request_body(cfg, history)) {
        Ok(b) => b,
        Err(e) => return fail(history, emit, format!("serialize request: {e}")),
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(15)))
        .build()
        .into();
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let mut resp = match agent
        .post(&url)
        .header("Authorization", &format!("Bearer {}", cfg.api_key))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .send(&body[..])
    {
        Ok(r) => r,
        Err(e) => return fail(history, emit, format!("OpenAI: запрос не удался: {e}")),
    };

    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = resp.body_mut().read_to_string().unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or(text);
        return fail(history, emit, format!("OpenAI HTTP {status}: {detail}"));
    }

    let reader = BufReader::new(resp.body_mut().as_reader());
    let mut full = String::new();
    for line in reader.lines() {
        if cancel.load(Ordering::Relaxed) {
            history.pop();
            return;
        }
        let Ok(line) = line else { break };
        match parse_sse_line(&line) {
            SseItem::Delta(t) => {
                full.push_str(&t);
                emit(delta_event(&t));
            }
            SseItem::Done => break,
            SseItem::Error(m) => return fail(history, emit, format!("OpenAI: {m}")),
            SseItem::Ignore => {}
        }
    }
    history.push(ChatMessage { role: "assistant".into(), content: full.clone() });
    emit(result_event(&full, false, started));
}

pub struct OpenAiSession {
    pub cfg: OpenAiConfig,
    pub history: parking_lot::Mutex<Vec<ChatMessage>>,
    pub turned: AtomicBool,
    pub cancel: AtomicBool,
}

impl OpenAiSession {
    pub fn new(cfg: OpenAiConfig) -> Self {
        Self {
            cfg,
            history: parking_lot::Mutex::new(Vec::new()),
            turned: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn cfg(base: &str) -> OpenAiConfig {
        OpenAiConfig {
            api_key: "sk-test".into(),
            base_url: base.into(),
            model: "gpt-test".into(),
            system_prompt: "СИСТЕМНЫЙ ПРОМПТ\nвторая строка".into(),
        }
    }

    #[test]
    fn sse_lines() {
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":"При"}}]}"#), SseItem::Delta("При".into()));
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), SseItem::Ignore);
        assert_eq!(parse_sse_line("data: [DONE]"), SseItem::Done);
        assert_eq!(parse_sse_line(": keep-alive"), SseItem::Ignore);
        assert_eq!(parse_sse_line(""), SseItem::Ignore);
        assert_eq!(parse_sse_line(r#"data: {"error":{"message":"boom"}}"#), SseItem::Error("boom".into()));
    }

    #[test]
    fn user_text_from_claude_style_message() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}"#;
        assert_eq!(extract_user_text(line).unwrap(), "a\nb");
        assert_eq!(extract_user_text(r#"{"message":{"content":"plain"}}"#).unwrap(), "plain");
        assert!(extract_user_text("not json").is_err());
        assert!(extract_user_text(r#"{"message":{"content":[]}}"#).is_err());
    }

    #[test]
    fn request_body_starts_with_exact_system_prompt() {
        let c = cfg("http://x");
        let hist = vec![ChatMessage { role: "user".into(), content: "q".into() }];
        let body = build_request_body(&c, &hist);
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0], json!({"role": "system", "content": c.system_prompt}));
        assert_eq!(body["messages"][1], json!({"role": "user", "content": "q"}));
        assert!(body.get("tools").is_none(), "инструменты передавать нельзя");
    }

    #[test]
    fn history_is_trimmed_but_system_prompt_stays() {
        let c = cfg("http://x");
        let hist: Vec<ChatMessage> = (0..200)
            .map(|i| ChatMessage { role: "user".into(), content: format!("m{i}") })
            .collect();
        let body = build_request_body(&c, &hist);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), MAX_HISTORY_MESSAGES + 1);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["content"], "m120");
        assert_eq!(msgs.last().unwrap()["content"], "m199");
    }

    /// Мини-сервер: на каждое подключение читает запрос целиком, кладёт (заголовки, тело)
    /// в `seen` и отвечает заготовленным ответом.
    fn mock_server(responses: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<(String, Value)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        std::thread::spawn(move || {
            for (status, payload) in responses {
                let (mut sock, _) = listener.accept().unwrap();
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let (head_end, content_len) = loop {
                    let n = sock.read(&mut tmp).unwrap();
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        break (i + 4, len);
                    }
                };
                while buf.len() < head_end + content_len {
                    let n = sock.read(&mut tmp).unwrap();
                    buf.extend_from_slice(&tmp[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let body: Value = serde_json::from_slice(&buf[head_end..head_end + content_len]).unwrap();
                seen2.lock().unwrap().push((head, body));
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                sock.write_all(reply.as_bytes()).unwrap();
            }
        });
        (base, seen)
    }

    fn sse(parts: &[&str]) -> String {
        let mut s = String::new();
        for p in parts {
            s += &format!("data: {}\n\n", json!({"choices": [{"delta": {"content": p}}]}));
        }
        s + "data: [DONE]\n\n"
    }

    fn collect(c: &OpenAiConfig, hist: &mut Vec<ChatMessage>, text: &str, first: bool) -> Vec<Value> {
        let mut events = Vec::new();
        run_turn(c, hist, text, first, "sid", &AtomicBool::new(false), &mut |e| events.push(e));
        events
    }

    #[test]
    fn streams_deltas_and_keeps_history_across_turns() {
        let (base, seen) = mock_server(vec![(200, sse(&["Привет", ", мир"])), (200, sse(&["ок"]))]);
        let c = cfg(&base);
        let mut hist = Vec::new();

        let ev = collect(&c, &mut hist, "первый", true);
        assert_eq!(ev[0]["subtype"], "init");
        assert_eq!(ev[0]["tools"], json!([]));
        assert_eq!(ev[0]["model"], "gpt-test");
        let deltas: Vec<&str> = ev.iter().filter_map(|e| e["event"]["delta"]["text"].as_str()).collect();
        assert_eq!(deltas, ["Привет", ", мир"]);
        let last = ev.last().unwrap();
        assert_eq!(last["type"], "result");
        assert_eq!(last["is_error"], false);
        assert_eq!(last["result"], "Привет, мир");

        let ev2 = collect(&c, &mut hist, "второй", false);
        assert!(ev2.iter().all(|e| e["subtype"] != "init"), "init только на первый ход");

        let seen = seen.lock().unwrap();
        assert!(seen[0].0.to_lowercase().contains("authorization: bearer sk-test"));
        assert_eq!(seen[0].1["messages"][0]["content"], c.system_prompt);
        assert_eq!(seen[0].1["messages"].as_array().unwrap().len(), 2);
        let second = seen[1].1["messages"].as_array().unwrap();
        let roles: Vec<&str> = second.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, ["system", "user", "assistant", "user"]);
        assert_eq!(second[2]["content"], "Привет, мир");
    }

    #[test]
    fn http_error_becomes_error_result_and_is_not_kept_in_history() {
        let (base, _) = mock_server(vec![(401, r#"{"error":{"message":"Incorrect API key"}}"#.into())]);
        let c = cfg(&base);
        let mut hist = Vec::new();
        let ev = collect(&c, &mut hist, "вопрос", false);
        let last = ev.last().unwrap();
        assert_eq!(last["is_error"], true);
        assert!(last["result"].as_str().unwrap().contains("401"));
        assert!(last["result"].as_str().unwrap().contains("Incorrect API key"));
        assert!(hist.is_empty());
    }

    #[test]
    fn unreachable_server_is_reported() {
        let c = cfg("http://127.0.0.1:1/v1");
        let mut hist = Vec::new();
        let ev = collect(&c, &mut hist, "x", false);
        assert_eq!(ev.last().unwrap()["is_error"], true);
        assert!(hist.is_empty());
    }
}
