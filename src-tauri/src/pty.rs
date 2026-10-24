// Этап 1: минимальный PTY-бэкенд (ConPTY на Windows, см. pty_backend.rs) поверх portable-pty.
//
// Задача этого модуля — только дать фронтенду "сырой" байтовый канал к ConPTY:
// spawn/write/resize/kill. Любая логика нарезки на блоки (OSC 133/633, headless-рендер)
// живёт во фронтенде, потому что именно там будут жить xterm.js и @xterm/headless —
// это упрощает сверку "дошёл ли маркер целым" (сверяем то, что реально увидел xterm.js).

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crate::pty_backend::{default_backend, PtyProcess, SpawnSpec};
use parking_lot::Mutex;
use portable_pty::{ChildKiller, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // Только "убийца", а не сам Child: Child.wait() блокируется на всё время жизни
    // процесса, и если держать Child в этой же мапе, поток ожидания был бы вынужден
    // держать блокировку состояния все это время — см. комментарий у wait-потока ниже.
    killer: Box<dyn ChildKiller + Send + Sync>,
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
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let PtyProcess {
        master,
        mut reader,
        writer,
        killer,
        mut child,
    } = default_backend().spawn(&SpawnSpec {
        program,
        args,
        cwd,
        env: env.unwrap_or_default(),
        cols,
        rows,
    })?;

    let id = uuid::Uuid::new_v4().to_string();

    {
        let mut map = state.0.lock();
        map.insert(
            id.clone(),
            PtySession {
                master,
                writer,
                killer,
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

    // Отдельный поток ждёт завершения процесса. ВАЖНО: `child.wait()` блокируется на
    // всё время жизни сессии (часы), поэтому `child` передаётся сюда НАПРЯМУЮ, во
    // владение потока, а не через общую `PtyState` — иначе пришлось бы держать общий
    // мьютекс залоченным всё это время, и любой pty_write/pty_resize (а значит и
    // каждое нажатие клавиши) блокировался бы намертво до закрытия сессии. Именно
    // этот баг вызывал зависание всего приложения после спавна первой же сессии.
    let wait_app = app.clone();
    let wait_id = id.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        // Сессии больше нет — подчищаем общую мапу (master/writer больше не нужны).
        // Лочим только здесь и только на короткую операцию remove(), не на время wait().
        wait_app.state::<PtyState>().0.lock().remove(&wait_id);
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
    // Сессию из мапы не убираем здесь: это сделает wait-поток сам, когда увидит,
    // что процесс действительно завершился (kill() только посылает сигнал/запрос).
    let map = state.0.lock();
    let session = map.get(&id).ok_or("unknown pty session")?;
    // `kill()` у ChildKiller требует `&mut self`; клонируем killer, чтобы не держать
    // мьютекс заблокированным на время самого системного вызова завершения процесса.
    let mut killer = session.killer.clone_killer();
    drop(map);
    killer.kill().map_err(|e| format!("kill: {e}"))
}
