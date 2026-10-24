// Интеграционный тест ConPTY-бэкенда: cmd.exe /c echo → вывод приходит через PTY.
// Запускается только на Windows (в CI — windows-latest).
#![cfg(windows)]

use std::io::Read;
use std::time::{Duration, Instant};
use termiinal_lib::pty_backend::{default_backend, PtyProcess, SpawnSpec};

#[test]
fn conpty_runs_cmd_and_returns_output() {
    let PtyProcess { mut reader, mut child, .. } = default_backend()
        .spawn(&SpawnSpec {
            program: "cmd.exe".into(),
            args: vec!["/c".into(), "echo conpty-hello-42".into()],
            cwd: None,
            env: Default::default(),
            cols: 80,
            rows: 24,
        })
        .expect("spawn cmd.exe");

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    // ConPTY не отдаёт EOF, пока жив master, поэтому ждём по содержимому, а не по закрытию.
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !String::from_utf8_lossy(&out).contains("conpty-hello-42") {
        let left = deadline.saturating_duration_since(Instant::now());
        assert!(!left.is_zero(), "нет вывода от cmd.exe: {:?}", String::from_utf8_lossy(&out));
        if let Ok(chunk) = rx.recv_timeout(left) {
            out.extend(chunk);
        }
    }
    assert_eq!(child.wait().expect("wait").exit_code(), 0);
}
