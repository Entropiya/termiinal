// Адаптер Claude: живой процесс `claude -p --input-format stream-json --output-format
// stream-json`, обёрнутый под тот же интерфейс "spawn/send/events", что и pty.rs.
//
// В отличие от pty.rs здесь НЕТ ConPTY — это структурированный протокол JSON-строк по
// обычным stdin/stdout, а не байтовый поток терминала. Rust-сторона нарочно тупая:
// читает строки с stdout и шлёт их во фронтенд как есть (по строке на событие Tauri),
// разбор содержимого (stream_event/assistant/result/rate_limit_event/...) — на TS.
//
// Флаги изоляции подобраны и ПРОВЕРЕНЫ ЖИВЬЁМ на claude-code 2.1.304 (см. docs/stage2.md):
// - `--tools ""` — ноль инструментов вообще (а не чёрный список);
// - `--mcp-config '{"mcpServers":{}}'` + `--strict-mcp-config` — без этого явного пустого
//   конфига в сессию всё равно подключался привязанный к аккаунту MCP-коннектор
//   "claude.ai Claude Docs" с 8 инструментами, несмотря на --strict-mcp-config само по себе;
// - `--disallowedTools Task,Edit,Write,NotebookEdit` — подстраховка на случай, если в
//   другой версии CLI `--tools ""` перестанет значить вообще "ничего" (саб-агенты и
//   правка файлов — то, что `--restricted` этой версии НЕ убирает, см. docs/stage2.md);
// - `--permission-prompts none` — если несмотря на всё это что-то всё же попросит
//   разрешения, оно автоматически отклоняется, а не зависает в ожидании человека,
//   которого в `-p`-режиме просто нет.
// Точные флаги перепроверяются при смене версии CLI — см. ТЗ, разд. "Слой агентов".

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct AgentSession {
    stdin: std::process::ChildStdin,
    pid: u32,
}

#[derive(Default)]
pub struct AgentState(pub Mutex<HashMap<String, AgentSession>>);

#[derive(Clone, Serialize)]
struct AgentEventPayload<'a> {
    id: &'a str,
    line: String,
}

#[derive(Clone, Serialize)]
struct AgentExitPayload<'a> {
    id: &'a str,
    code: Option<i32>,
}

#[derive(Clone, Serialize)]
struct AgentStderrPayload<'a> {
    id: &'a str,
    line: String,
}

/// Аргументы командной строки `claude` — вынесены из agent_start, чтобы флаги изоляции
/// (см. шапку файла) проверялись тестом, а не только живым запуском.
fn build_agent_args(system_prompt: &str, model: Option<&str>, max_budget_usd: Option<f64>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose", // обязателен для -p + stream-json на этой версии, иначе CLI отказывает
        "--include-partial-messages", // иначе нет дельт текста, только финальный блок
        "--replay-user-messages",
        "--tools",
        "",
        "--mcp-config",
        "{\"mcpServers\":{}}",
        "--strict-mcp-config",
        "--disallowedTools",
        "Task,Edit,Write,NotebookEdit",
        "--permission-prompts",
        "none",
        "--append-system-prompt",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    args.push(system_prompt.to_string());
    if let Some(m) = model {
        args.extend(["--model".to_string(), m.to_string()]);
    }
    if let Some(b) = max_budget_usd {
        args.extend(["--max-budget-usd".to_string(), b.to_string()]);
    }
    args
}

/// Поднять живой процесс `claude -p ...`. Возвращает id сессии; дальше в неё пишут
/// через agent_send (по одной JSON-строке за раз — ход хода диалога) и слушают
/// событие `agent-event` (сырая строка stdout) до `agent-exit`.
#[tauri::command]
pub fn agent_start(
    app: AppHandle,
    state: State<'_, AgentState>,
    system_prompt: String,
    model: Option<String>,
    max_budget_usd: Option<f64>,
) -> Result<String, String> {
    let mut cmd = Command::new("claude");
    cmd.args(build_agent_args(&system_prompt, model.as_deref(), max_budget_usd));
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {e}"))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let id = uuid::Uuid::new_v4().to_string();
    state.0.lock().insert(id.clone(), AgentSession { stdin, pid });

    let out_app = app.clone();
    let out_id = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) => {
                    if out_app
                        .emit("agent-event", AgentEventPayload { id: &out_id, line: l })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let err_app = app.clone();
    let err_id = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(l) => {
                    let _ = err_app.emit("agent-stderr", AgentStderrPayload { id: &err_id, line: l });
                }
                Err(_) => break,
            }
        }
    });

    // Поток ожидания владеет Child НАПРЯМУЮ (см. тот же баг и фикс в pty.rs): wait()
    // блокируется на весь срок жизни процесса, и если бы Child сидел в общей мапе под
    // тем же мьютексом, что и stdin для agent_send, любая отправка сообщения зависла бы
    // намертво на первом же вызове. Поэтому child сюда — во владение, а в мапе остаётся
    // только io-дешёвый stdin + pid (на нём и держится agent_stop).
    let wait_app = app.clone();
    let wait_id = id.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        wait_app.state::<AgentState>().0.lock().remove(&wait_id);
        let _ = wait_app.emit("agent-exit", AgentExitPayload { id: &wait_id, code });
    });

    Ok(id)
}

/// Отправить одну JSON-строку (ход диалога) в stdin живого процесса.
#[tauri::command]
pub fn agent_send(state: State<'_, AgentState>, id: String, json_line: String) -> Result<(), String> {
    let mut map = state.0.lock();
    let session = map.get_mut(&id).ok_or("unknown agent session")?;
    session
        .stdin
        .write_all(json_line.as_bytes())
        .and_then(|_| session.stdin.write_all(b"\n"))
        .and_then(|_| session.stdin.flush())
        .map_err(|e| format!("write: {e}"))
}

/// Принудительно завершить сессию. Сессия агента — расходник (см. ТЗ), поэтому без
/// попыток дождаться изящного завершения по EOF: сразу taskkill по pid дерева процессов.
#[tauri::command]
pub fn agent_stop(state: State<'_, AgentState>, id: String) -> Result<(), String> {
    let session = state.0.lock().remove(&id);
    if let Some(session) = session {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &session.pid.to_string(), "/T", "/F"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            kill.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = kill.output(); // процесс мог уже выйти сам — это не ошибка
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::build_agent_args;

    fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let i = args.iter().position(|a| a == flag)?;
        args.get(i + 1).map(String::as_str)
    }

    #[test]
    fn isolation_flags_are_always_present() {
        let args = build_agent_args("sys", None, None);
        assert_eq!(value_after(&args, "--tools"), Some(""));
        assert_eq!(value_after(&args, "--mcp-config"), Some("{\"mcpServers\":{}}"));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert_eq!(value_after(&args, "--permission-prompts"), Some("none"));
        assert_eq!(
            value_after(&args, "--disallowedTools"),
            Some("Task,Edit,Write,NotebookEdit")
        );
    }

    #[test]
    fn system_prompt_is_passed_as_single_argument() {
        let prompt = "строка 1\nстрока 2 --tools evil";
        let args = build_agent_args(prompt, None, None);
        assert_eq!(value_after(&args, "--append-system-prompt"), Some(prompt));
        assert_eq!(args.iter().filter(|a| a.as_str() == "--tools").count(), 1);
    }

    #[test]
    fn model_and_budget_are_optional() {
        let bare = build_agent_args("p", None, None);
        assert!(!bare.contains(&"--model".to_string()));
        assert!(!bare.contains(&"--max-budget-usd".to_string()));

        let full = build_agent_args("p", Some("claude-sonnet-5-5"), Some(1.5));
        assert_eq!(value_after(&full, "--model"), Some("claude-sonnet-5-5"));
        assert_eq!(value_after(&full, "--max-budget-usd"), Some("1.5"));
    }
}
