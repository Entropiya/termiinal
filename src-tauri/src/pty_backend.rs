// Абстракция PTY-бэкенда. Tauri-команды в pty.rs знают только про трейт `PtyBackend`
// и `PtyProcess`; какой именно псевдотерминал под ними — решает `default_backend()`:
//   - Windows: `ConPtyBackend` (ConPTY, `ssh.exe`/`cmd.exe`/git-bash `bash.exe`);
//   - Unix:    `UnixPtyBackend` (openpty/forkpty) — нужен, чтобы то же самое можно было
//              гонять в тестах на Linux без Windows-машины.
// Обе реализации ходят через portable-pty (он сам выбирает ConPTY или openpty под ОС),
// но каждая за своим #[cfg], так что платформенно-специфичные нюансы живут рядом с
// "своей" платформой, а модуль не зависит от tauri и тестируется отдельно.

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};

/// Что запустить и с каким размером окна.
#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

/// Живой процесс под PTY. Части разнесены так, чтобы их можно было раздать разным
/// потокам: читалка и ожидание владеют своим, а в общую мапу сессий кладутся только
/// дешёвые `master`/`writer`/`killer` (см. комментарий про `child.wait()` в pty.rs).
pub struct PtyProcess {
    pub master: Box<dyn MasterPty + Send>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    pub child: Box<dyn Child + Send + Sync>,
}

pub trait PtyBackend: Send + Sync {
    fn spawn(&self, spec: &SpawnSpec) -> Result<PtyProcess, String>;
}

/// Общая часть обеих реализаций: открыть пару, запустить программу, забрать хэндлы.
fn spawn_on(system: &dyn PtySystem, spec: &SpawnSpec) -> Result<PtyProcess, String> {
    let pair = system
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    if let Some(dir) = &spec.cwd {
        cmd.cwd(dir);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {}: {e}", spec.program))?;
    let killer = child.clone_killer();

    // Слейв-хэндл после spawn приложению не нужен (на Windows — обязательно закрыть,
    // на Unix без этого читалка не увидит EOF после выхода процесса).
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    Ok(PtyProcess {
        master: pair.master,
        reader,
        writer,
        killer,
        child,
    })
}

#[cfg(windows)]
pub struct ConPtyBackend;

#[cfg(windows)]
impl PtyBackend for ConPtyBackend {
    fn spawn(&self, spec: &SpawnSpec) -> Result<PtyProcess, String> {
        // На Windows native_pty_system() — это ConPTY.
        spawn_on(portable_pty::native_pty_system().as_ref(), spec)
    }
}

#[cfg(unix)]
pub struct UnixPtyBackend;

#[cfg(unix)]
impl PtyBackend for UnixPtyBackend {
    fn spawn(&self, spec: &SpawnSpec) -> Result<PtyProcess, String> {
        spawn_on(portable_pty::native_pty_system().as_ref(), spec)
    }
}

pub fn default_backend() -> Box<dyn PtyBackend> {
    #[cfg(windows)]
    {
        Box::new(ConPtyBackend)
    }
    #[cfg(unix)]
    {
        Box::new(UnixPtyBackend)
    }
}
