# terminal-mentor

Десктоп-терминал для Windows с ИИ-наставником: агент видит блоки «команда → вывод → код возврата»
через shell integration (OSC 133/633), но ничего не выполняет сам — команды вводит и жмёт Enter
пользователь. Полное ТЗ: [docs/tz.md](docs/tz.md).

## Статус

Этап 1 — прототип рисков (см. [docs/stage1.md](docs/stage1.md)). UI пока не строим: сначала
проверяем, что ConPTY не ломает OSC-маркеры, что текст команды из `OSC 633 E` совпадает с реально
выполненной командой, что внедряемая строка не остаётся в истории шелла, и что headless-рендер
xterm даёт чистый текст на `apt`/`docker pull`.

## Стек

Tauri (Rust) + xterm.js/@xterm/headless + portable-pty (ConPTY) + `ssh.exe`. Подробности — в ТЗ.

Скаффолд создан через `npm create tauri-app@latest` (шаблон `vanilla-ts`). Стандартный
Tauri-темплейт описан в [src-tauri/README.md](src-tauri) и в комментариях шаблона — здесь только
то, что специфично для этого проекта.

## Разработка

```powershell
npm install
npm run tauri dev
```
