# termiinal

Tauri 2 приложение под Windows: терминал с ConPTY-бэкендом, нарезкой вывода на блоки
(OSC 133/633/7, парсинг на `@xterm/headless`) и агентом Claude. Фронт — TypeScript/Vite
(`src/`), бэкенд — Rust (`src-tauri/`). Живёт на Windows; разработка идёт в Linux-виртуалке,
где окно приложения не запустить.

## Тесты

Из корня репозитория:

```bash
npm test             # всё: vitest + cargo test
npm run test:ts      # только vitest (src/*.test.ts)
npm run test:rust    # только cargo test (src-tauri)
npm run build        # tsc + vite build — гонять тоже, tsc ловит то, что vitest пропускает
```

Окружение на чистой Linux-машине: `scripts/setup-linux.sh` (apt-зависимости Tauri,
`npm ci`, сборка фронта). `cargo test` требует каталог `dist/` (`tauri::generate_context!`),
`npm run test:rust` создаёт его сам.

Что где лежит:

- `src/osc-blocks.test.ts`, `shell-integration.test.ts`, `paste-guard.test.ts`, … — юнит-тесты логики.
- `src/pty-bash.integration.test.ts` — настоящий bash под PTY → `BlockBuilder`. Только Linux/macOS;
  собирает и запускает `src-tauri/examples/pty_capture.rs`.
- `src-tauri/tests/pty_unix.rs` — Unix PTY-бэкенд на bash (`cfg(unix)`).
- `src-tauri/tests/pty_windows.rs` — ConPTY на `cmd.exe` (`cfg(windows)`).
- `e2e/` — WebdriverIO + tauri-driver, **только Windows** (в CI). Свой `package.json`.

## Что на Linux НЕ проверяется

- ConPTY (`ConPtyBackend`), поведение git-bash/MSYS, `ssh.exe`, `taskkill` в `agent_stop`.
- Само окно, WebView2, e2e-сценарий (клик → ввод → блок).
- Установщик, автообновление, подпись.

Windows-ветки кода хотя бы type-check'ятся из Linux:
`rustup target add x86_64-pc-windows-gnu && sudo apt-get install gcc-mingw-w64-x86-64`, затем
`cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --lib --tests --examples`.
Это ловит ошибки типов, но не поведение.

## Правила работы

1. **После изменений гоняй `npm test` и `npm run build` локально в виртуалке.** Не пушить с красным.
2. **Перед завершением задачи дождись зелёного Windows-CI** (workflow `CI`, джоб «Windows — сборка,
   тесты, e2e») на последнем пуше ветки. Зелёного Ubuntu недостаточно: он не видит ConPTY и e2e.
3. Если CI красный — читай лог, чини, пушь, жди снова. Не отключай и не пропускай тесты ради зелёного.
4. Правка PTY-кода (`src-tauri/src/pty*.rs`) — проверь Windows-ветку через `cargo check --target …`
   (см. выше) и всё равно дождись Windows-CI.

## Как читать CI из сессии

GitHub MCP (`mcp__github__*`; `gh` и прямого API нет):

- `actions_list` `list_workflow_runs` (`resource_id: ci.yml`, `perPage: 1`) — последний запуск и его статус.
- `actions_list` `list_workflow_jobs` — шаги джоба и какой упал.
- `get_job_logs` с `run_id` + `failed_only: true` — логи упавших джобов; для полного хвоста бери
  `job_id` и `tail_lines`. У `failed_only` хвост может обрезать сообщение паники — тогда по `job_id`.
- Ждать нужно по таймеру (`send_later` ~10 минут): Windows-джоб идёт 5–10 минут.

Артефакты CI (`actions/upload-artifact`) из виртуалки **не скачать**: хост хранилища
(`*.blob.core.windows.net`) закрыт прокси. Поэтому при падении e2e шаг «Print e2e logs» печатает
`tauri-driver.log`, `app.log`, `*.dom.json` (статус, блоки, текст терминала) прямо в лог джоба.

## Особенности e2e

- Приложение запускает сам сценарий (`e2e/wdio.conf.mjs`) и цепляется к его WebView2 по
  `ms:edgeOptions.debuggerAddress` (порт 9222). Штатный режим «tauri-driver запускает exe» тут не
  работает: приложение задаёт свои `AdditionalBrowserArguments`, а встроенный WebView2 при явном порте
  не пишет `DevToolsActivePort`, которого ждёт msedgedriver.
- Порт отладки включён только в тестовой сборке: `src-tauri/tauri.ci.conf.json`
  (`additionalBrowserArgs`), подмешивается флагом `--config` в CI. Релиз его не содержит.
- WebDriver `getText()` у невидимых/свёрнутых элементов пуст — читай DOM через `browser.execute`.
- `msedgedriver` ставится `msedgedriver-tool` под версию WebView2 на раннере.
- Тесты ConPTY: `conhost` шлёт `ESC[6n` и молчит, пока не получит ответ (в приложении отвечает
  xterm.js, в тесте — сам тест). И не дропай `master` до конца теста, иначе псевдоконсоль закроется.

## Релиз

Тег `v*` запускает `.github/workflows/release.yml` (Windows-инсталлятор, подпись обновлений).
Он не зависит от `ci.yml`.
