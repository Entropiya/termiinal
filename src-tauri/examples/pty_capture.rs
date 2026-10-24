// Тестовый помощник: запускает программу под PTY-бэкендом, "печатает" в неё строки из
// stdin (с паузой между строками) и пишет в stdout сырой байтовый вывод PTY до выхода
// процесса. Нужен интеграционному тесту на TS (src/pty-bash.integration.test.ts), чтобы
// прогнать настоящий вывод bash через BlockBuilder.
//
// Использование: pty_capture <line-delay-ms> <program> [args...] < строки-для-ввода

use std::io::{BufRead, Read, Write};
use std::time::{Duration, Instant};
use termiinal_lib::pty_backend::{default_backend, PtyProcess, SpawnSpec};

fn main() {
    let mut argv = std::env::args().skip(1);
    let delay = Duration::from_millis(argv.next().expect("delay").parse().expect("delay ms"));
    let program = argv.next().expect("program");

    let PtyProcess { mut reader, mut writer, mut child, killer, master } = default_backend()
        .spawn(&SpawnSpec {
            program,
            args: argv.collect(),
            cwd: None,
            env: Default::default(),
            cols: 120,
            rows: 40,
        })
        .expect("spawn");

    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let mut stdout = std::io::stdout().lock();
    let mut drain = |wait: Duration| {
        let until = Instant::now() + wait;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(chunk) => stdout.write_all(&chunk).unwrap(),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return true,
                Err(_) => return false, // читалка закрылась — процесс завершился
            }
        }
    };

    drain(Duration::from_millis(800)); // дать шеллу дойти до первого промпта
    for line in std::io::stdin().lock().lines() {
        writer.write_all(line.unwrap().as_bytes()).unwrap();
        writer.write_all(b"\r").unwrap();
        writer.flush().unwrap();
        if !drain(delay) {
            break;
        }
    }
    // Хвост: ждём выхода процесса (тест кончает ввод командой exit), но не вечно.
    let deadline = Instant::now() + Duration::from_secs(10);
    while drain(Duration::from_millis(200)) && Instant::now() < deadline {}
    let mut killer = killer;
    let _ = killer.kill();
    let _ = child.wait();
    drop(master);
}
