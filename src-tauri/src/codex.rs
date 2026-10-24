// Адаптер ChatGPT через Codex CLI (`codex exec --json`): работает с входом, который уже есть на
// компьютере пользователя (`codex login`, подписка ChatGPT), ключ OpenAI API не нужен. Событийный
// контракт тот же, что у Claude и openai.rs (`system/init`, `stream_event`, `result`).
//
// ВАЖНО про изоляцию — здесь она СЛАБЕЕ, чем у Claude (`--tools ""`). Проверено на codex 0.164
// по настоящим запросам к мок-серверу Responses API:
// - основные инструменты Codex (`exec` — запуск команд, мультиагентные, `request_user_input`)
//   конфигом и флагами `--disable` НЕ отключаются: после выключения всех включённых функций они
//   остаются в запросе к модели;
// - вызов `exec` реально выполняется (команда стартует в песочнице), а в потоке `--json` для него
//   нет никаких событий, так что "увидеть и убить" нельзя.
// Что делаем вместо этого (всё вместе, по слоям):
// - `-s read-only`: записи на диск и сеть запрещены песочницей (проверено: `touch` -> "Read-only
//   file system"); читать файлы она НЕ запрещает, ограничить чтение конфигом нельзя;
// - рабочая папка — пустая временная, не папка пользователя;
// - `--ignore-user-config`/`--ignore-rules`: ни MCP-серверов, ни хуков, ни плагинов из ~/.codex;
// - встроенный промпт Codex заменён нашим файлом (`model_instructions_file`), в нём прямой запрет
//   пользоваться инструментами; лишние функции (браузер, плагины, память...) выключены;
// - фронтенд показывает пользователю предупреждение об этом ограничении.
// Диалог ведём сами: каждый ход — отдельный `codex exec --ephemeral` (сессии в ~/.codex не пишутся),
// история дописывается в запрос.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Нет ни одного события от Codex столько времени — считаем, что завис.
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);
/// Сколько символов истории (без нового сообщения) подмешиваем в запрос.
const MAX_HISTORY_CHARS: usize = 60_000;

/// Функции Codex, добавляющие инструменты или инструкции; выключаем всё лишнее. Ядро (`exec` и
/// мультиагентные) этим не снимается — см. шапку файла.
const DISABLED_FEATURES: &[&str] = &[
    "apps",
    "plugins",
    "hooks",
    "goals",
    "memories",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "view_image",
    "tool_suggest",
    "skill_search",
    "sleep_tool",
    "multi_agent",
    "in_app_browser",
    "in_app_chat",
    "daemon_auto_start",
];

#[derive(Clone, Debug)]
pub struct CodexConfig {
    /// Исполняемый файл Codex (`codex`, на Windows может быть `codex.cmd`).
    pub bin: String,
    pub model: String,
    pub system_prompt: String,
    /// Дополнительные аргументы `codex exec` (тесты подставляют сюда мок-провайдера).
    pub extra_args: Vec<String>,
    /// Дополнительные переменные окружения процесса Codex (тесты: CODEX_HOME, ключ мок-провайдера).
    pub extra_env: Vec<(String, String)>,
}

/// Одна реплика диалога: ("user" | "assistant", текст).
pub type Turn = (String, String);

#[derive(Debug, PartialEq)]
pub enum CodexEvent {
    /// Ответ модели (`item.completed` типа `agent_message`).
    Message(String),
    /// Любой другой элемент: команда, MCP, правка файла... (имя типа элемента).
    ToolItem(String),
    TurnCompleted,
    Failed(String),
    Ignore,
}

/// Разбор одной строки JSONL-потока `codex exec --json`.
pub fn parse_event_line(line: &str) -> CodexEvent {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return CodexEvent::Ignore;
    };
    let ty = v["type"].as_str().unwrap_or("");
    match ty {
        "item.completed" | "item.started" => {
            let item_type = v["item"]["type"].as_str().unwrap_or("");
            match item_type {
                "agent_message" if ty == "item.completed" => {
                    CodexEvent::Message(v["item"]["text"].as_str().unwrap_or("").to_string())
                }
                "agent_message" | "reasoning" | "" => CodexEvent::Ignore,
                other => CodexEvent::ToolItem(other.to_string()),
            }
        }
        "turn.completed" => CodexEvent::TurnCompleted,
        "turn.failed" | "error" => {
            let msg = v["error"]["message"]
                .as_str()
                .or_else(|| v["message"].as_str())
                .unwrap_or("неизвестная ошибка Codex");
            CodexEvent::Failed(msg.to_string())
        }
        _ => CodexEvent::Ignore,
    }
}

/// Запрос к модели на этот ход. Первый ход — просто текст пользователя; дальше — история
/// (обрезанная с головы) и новое сообщение.
pub fn build_prompt(history: &[Turn], user_text: &str) -> String {
    if history.is_empty() {
        return user_text.to_string();
    }
    let mut used = 0usize;
    let mut kept: Vec<&Turn> = Vec::new();
    for t in history.iter().rev() {
        used += t.1.chars().count();
        if used > MAX_HISTORY_CHARS && !kept.is_empty() {
            break;
        }
        kept.push(t);
    }
    kept.reverse();
    let mut s = String::from("Предыдущая часть диалога (для контекста):\n\n");
    for (role, text) in kept {
        let who = if role == "user" { "Пользователь" } else { "Ты (ассистент)" };
        s.push_str(&format!("[{who}]\n{text}\n\n"));
    }
    s.push_str("Новое сообщение пользователя (ответь на него):\n\n");
    s.push_str(user_text);
    s
}

/// Аргументы `codex exec`. Значения `-c` без кавычек: если значение не разобралось как TOML,
/// Codex берёт его как строку, а в кавычках аргумент ломается на Windows при запуске `.cmd`.
pub fn build_exec_args(cfg: &CodexConfig, instructions_file: &Path, work_dir: &Path) -> Vec<String> {
    let mut a: Vec<String> = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-s",
        "read-only",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.extend(["-m".into(), cfg.model.clone()]);
    a.extend(["-C".into(), work_dir.display().to_string()]);
    a.extend(["-c".into(), format!("model_instructions_file={}", instructions_file.display())]);
    for flag in [
        "include_environment_context=false",
        "include_permissions_instructions=false",
        "include_apps_instructions=false",
        "include_collaboration_mode_instructions=false",
        "web_search=disabled",
    ] {
        a.extend(["-c".into(), flag.into()]);
    }
    for f in DISABLED_FEATURES {
        a.extend(["--disable".into(), (*f).into()]);
    }
    a.extend(cfg.extra_args.iter().cloned());
    a.push("-".into()); // запрос читаем со stdin
    a
}

fn init_event(cfg: &CodexConfig, session_id: &str) -> Value {
    // tools непустой намеренно: у Codex инструменты не отключить, фронтенд покажет предупреждение.
    json!({"type": "system", "subtype": "init", "session_id": session_id,
           "tools": ["exec (read-only песочница)"], "mcp_servers": [], "model": cfg.model})
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

/// Завершить процесс вместе с потомками (Codex на Windows запускается через `.cmd` -> node).
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

/// Один ход диалога. `work_dir` — пустая временная папка, `instructions_file` — файл с нашим
/// системным промптом. `current_pid` обновляется, чтобы `agent_stop` мог убить процесс.
#[allow(clippy::too_many_arguments)]
pub fn run_turn(
    cfg: &CodexConfig,
    history: &mut Vec<Turn>,
    user_text: &str,
    first_turn: bool,
    session_id: &str,
    instructions_file: &Path,
    work_dir: &Path,
    cancel: &AtomicBool,
    current_pid: &AtomicU32,
    emit: &mut dyn FnMut(Value),
) {
    let started = Instant::now();
    if first_turn {
        emit(init_event(cfg, session_id));
    }
    let prompt = build_prompt(history, user_text);

    let mut cmd = Command::new(&cfg.bin);
    cmd.args(build_exec_args(cfg, instructions_file, work_dir))
        .envs(cfg.extra_env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit(result_event(&format!("Codex не запустился ({}): {e}", cfg.bin), true, started));
            return;
        }
    };
    current_pid.store(child.id(), Ordering::SeqCst);

    let mut stdin = child.stdin.take().expect("stdin piped");
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
        // stdin закрывается при выходе из потока: Codex видит конец запроса.
    });
    let stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let mut texts: Vec<String> = Vec::new();
    let mut outcome: Option<Result<(), String>> = None;
    let mut tool_items: Vec<String> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            kill_tree(child.id());
            let _ = child.wait();
            let _ = writer.join();
            current_pid.store(0, Ordering::SeqCst);
            return;
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => match parse_event_line(&line) {
                CodexEvent::Message(t) => {
                    if !texts.is_empty() {
                        emit(delta_event("\n\n"));
                    }
                    emit(delta_event(&t));
                    texts.push(t);
                }
                CodexEvent::ToolItem(kind) => {
                    if !tool_items.contains(&kind) {
                        emit(json!({"type": "system", "subtype": "tool_use", "tool": kind}));
                        tool_items.push(kind);
                    }
                }
                CodexEvent::TurnCompleted => {
                    outcome = Some(Ok(()));
                    break;
                }
                CodexEvent::Failed(m) => {
                    outcome = Some(Err(m));
                    break;
                }
                CodexEvent::Ignore => {}
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if started.elapsed() > IDLE_TIMEOUT && texts.is_empty() {
                    kill_tree(child.id());
                    outcome = Some(Err("Codex не отвечает (таймаут)".into()));
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break, // процесс закрыл stdout
        }
    }
    if outcome.is_none() || matches!(outcome, Some(Err(_))) {
        kill_tree(child.id());
    }
    let _ = child.wait();
    let _ = writer.join();
    current_pid.store(0, Ordering::SeqCst);
    let stderr_text = err_reader.join().unwrap_or_default();

    match outcome {
        Some(Ok(())) => {
            let full = texts.join("\n\n");
            history.push(("user".into(), user_text.to_string()));
            history.push(("assistant".into(), full.clone()));
            emit(result_event(&full, false, started));
        }
        Some(Err(msg)) => emit(result_event(&format!("Codex: {msg}"), true, started)),
        None => {
            let tail: Vec<&str> = stderr_text
                .lines()
                .filter(|l| !l.contains(" INFO ") && !l.starts_with("WARNING") && !l.trim().is_empty())
                .rev()
                .take(3)
                .collect();
            let detail = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            emit(result_event(
                &format!("Codex завершился без ответа{}", if detail.is_empty() { String::new() } else { format!(": {detail}") }),
                true,
                started,
            ));
        }
    }
}

/// Рабочие файлы сессии: `<tmp>/termiinal-codex-<id>/{instructions.md, work/}`.
pub struct CodexSession {
    pub cfg: CodexConfig,
    pub dir: PathBuf,
    pub history: parking_lot::Mutex<Vec<Turn>>,
    pub turned: AtomicBool,
    pub cancel: AtomicBool,
    pub pid: AtomicU32,
}

impl CodexSession {
    pub fn new(cfg: CodexConfig, id: &str) -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!("termiinal-codex-{id}"));
        std::fs::create_dir_all(dir.join("work"))?;
        std::fs::write(dir.join("instructions.md"), &cfg.system_prompt)?;
        Ok(Self {
            cfg,
            dir,
            history: parking_lot::Mutex::new(Vec::new()),
            turned: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            pid: AtomicU32::new(0),
        })
    }

    pub fn instructions_file(&self) -> PathBuf {
        self.dir.join("instructions.md")
    }

    pub fn work_dir(&self) -> PathBuf {
        self.dir.join("work")
    }

    /// Остановить текущий ход (если идёт) и убрать рабочие файлы.
    pub fn shutdown(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        let pid = self.pid.load(Ordering::SeqCst);
        if pid != 0 {
            kill_tree(pid);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Найти Codex и убедиться, что вход выполнен. Возвращает путь/имя для запуска.
pub fn locate_and_check_login() -> Result<String, String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(p) = std::env::var("CODEX_BIN") {
        candidates.push(p);
    }
    candidates.push("codex".into());
    #[cfg(windows)]
    candidates.push("codex.cmd".into());

    for bin in candidates {
        let mut cmd = Command::new(&bin);
        cmd.args(["login", "status"]).stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        match cmd.output() {
            Ok(out) if out.status.success() => return Ok(bin),
            Ok(_) => {
                return Err("Codex найден, но вход не выполнен: выполни в терминале `codex login` и запусти агента снова".into())
            }
            Err(_) => continue,
        }
    }
    Err("Codex CLI не найден: установи его (`npm i -g @openai/codex`) и выполни `codex login`".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events() {
        assert_eq!(
            parse_event_line(r#"{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"Привет"}}"#),
            CodexEvent::Message("Привет".into())
        );
        assert_eq!(parse_event_line(r#"{"type":"turn.completed","usage":{}}"#), CodexEvent::TurnCompleted);
        assert_eq!(parse_event_line(r#"{"type":"thread.started","thread_id":"x"}"#), CodexEvent::Ignore);
        assert_eq!(
            parse_event_line(r#"{"type":"item.started","item":{"type":"command_execution","command":"ls"}}"#),
            CodexEvent::ToolItem("command_execution".into())
        );
        assert_eq!(
            parse_event_line(r#"{"type":"turn.failed","error":{"message":"boom"}}"#),
            CodexEvent::Failed("boom".into())
        );
        assert_eq!(parse_event_line(r#"{"type":"error","message":"oops"}"#), CodexEvent::Failed("oops".into()));
        assert_eq!(parse_event_line("не json"), CodexEvent::Ignore);
    }

    #[test]
    fn first_turn_prompt_is_plain_text() {
        assert_eq!(build_prompt(&[], "вопрос"), "вопрос");
    }

    #[test]
    fn later_turns_carry_history_and_new_message() {
        let h = vec![("user".to_string(), "раз".to_string()), ("assistant".to_string(), "два".to_string())];
        let p = build_prompt(&h, "три");
        assert!(p.contains("[Пользователь]\nраз"));
        assert!(p.contains("[Ты (ассистент)]\nдва"));
        assert!(p.ends_with("три"));
    }

    #[test]
    fn long_history_is_trimmed_from_the_head() {
        let big = "я".repeat(40_000);
        let h = vec![
            ("user".to_string(), "СТАРОЕ".to_string()),
            ("assistant".to_string(), big.clone()),
            ("user".to_string(), big),
        ];
        let p = build_prompt(&h, "новое");
        assert!(!p.contains("СТАРОЕ"));
        assert!(p.ends_with("новое"));
    }

    #[test]
    fn exec_args_isolate_the_session() {
        let cfg = CodexConfig {
            bin: "codex".into(),
            model: "gpt-6.1-sol".into(),
            system_prompt: "p".into(),
            extra_args: vec![],
            extra_env: vec![],
        };
        let a = build_exec_args(&cfg, Path::new("/t/instructions.md"), Path::new("/t/work"));
        let joined = a.join(" ");
        for must in [
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "-s read-only",
            "-m gpt-6.1-sol",
            "-C /t/work",
            "model_instructions_file=/t/instructions.md",
            "include_environment_context=false",
            "web_search=disabled",
            "--disable browser_use",
            "--disable plugins",
        ] {
            assert!(joined.contains(must), "нет {must:?} в {joined}");
        }
        assert_eq!(a.last().unwrap(), "-", "запрос читается со stdin");
        assert!(!joined.contains("danger-full-access"));
        assert!(!joined.contains("workspace-write"));
        assert!(!joined.contains('"'), "кавычки в аргументах ломают запуск .cmd на Windows");
    }
}
