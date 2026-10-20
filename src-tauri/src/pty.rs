// Этап 1: минимальный ConPTY-бэкенд поверх portable-pty.
//
// Задача этого модуля — только дать фронтенду "сырой" байтовый канал к ConPTY:
// spawn/write/resize/kill. Любая логика нарезки на блоки (OSC 133/633, headless-рендер)
// живёт во фронтенде, потому что именно там будут жить xterm.js и @xterm/headless —
// это упрощает сверку "дошёл ли маркер целым" (сверяем то, что реально увидел xterm.js).

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState(pub Mutex<HashMap<String, PtySession>>);

#[derive(Clone, Serialize)]
struct PtyOutputPayload<'a> {
    id: &'a str,
    #[serde(rename = "dataB64")]
    data_b64: String,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload<'a> {
    id: &'a str,
    code: Option<u32>,
}

/// Запустить программу (например `ssh.exe`, `cmd.exe` или git-bash `bash.exe`) под ConPTY.
/// Возвращает id сессии; дальнейшие чтение/запись/ресайз адресуются по нему.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {program}: {e}"))?;

    // На Windows слейв-хэндл после spawn больше не нужен приложению.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();

    {
        let mut map = state.0.lock();
        map.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    // Поток чтения: гоняем сырые байты во фронтенд как есть (base64), без попытки
    // декодировать их в Rust — правильная сборка UTF-8 на границах чанков и разбор
    // ANSI/OSC делается в xterm.js/@xterm/headless на стороне фронтенда.
    let read_app = app.clone();
    let read_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = PtyOutputPayload {
                        id: &read_id,
                        data_b64: B64.encode(&buf[..n]),
                    };
                    if read_app.emit("pty-output", payload).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Отдельный поток ждёт завершения процесса (read-поток выше завершится раньше,
    // как только ConPTY закроет хвост, но код возврата доступен только через wait()).
    let wait_app = app.clone();
    let wait_id = id.clone();
    std::thread::spawn(move || {
        // Код возврата снимаем через повторный lock состояния приложения.
        let app_state = wait_app.state::<PtyState>();
        let code = {
            let mut map = app_state.0.lock();
            if let Some(session) = map.get_mut(&wait_id) {
                session.child.wait().ok().map(|s| s.exit_code())
            } else {
                None
            }
        };
        let _ = wait_app.emit(
            "pty-exit",
            PtyExitPayload {
                id: &wait_id,
                code,
            },
        );
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock();
    let session = map.get_mut(&id).ok_or("unknown pty session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    session.writer.flush().map_err(|e| format!("flush: {e}"))
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.0.lock();
    let session = map.get(&id).ok_or("unknown pty session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut map = state.0.lock();
    if let Some(mut session) = map.remove(&id) {
        session.child.kill().map_err(|e| format!("kill: {e}"))?;
    }
    Ok(())
}
