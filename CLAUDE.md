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

## Агенты и модели

- Адаптеры за одним интерфейсом `agent_start/agent_send/agent_stop` (`src-tauri/src/agent.rs`):
  `claude` — живой процесс `claude -p`; `codex` — ChatGPT через Codex CLI с входом пользователя
  (`src-tauri/src/codex.rs`, ключ не нужен, на ПК должны быть `codex` и `codex login`); `openai` — ChatGPT
  по API-ключу (`openai.rs`, `OPENAI_API_KEY`, в интерфейсе не предлагается). Все эмитят события в формате
  Claude stream-json, поэтому фронтенд (`src/agent.ts`) один. Список моделей — `src/models.ts`; в UI
  кнопка «Запустить/Остановить» и меню «⋯» (модель, режим, политика) в шапке чата.
- **Codex изолирован слабее Claude, и это не лечится конфигом** (проверено на codex 0.164 настоящими
  запросами к мок-серверу): основные инструменты (`exec`, мультиагентные) не отключаются, вызов `exec`
  реально исполняется, а `--json` о нём молчит. Поэтому: `-s read-only` (запись и сеть запрещены, чтение
  файлов нет), пустая временная папка, `--ignore-user-config`, наш промпт вместо встроенного
  (`model_instructions_file`), и предупреждение в чате при каждом старте. Не убирай эти меры и не
  называй Codex-адаптер изолированным. Проверка: `src-tauri/tests/codex_mock.rs` (настоящий Codex против
  мок-сервера; без `codex` в PATH/`CODEX_BIN` пропускается, в CI Ubuntu его ставит `npm i -g @openai/codex`).
- **Поведение обеих моделей задаёт один файл — `src/system-prompt.md`** (контракт ответа: первая
  строка-итог, `SKIP`, блоки `bash`/`plan`/`mermaid`; разбор — `src/agent-contract.ts`). Не клади
  правила поведения агента в `CLAUDE.md`, код адаптеров или промпты в UI. Claude запускается с
  `--system-prompt` + `--setting-sources ""`, чтобы не подхватывать этот `CLAUDE.md`.
- **Режим обучения** (по умолчанию) — второй файл поведения, `src/system-prompt-teaching.md`: лесенка
  подсказок (наводка → направление → решение) вместо готовой команды, одна идея за ответ, маленькая
  практика, блок `rule` (копится в списке «Правила», `src/playbook.ts`), «предлагай, не приказывай».
  «Прямой ответ» — только основа. Промпт собирает `buildSystemPrompt` (`src/prompts.ts`); смена режима,
  как и модели, перезапускает сессию агента. Идея взята из Claudemy (https://github.com/assafkip/claudemy,
  MIT, Assaf Kipnis): без аудио, скрейпинга и курса, берутся только принципы дизайна урока.
  Править поведение — в этих `.md`, потом прогнать вживую `python3 scripts/live-prompt-check.py teach`
  (нужен вход в `claude`, в CI не запускается; слабые модели игнорируют правила без образцов ответа).
- Новая модель — строка в `MODELS` (`src/models.ts`); новый провайдер — ветка в `agent_start` и тесты
  по образцу `openai.rs`/`codex_mock.rs` (мок-сервер, наш промпт без изменений, проверка инструментов
  по настоящему запросу, а не по `debug prompt-input`: он показывает не всё).

## Локальные шеллы и интеграция с блоками

- Блоки строятся из OSC 133/633/7. Для bash/ssh интеграцию печатают строкой в сессию
  (`buildIntegrationLine`), для **локального Windows PowerShell** (`powershell.exe`, кнопка в лаунчере)
  она передаётся при запуске через `-EncodedCommand` (`powerShellArgs()` в `src/shell-integration.ts`):
  обёртка `prompt` шлёт D/7/A/B, обёртка `PSConsoleHostReadLine` шлёт E/C. Скрипт должен работать в
  Windows PowerShell 5.1: без `` `e ``, `&&`, `??`, тернарных операторов (тест это проверяет).
- Проверка: `src/pty-powershell.integration.test.ts` (настоящий `pwsh` под PTY; тест сам играет терминал и
  отвечает на `ESC[6n`, без ответа PowerShell молчит; пропускается без `pwsh`, `PWSH_BIN` задаёт путь) и
  e2e на Windows (там именно 5.1).
- В сессии PowerShell агент получает `активная сессия: PowerShell`, команды у него в блоке `powershell`
  (контракт и `system-prompt.md` это знают), а проверка вставки знает опасные команды PowerShell.

## Что на Linux НЕ проверяется

- ConPTY (`ConPtyBackend`), поведение git-bash/MSYS, `ssh.exe`, `taskkill` в `agent_stop`.
- Само окно, WebView2, e2e-сценарий (клик → ввод → блок).
- Установщик, автообновление, подпись.
- Живой ответ ChatGPT (нужен вход в Codex; тесты идут на мок-сервере) и сценарий первого входа по ssh (`yes/no`) в настоящем окне.

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
