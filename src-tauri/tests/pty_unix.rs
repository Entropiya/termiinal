// Интеграционный тест Unix-бэкенда на настоящем bash: проверяет сам канал
// spawn → вывод → ввод → код возврата. Разбор блоков (TS-парсер) поверх реального
// bash проверяет src/pty-bash.integration.test.ts через examples/pty_capture.rs.
#![cfg(unix)]

use std::io::{Read, Write};
use std::time::{Duration, Instant};
use termiinal_lib::pty_backend::{default_backend, PtyProcess, SpawnSpec};

fn spawn_bash() -> PtyProcess {
    default_backend()
        .spawn(&SpawnSpec {
            program: "bash".into(),
            args: vec!["--norc".into(), "--noprofile".into(), "-i".into()],
            cwd: None,
            env: [("PS1".to_string(), "READY> ".to_string())].into(),
            cols: 80,
            rows: 24,
        })
        .expect("spawn bash")
}

/// Читает вывод в фоне и ждёт появления `needle` (или падает по таймауту).
fn read_until(rx: &std::sync::mpsc::Receiver<Vec<u8>>, acc: &mut Vec<u8>, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !String::from_utf8_lossy(acc).contains(needle) {
        let left = deadline.saturating_duration_since(Instant::now());
        assert!(
            !left.is_zero(),
            "не дождались {needle:?}, получено: {:?}",
            String::from_utf8_lossy(acc)
        );
        if let Ok(chunk) = rx.recv_timeout(left) {
            acc.extend(chunk);
        }
    }
}

fn pump(mut reader: Box<dyn Read + Send>) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    rx
}

#[test]
fn bash_runs_command_and_reports_exit_code() {
    let PtyProcess { reader, mut writer, mut child, master, .. } = spawn_bash();
    let rx = pump(reader);
    let mut out = Vec::new();

    read_until(&rx, &mut out, "READY> ");
    writer.write_all(b"echo hello-$((40 + 2))\r").unwrap();
    read_until(&rx, &mut out, "hello-42\r\n");

    writer.write_all(b"exit 3\r").unwrap();
    let status = child.wait().expect("wait");
    assert_eq!(status.exit_code(), 3);
    drop(master);
}

#[test]
fn osc_markers_pass_through_intact() {
    let PtyProcess { reader, mut writer, mut child, master: _master, .. } = spawn_bash();
    let rx = pump(reader);
    let mut out = Vec::new();

    read_until(&rx, &mut out, "READY> ");
    // printf сам собирает ESC и BEL, так что в эхо набранной строки их нет — только в выводе.
    writer.write_all(b"printf '\\033]133;C\\007x\\033]133;D;0\\007'\r").unwrap();
    read_until(&rx, &mut out, "\x1b]133;D;0\x07");
    assert!(String::from_utf8_lossy(&out).contains("\x1b]133;C\x07x"));

    writer.write_all(b"exit\r").unwrap();
    child.wait().unwrap();
}

#[test]
fn resize_and_kill_work() {
    let PtyProcess { reader, master, killer, mut child, writer: _writer, .. } = spawn_bash();
    let rx = pump(reader);
    let mut out = Vec::new();
    read_until(&rx, &mut out, "READY> ");

    master
        .resize(portable_pty::PtySize { rows: 40, cols: 100, pixel_width: 0, pixel_height: 0 })
        .expect("resize");
    assert_eq!(master.get_size().unwrap().cols, 100);

    let mut killer = killer;
    killer.kill().expect("kill");
    assert!(!child.wait().expect("wait").success());
}
