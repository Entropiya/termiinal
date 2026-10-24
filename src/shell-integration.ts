// Строка внедрения shell integration для bash — ровно то, что по ТЗ впечатывается
// в уже открытую интерактивную сессию (разд. "Интеграция с шеллом и нарезка на блоки").
//
// Важно: это одна ЛОГИЧЕСКАЯ строка без переносов — если отправить в pty байт \n/\r
// посреди неё, bash воспримет это как отдельный Enter и разобьёт внедрение на
// несколько записей истории, что прямо противоречит требованию "самоудаляется из
// истории одной строкой". Поэтому все команды внутри соединены через `;`.
//
// Что проверяет этап 1, глядя на эту строку:
// - OSC 133 A/B вокруг старого PS1 — не затирают исходный проmpt;
// - OSC 633 E берёт текст команды из `history 1`, то есть то, что bash реально
//   записал в историю после Tab-дополнения/редактирования/стрелки вверх, а не то,
//   что было нажато посимвольно;
// - OSC 133 D;$? — через обёртку PROMPT_COMMAND, которая ПЕРВЫМ делом сохраняет $?
//   и только потом исполняет старый PROMPT_COMMAND. Это отступление от буквального
//   "дописать в хвост" из ТЗ: если дописать в хвост как есть, старый PROMPT_COMMAND
//   (или даже просто `local ec=$?`) успевает затереть $? до того, как мы его прочитаем.
//   Реальный порядок обязан сохранять исходный $? первым действием — находка этапа 1,
//   see docs/stage1.md.
// - самоудаление из истории — `history -d` на номер собственной записи, вычисленный
//   из `history 1` (bash кладёт строку в историю до выполнения).

// ВАЖНО: здесь нарочно НЕТ настоящего байта ESC (0x1b). Строка ниже — это текст,
// который мы ПЕЧАТАЕМ в bash как есть (см. шапку файла — это именно вводимые
// символы, а не вывод шелла). Если положить сюда настоящий ESC-байт, он будет
// отправлен в pty как часть "набираемой" строки, и эхо этой строки (точно такой
// же поток байт, что и любой вывод) заставит терминал — xterm.js, наш собственный
// `registerOscHandler`, или даже readline на удалённой стороне — воспринять его
// как настоящую управляющую последовательность и съесть, вместо того чтобы просто
// показать как текст. Отсюда и реально наблюдавшийся баг: кусок с `033]…` пропадал
// из эха на глазах, а следующая строка ввода задваивалась (сломанный подсчёт
// ширины промпта из-за ободранных `\[ \]`).
// Решение — писать ESC как ОБЫЧНЫЙ печатаемый текст `\e` (bash: "\e" — экранный
// символ в PS1/PS2, см. `man bash` / PROMPTING; printf: `\e` — тот же символ в
// формат-строке). И bash, и printf превращают этот текст в настоящий ESC-байт
// только КОГДА ОН ИМ РЕАЛЬНО НУЖЕН — то есть при показе промпта или при вызове
// printf, а не в момент, когда строка с его ОПРЕДЕЛЕНИЕМ вводится/эхуется.
const ESC = "\\e";
const ST = ESC + "\\\\"; // текст "\e\\" — ESC, затем один обратный слэш (терминатор OSC)

export function buildIntegrationLine(): string {
  const parts = [
    // Сохранить то, что уже стояло в PS1/PROMPT_COMMAND, до перезаписи.
    `__tm_old_ps1="$PS1"`,
    `__tm_old_pc="$PROMPT_COMMAND"`,

    // OSC 633 E (текст команды) + OSC 133 C (начало выполнения), из PS0.
    // PS0 печатается ОДИН раз сразу после Enter, до запуска команды — то, что надо,
    // в отличие от `trap DEBUG`, который срабатывает на каждую простую команду
    // внутри конвейера/логического И (`a && b` дал бы два события вместо одного).
    `__tm_cmd_start() { printf '${ESC}]633;E;%s${ST}${ESC}]133;C${ST}' "$(HISTTIMEFORMAT= history 1 | sed -E 's/^[[:space:]]*[0-9]+[[:space:]]+//')"; }`,
    `PS0='$(__tm_cmd_start)'`,

    // OSC 133 D;$? (код возврата) + OSC 7 (cwd), из PROMPT_COMMAND.
    // $? сохраняется ПЕРВЫМ действием функции — см. комментарий в шапке файла.
    `__tm_prompt_cmd() { local ec=$?; if [ -n "$__tm_old_pc" ]; then eval "$__tm_old_pc"; fi; printf '${ESC}]133;D;%s${ST}' "$ec"; printf '${ESC}]7;file://%s%s${ST}' "$(hostname)" "$PWD"; }`,
    `PROMPT_COMMAND=__tm_prompt_cmd`,

    // OSC 133 A/B вокруг старого PS1 — сам PS1 не трогаем, только оборачиваем.
    // \[ \] — это служебная нотация bash "здесь непечатаемая последовательность",
    // нужна для правильного подсчёта длины строки при переносе, это не часть OSC.
    `PS1='\\[${ESC}]133;A${ST}\\]'"$__tm_old_ps1"'\\[${ESC}]133;B${ST}\\]'`,

    // Самоудаление из истории: номер собственной записи только что добавлен bash
    // до выполнения этой строки, поэтому `history 1` в момент исполнения — это она сама.
    `history -d $(history 1 | awk '{print $1}')`,
  ];

  // Ведущий пробел — на случай если у пользователя уже стоит HISTCONTROL=ignorespace
  // (тогда строка вообще не попадёт в историю); гарантия, впрочем, не в этом, а в
  // явном history -d выше, который не зависит от HISTCONTROL.
  return " " + parts.join("; ");
}

// ===== PowerShell =====
//
// В PowerShell нет PS0/PROMPT_COMMAND, поэтому те же OSC 133/633/7 даём иначе (по образцу
// интеграции VS Code):
//   - функция `prompt` оборачивается: перед печатью промпта шлёт D;код (по истории: если появилась
//     новая запись) и OSC 7 (cwd), а саму строку промпта окружает A/B;
//   - `PSConsoleHostReadLine` (PSReadLine) оборачивается: после ввода строки шлёт E;текст и C.
// Скрипт НЕ печатается в сессию, а передаётся при запуске через `-EncodedCommand` (base64 UTF-16LE):
// нет эха, нет проблем с кавычками и политикой выполнения скриптов (она касается только файлов).
// Совместимо с Windows PowerShell 5.1: без `e, тернарных операторов и `&&`; ESC/BEL — через [char].
const POWERSHELL_INTEGRATION = String.raw`
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}
Set-Location -Path $HOME
$global:__tm_lastId = -1
$global:__tm_origPrompt = $function:prompt
function global:__tm_clean([string]$s) { $s -replace '[\x00-\x1f]', ' ' }
function global:prompt {
  $ok = $?
  $lec = $global:LASTEXITCODE
  $esc = [char]27
  $bel = [char]7
  $r = ''
  $h = Get-History -Count 1
  if ($h -and ($h.Id -ne $global:__tm_lastId)) {
    $global:__tm_lastId = $h.Id
    $code = 0
    if (-not $ok) { $code = 1; if (($lec -is [int]) -and ($lec -ne 0)) { $code = $lec } }
    $r += "$esc]133;D;$code$bel"
  }
  if ($PWD.Provider.Name -eq 'FileSystem') {
    $r += "$esc]7;file://$($env:COMPUTERNAME)/" + ($PWD.Path -replace '\\', '/') + $bel
  }
  [Console]::Write($r)
  $global:LASTEXITCODE = $lec
  $p = & $global:__tm_origPrompt
  "$esc]133;A$bel$p$esc]133;B$bel"
}
if ((Get-Module -Name PSReadLine) -and $function:PSConsoleHostReadLine) {
  $global:__tm_origReadLine = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine {
    $line = & $global:__tm_origReadLine
    if ($line -and ($line.Trim().Length -gt 0)) {
      [Console]::Write(([string][char]27) + ']633;E;' + (__tm_clean $line) + ([string][char]7) + ([string][char]27) + ']133;C' + ([string][char]7))
    }
    $line
  }
}
`;

export function buildPowerShellIntegrationScript(): string {
  return POWERSHELL_INTEGRATION.trim().replace(/\r?\n/g, "\n");
}

/** Скрипт в формате `powershell -EncodedCommand`: base64 от UTF-16LE. */
export function encodePowerShellCommand(script: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes.push(c & 0xff, c >> 8);
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Аргументы запуска локального Windows PowerShell с интеграцией. */
export function powerShellArgs(): string[] {
  return ["-NoLogo", "-NoExit", "-EncodedCommand", encodePowerShellCommand(buildPowerShellIntegrationScript())];
}
