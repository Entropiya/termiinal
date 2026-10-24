// Адаптер Claude: живой процесс `claude -p --input-format stream-json --output-format
// stream-json`, обёрнутый под тот же интерфейс "spawn/send/events", что и pty.rs.
//
// В отличие от pty.rs здесь НЕТ ConPTY — это структурированный протокол JSON-строк по
// обычным stdin/stdout, а не байтовый поток терминала. Rust-сторона нарочно тупая:
// читает строки с stdout и шлёт их во фронтенд как есть (по строке на событие Tauri),
// разбор содержимого (stream_event/assistant/result/rate_limit_event/...) — на TS.
//
// Флаги изоляции подобраны и ПРОВЕРЕНЫ ЖИВЬЁМ на claude-code 2.1.304 (см. docs/stage2.md),
// `--system-prompt` + `--setting-sources ""` перепроверены на 2.1.310:
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

use crate::codex::{self, CodexConfig, CodexSession};
use crate::openai::{self, OpenAiConfig, OpenAiSession};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub enum AgentSession {
    /// Живой процесс `claude -p …`.
    Claude { stdin: std::process::ChildStdin, pid: u32 },
    /// ChatGPT по HTTPS (см. openai.rs): процесса нет, история диалога лежит в сессии.
    OpenAi(Arc<OpenAiSession>),
    /// ChatGPT через Codex CLI с входом пользователя (см. codex.rs): каждый ход — отдельный процесс.
    Codex(Arc<CodexSession>),
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
        // Полная ЗАМЕНА системного промпта нашим (src/system-prompt.md), а не добавка к
        // встроенному промпту Claude Code: тогда Claude и GPT-адаптер отвечают по одним и тем
        // же правилам. `--setting-sources ""` отключает подхват CLAUDE.md/настроек из рабочей
        // папки и ~/.claude — проверено: без него агент цитировал CLAUDE.md из cwd.
        "--system-prompt",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    args.push(system_prompt.to_string());
    args.extend(["--setting-sources".to_string(), String::new()]);
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
    provider: Option<String>,
    api_key: Option<String>,
) -> Result<String, String> {
    match provider.as_deref() {
        Some("openai") => return start_openai(&state, system_prompt, model, api_key),
        Some("codex") => return start_codex(&state, system_prompt, model),
        _ => {}
    }
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
    state.0.lock().insert(id.clone(), AgentSession::Claude { stdin, pid });

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

/// Ключ OpenAI: из настроек приложения, иначе из переменной окружения OPENAI_API_KEY.
fn resolve_openai_key(from_ui: Option<String>) -> Result<String, String> {
    from_ui
        .filter(|k| !k.trim().is_empty())
        .or_else(|| std::env::var("OPENAI_API_KEY").ok().filter(|k| !k.trim().is_empty()))
        .map(|k| k.trim().to_string())
        .ok_or_else(|| "нет ключа OpenAI: введи его в «Настройки» или задай OPENAI_API_KEY".to_string())
}

fn start_openai(
    state: &State<'_, AgentState>,
    system_prompt: String,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<String, String> {
    let cfg = OpenAiConfig {
        api_key: resolve_openai_key(api_key)?,
        base_url: std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| openai::DEFAULT_BASE_URL.to_string()),
        model: model.ok_or("не указана модель OpenAI")?,
        system_prompt,
    };
    let id = uuid::Uuid::new_v4().to_string();
    state
        .0
        .lock()
        .insert(id.clone(), AgentSession::OpenAi(Arc::new(OpenAiSession::new(cfg))));
    Ok(id)
}

fn start_codex(state: &State<'_, AgentState>, system_prompt: String, model: Option<String>) -> Result<String, String> {
    let bin = codex::locate_and_check_login()?;
    let cfg = CodexConfig {
        bin,
        model: model.ok_or("не указана модель ChatGPT")?,
        system_prompt,
        extra_args: Vec::new(),
        extra_env: Vec::new(),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let session = CodexSession::new(cfg, &id).map_err(|e| format!("рабочая папка Codex: {e}"))?;
    state.0.lock().insert(id.clone(), AgentSession::Codex(Arc::new(session)));
    Ok(id)
}

/// Один ход диалога с Codex в отдельном потоке; события уходят в тот же `agent-event`.
fn spawn_codex_turn(app: AppHandle, id: String, session: Arc<CodexSession>, user_text: String) {
    std::thread::spawn(move || {
        let mut history = session.history.lock();
        let first_turn = !session.turned.swap(true, std::sync::atomic::Ordering::SeqCst);
        codex::run_turn(
            &session.cfg,
            &mut history,
            &user_text,
            first_turn,
            &id,
            &session.instructions_file(),
            &session.work_dir(),
            &session.cancel,
            &session.pid,
            &mut |ev| {
                if session.cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                let _ = app.emit("agent-event", AgentEventPayload { id: &id, line: ev.to_string() });
            },
        );
    });
}

/// Один ход диалога с ChatGPT в отдельном потоке; события уходят в тот же `agent-event`.
fn spawn_openai_turn(app: AppHandle, id: String, session: Arc<OpenAiSession>, user_text: String) {
    std::thread::spawn(move || {
        // Ходы одной сессии идут строго по очереди (фронтенд и так не шлёт второй, пока
        // не пришёл ответ на первый, но блокировка истории делает это гарантией).
        let mut history = session.history.lock();
        let first_turn = !session.turned.swap(true, std::sync::atomic::Ordering::SeqCst);
        openai::run_turn(
            &session.cfg,
            &mut history,
            &user_text,
            first_turn,
            &id,
            &session.cancel,
            &mut |ev| {
                if session.cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                let _ = app.emit("agent-event", AgentEventPayload { id: &id, line: ev.to_string() });
            },
        );
    });
}

/// Отправить одну JSON-строку (ход диалога) в живую сессию агента.
#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    state: State<'_, AgentState>,
    id: String,
    json_line: String,
) -> Result<(), String> {
    let mut map = state.0.lock();
    match map.get_mut(&id).ok_or("unknown agent session")? {
        AgentSession::Claude { stdin, .. } => stdin
            .write_all(json_line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("write: {e}")),
        AgentSession::OpenAi(session) => {
            let session = session.clone();
            drop(map);
            let text = openai::extract_user_text(&json_line)?;
            spawn_openai_turn(app, id, session, text);
            Ok(())
        }
        AgentSession::Codex(session) => {
            let session = session.clone();
            drop(map);
            let text = openai::extract_user_text(&json_line)?;
            spawn_codex_turn(app, id, session, text);
            Ok(())
        }
    }
}

/// Принудительно завершить сессию. Сессия агента — расходник (см. ТЗ), поэтому без
/// попыток дождаться изящного завершения по EOF: сразу taskkill по pid дерева процессов.
#[tauri::command]
pub fn agent_stop(app: AppHandle, state: State<'_, AgentState>, id: String) -> Result<(), String> {
    let session = state.0.lock().remove(&id);
    match session {
        Some(AgentSession::Claude { pid, .. }) => {
            let mut kill = Command::new("taskkill");
            kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                kill.creation_flags(CREATE_NO_WINDOW);
            }
            let _ = kill.output(); // процесс мог уже выйти сам — это не ошибка
        }
        Some(AgentSession::Codex(session)) => {
            session.shutdown();
            let _ = app.emit("agent-exit", AgentExitPayload { id: &id, code: Some(0) });
        }
        Some(AgentSession::OpenAi(session)) => {
            session.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            // Процесса нет, wait-потока тоже — сообщаем фронтенду о завершении сами.
            let _ = app.emit("agent-exit", AgentExitPayload { id: &id, code: Some(0) });
        }
        None => {}
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
        assert_eq!(value_after(&args, "--system-prompt"), Some(prompt));
        assert_eq!(args.iter().filter(|a| a.as_str() == "--tools").count(), 1);
    }

    #[test]
    fn project_settings_and_default_prompt_are_not_used() {
        let args = build_agent_args("p", None, None);
        assert_eq!(value_after(&args, "--setting-sources"), Some(""));
        assert!(!args.contains(&"--append-system-prompt".to_string()));
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
