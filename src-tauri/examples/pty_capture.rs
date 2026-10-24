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

    // Режим PTY_CAPTURE_RAW: stdin -> в PTY как есть, вывод PTY -> в stdout сразу. Тест на TS сам играет
    // терминал (xterm.js отвечает на запросы позиции курсора), а здесь только труба до настоящего PTY.
    if std::env::var("PTY_CAPTURE_RAW").is_ok() {
        let writer = std::sync::Arc::new(std::sync::Mutex::new(writer));
        let w = writer.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut stdin = std::io::stdin().lock();
            while let Ok(n) = stdin.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut w = w.lock().unwrap();
                if w.write_all(&buf[..n]).and_then(|_| w.flush()).is_err() {
                    break;
                }
            }
        });
        let mut out = std::io::stdout().lock();
        while let Ok(chunk) = rx.recv() {
            if out.write_all(&chunk).and_then(|_| out.flush()).is_err() {
                break;
            }
        }
        let mut killer = killer;
        let _ = killer.kill();
        let _ = child.wait();
        drop(master);
        return;
    }

    let mut stdout = std::io::stdout().lock();
    // Настоящий терминал (xterm.js в приложении) отвечает на запрос позиции курсора ESC[6n; PowerShell
    // без ответа не печатает ничего. Эмулируем ответ, иначе вывода не будет.
    let mut drain = |wait: Duration, writer: &mut dyn Write| {
        let until = Instant::now() + wait;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(chunk) => {
                    if chunk.windows(4).any(|w| w == b"\x1b[6n") {
                        let _ = writer.write_all(b"\x1b[1;1R");
                        let _ = writer.flush();
                    }
                    stdout.write_all(&chunk).unwrap()
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return true,
                Err(_) => return false, // читалка закрылась — процесс завершился
            }
        }
    };

    // дать шеллу дойти до первого промпта (PowerShell стартует заметно дольше bash)
    let initial: u64 = std::env::var("PTY_CAPTURE_INITIAL_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(800);
    drain(Duration::from_millis(initial), &mut writer);
    for line in std::io::stdin().lock().lines() {
        writer.write_all(line.unwrap().as_bytes()).unwrap();
        writer.write_all(b"\r").unwrap();
        writer.flush().unwrap();
        if !drain(delay, &mut writer) {
            break;
        }
    }
    // Хвост: ждём выхода процесса (тест кончает ввод командой exit), но не вечно.
    let deadline = Instant::now() + Duration::from_secs(10);
    while drain(Duration::from_millis(200), &mut writer) && Instant::now() < deadline {}
    let mut killer = killer;
    let _ = killer.kill();
    let _ = child.wait();
    drop(master);
}
