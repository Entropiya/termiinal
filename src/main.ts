import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { spawnPty, type PtyHandle } from "./pty";
import { BlockBuilder, type Block, type OscLogEntry } from "./osc-blocks";
import { buildIntegrationLine } from "./shell-integration";
import { startAgent, type AgentHandle } from "./agent";
import { redactSecrets } from "./redact";
import { shouldSendBlock, formatBlocksForAgent, DEFAULT_BLACKLIST, type AgentPolicy } from "./block-agent";
import { parseAgentResponse } from "./agent-contract";
import { renderAgentMarkdown } from "./render-markdown";
import { loadPresets, upsertPreset, removePreset, type ConnectionPreset } from "./presets";
import { buildProbeCommand, ProbeCapture, type ProbeResult } from "./host-probe";
import systemPrompt from "./system-prompt.md?raw";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const DEFAULT_SSH_KEY = "C:\\Users\\Pakochka\\.ssh\\id_ed25519";

const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const btnMode = document.querySelector<HTMLButtonElement>("#btn-mode")!;
const shellEl = document.querySelector<HTMLElement>(".shell")!;
const btnSpawn = document.querySelector<HTMLButtonElement>("#btn-spawn")!;
const btnSsh = document.querySelector<HTMLButtonElement>("#btn-ssh")!;
const presetSelectEl = document.querySelector<HTMLSelectElement>("#preset-select")!;
const presetNameEl = document.querySelector<HTMLInputElement>("#preset-name")!;
const presetUserEl = document.querySelector<HTMLInputElement>("#preset-user")!;
const presetHostEl = document.querySelector<HTMLInputElement>("#preset-host")!;
const presetPortEl = document.querySelector<HTMLInputElement>("#preset-port")!;
const presetKeyEl = document.querySelector<HTMLInputElement>("#preset-key")!;
const btnPresetSave = document.querySelector<HTMLButtonElement>("#btn-preset-save")!;
const btnPresetDelete = document.querySelector<HTMLButtonElement>("#btn-preset-delete")!;
const btnIntegrate = document.querySelector<HTMLButtonElement>("#btn-integrate")!;
const btnHistory = document.querySelector<HTMLButtonElement>("#btn-history")!;
const btnProgress = document.querySelector<HTMLButtonElement>("#btn-progress")!;
const btnKill = document.querySelector<HTMLButtonElement>("#btn-kill")!;
const blocksEl = document.querySelector<HTMLDivElement>("#blocks")!;
const oscLogEl = document.querySelector<HTMLDivElement>("#osc-log")!;
const checklistEl = document.querySelector<HTMLUListElement>("#checklist")!;

const btnAgentStart = document.querySelector<HTMLButtonElement>("#btn-agent-start")!;
const btnAgentStop = document.querySelector<HTMLButtonElement>("#btn-agent-stop")!;
const agentPolicyEl = document.querySelector<HTMLSelectElement>("#agent-policy")!;
const btnGlance = document.querySelector<HTMLButtonElement>("#btn-glance")!;
const agentStatusEl = document.querySelector<HTMLSpanElement>("#agent-status")!;
const agentDotEl = document.querySelector<HTMLSpanElement>("#agent-dot")!;

function setAgentDot(state: "off" | "starting" | "on" | "error") {
  agentDotEl.className = `dot dot-${state}`;
}
const chatLogEl = document.querySelector<HTMLDivElement>("#chat-log")!;
const chatFormEl = document.querySelector<HTMLFormElement>("#chat-form")!;
const chatInputEl = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
const chatSendEl = document.querySelector<HTMLButtonElement>("#chat-send")!;

const CHECKLIST: { id: string; text: string }[] = [
  { id: "osc-intact", text: "OSC 133/633/7 доходят целыми через ConPTY (см. блоки и OSC-лог)" },
  { id: "cmd-text", text: "Текст команды (OSC 633 E) совпадает с реально выполненной после Tab/↑" },
  { id: "history-clean", text: "Строка интеграции самоудалилась из истории (history)" },
  { id: "redraw-clean", text: "Headless-рендер даёт чистый текст при \\r-перерисовке (прогресс-бар)" },
];

for (const item of CHECKLIST) {
  const li = document.createElement("li");
  li.className = "pending";
  li.dataset.id = item.id;
  li.textContent = item.text;
  li.title = "Клик — отметить как проверено вручную";
  li.addEventListener("click", () => {
    li.classList.toggle("ok");
    li.classList.toggle("pending");
  });
  checklistEl.appendChild(li);
}

const term = new Terminal({
  fontFamily: "'Cascadia Code', Consolas, monospace",
  fontSize: 14,
  cursorBlink: true,
  allowProposedApi: true,
  theme: {
    background: "#16161a",
    foreground: "#e3e3e6",
    cursor: "#5aa8ff",
    selectionBackground: "#5aa8ff55",
  },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.querySelector<HTMLDivElement>("#xterm")!);
fitAddon.fit();

// Копирование выделенного текста — своего буфера обмена у xterm.js нет, браузер его
// не даёт просто так. Копируем автоматически по выделению (как в большинстве
// терминалов) и по Ctrl+C, если что-то выделено (иначе Ctrl+C должен уйти в шелл как ^C).
term.onSelectionChange(() => {
  const sel = term.getSelection();
  if (sel) navigator.clipboard.writeText(sel).catch(() => {});
});
term.attachCustomKeyEventHandler((event) => {
  if (event.type === "keydown" && event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
    const sel = term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel).catch(() => {});
      return false; // подавляем отправку ^C в шелл, раз это было копирование
    }
  }
  // Ctrl+Shift+Space — переключатель адресата ввода (ТЗ: дополнительный способ, и
  // единственный рабочий в шеллах без интеграции/OSC-детекции пустого промпта).
  if (event.type === "keydown" && event.ctrlKey && event.shiftKey && event.code === "Space") {
    toggleAddressTarget();
    return false;
  }
  if (event.type === "keydown" && event.ctrlKey && event.shiftKey && event.code === "KeyM") {
    cycleUiMode();
    return false;
  }
  return true;
});

// ===== Режимы интерфейса (ТЗ, разд. "Режимы интерфейса") — MVP: только "Чат" и
// "Терминал", без "Сплита" (это следующий этап); Ctrl+Shift+M переключает по кругу. =====
type UiMode = "terminal" | "chat";
let uiMode: UiMode = "terminal";
const MODE_LABELS: Record<UiMode, string> = { terminal: "Терминал", chat: "Чат" };

function setUiMode(mode: UiMode) {
  uiMode = mode;
  shellEl.dataset.mode = mode;
  btnMode.textContent = `Режим: ${MODE_LABELS[mode]}`;
}

function cycleUiMode() {
  setUiMode(uiMode === "terminal" ? "chat" : "terminal");
}

btnMode.addEventListener("click", cycleUiMode);
setUiMode(uiMode);

// Ctrl+Shift+M должен работать и когда фокус в чате (textarea), не только в терминале.
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey && e.shiftKey && e.code === "KeyM")) return;
  // Фокус внутри xterm уже обработан через attachCustomKeyEventHandler выше —
  // пропускаем здесь, иначе сработает дважды подряд.
  if (document.getElementById("xterm")?.contains(document.activeElement)) return;
  e.preventDefault();
  cycleUiMode();
});

let pty: (PtyHandle & { dispose(): void }) | null = null;
let blockBuilder: BlockBuilder | null = null;

// ===== Политика "блок -> агент" (ТЗ, разд. "Когда вызывается агент") =====
let agentPolicy: AgentPolicy = "auto";
const blacklist = new Set(DEFAULT_BLACKLIST);
let agentBusy = false;
let pendingBlockQueue: Block[] = [];
let pendingKind: "chat" | "blocks" | null = null;
let pendingBlocksCount = 0;
let pendingBatch: Block[] = [];
let lastClosedBlock: Block | null = null;
let currentSessionLabel: string | null = null;
let sessionOsInfo: { osId: string | null; osVersionId: string | null } | null = null;
let probeCapture: ProbeCapture | null = null;

// ===== Кому адресован ввод (ТЗ, разд. "Режимы интерфейса") =====
//
// Основной способ — набрать "! " (восклицательный знак и пробел) первым делом на пустом
// промпте: уходит в чат, а не в шелл. "!!"/"!ls" без пробела — обычная history expansion
// bash, должны дойти до шелла как есть. Поскольку оба случая начинаются с одного и того
// же символа "!", различить их можно только по ВТОРОМУ символу — отсюда "придержка" на
// один символ ниже: сама "!" никуда не уходит, пока не увидим, пробел за ней или нет.
let primingBang = false;

function switchFocusToChat() {
  if (!chatInputEl.disabled) chatInputEl.focus();
}

/** Ctrl+Shift+Space — дополнительный способ (и единственный, когда интеграции нет:
 * тогда atPromptStart никогда не станет true, а "! " сам по себе ничего не перехватит). */
function toggleAddressTarget() {
  if (document.activeElement === chatInputEl) term.focus();
  else switchFocusToChat();
}

function setAddressIndicator(target: "term" | "chat") {
  document.querySelector(".pane-term")?.classList.toggle("addressing", target === "term");
  document.querySelector(".pane-chat")?.classList.toggle("addressing", target === "chat");
}

document.addEventListener("focusin", (e) => {
  const t = e.target as HTMLElement;
  if (t === chatInputEl) setAddressIndicator("chat");
  else if (document.getElementById("xterm")?.contains(t)) setAddressIndicator("term");
});

/** true, если данные обработаны здесь и в pty уходить не должны. */
function handleAgentPrefixInput(data: string): boolean {
  if (primingBang) {
    primingBang = false;
    if (data === " ") {
      switchFocusToChat();
      return true; // ни "!", ни пробел в шелл не уходят вообще
    }
    // не пробел — это была history expansion ("!!", "!42", "!ls"...), досылаем
    // придержанный "!" и этот символ одним куском, раз уж не отправили раньше.
    pty?.write("!" + data);
    return true;
  }
  if (blockBuilder?.atPromptStart && data === "!") {
    primingBang = true;
    return true; // придержали; ничего не рисуем сами — и реальный шелл, и мы молчим,
    // пока не увидим следующий символ (иначе рисковали бы задвоить эхо с тем, что
    // потом всё равно пришлёт сам шелл при досылке).
  }
  return false;
}

term.onData((data) => {
  if (!handleAgentPrefixInput(data)) pty?.write(data);
});

function handleProbeResult(r: ProbeResult | null) {
  probeCapture = null;
  if (!r) return;
  sessionOsInfo = { osId: r.osId, osVersionId: r.osVersionId };
  // "им по умолчанию называется пресет" (ТЗ) — только если пользователь ещё не вписал
  // своё имя вручную, не перетираем уже набранное.
  if (r.hostname && !presetNameEl.value.trim()) presetNameEl.value = r.hostname;
  addChatMessage(
    "system",
    `Проба хоста: шелл=${r.shellPath ?? "?"} хост=${r.hostname ?? "?"} ОС=${r.osId ?? "?"} ${r.osVersionId ?? ""}`.trim(),
  );
}

/** Короткая строка контекста, которую агент видит в КАЖДОМ сообщении (и блоке, и чате).
 * Без неё агент не знает, что перед ним — локальный Windows (Git Bash) или удалённый
 * Linux/Unix по ssh, и начинает советовать `ipconfig`/PowerShell там, где нужен `ip a`. */
function contextLine(): string {
  if (!currentSessionLabel) return "[Контекст] активной сессии в терминале нет.";
  const os = sessionOsInfo?.osId ? ` ОС: ${sessionOsInfo.osId} ${sessionOsInfo.osVersionId ?? ""}`.trim() : "";
  return `[Контекст] активная сессия: ${currentSessionLabel}.${os ? ` ${os}.` : ""}`;
}

agentPolicyEl.addEventListener("change", () => {
  agentPolicy = agentPolicyEl.value as AgentPolicy;
});

// Хоткей "глянь" (ТЗ: один на всё) — пока только случай "на закрытом блоке": форсирует
// отправку последнего блока в обход политики/чёрного списка. Случай "на незавершённом
// блоке -> снимок текущего экрана" — отдельная фича, требует доступа к живому буферу
// xterm.js посреди выполнения команды, сделаем отдельным шагом.
btnGlance.addEventListener("click", () => {
  if (!lastClosedBlock) return;
  pendingBlockQueue.push(lastClosedBlock);
  trySendPending();
});

const blockElements = new Map<number, HTMLDivElement>();

function renderBlock(b: Block) {
  const div = document.createElement("div");
  div.className = "block";
  div.innerHTML = `
    <div class="cmd">${escapeHtml(b.cmd ?? "(нет текста команды)")}</div>
    <div class="meta">exit=${b.exitCode ?? "?"} cwd=${escapeHtml(b.cwd ?? "?")} строки ${b.startRow}–${b.endRow}</div>
    <pre>${escapeHtml(b.output)}</pre>
  `;
  blocksEl.prepend(div);
  blockElements.set(b.id, div);
}

/** ТЗ, режим «Терминал»: "ответ агента прикреплён под своей командой... в свёрнутом виде
 * видна одна строка-итог... развёрнутый блок показывает полный разбор". Пачка блоков —
 * вешаем на последний блок пачки, остальные просто получают пометку "см. ниже". */
function attachResponseToBlock(batch: Block[], parsed: ReturnType<typeof parseAgentResponse>, rawText: string) {
  const target = batch[batch.length - 1];
  const el = target && blockElements.get(target.id);
  if (!el) return;

  const wrapper = document.createElement("div");
  wrapper.className = "block-reply";

  if (parsed.isSkip) {
    wrapper.classList.add("skip");
    wrapper.textContent = "▸ (нечего добавить — SKIP)";
    el.appendChild(wrapper);
    return;
  }

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "block-reply-summary";
  summary.textContent = `▸ ${parsed.summary || "(ответ агента)"}`;

  const detail = document.createElement("div");
  detail.className = "block-reply-detail collapsed";
  detail.innerHTML = renderAgentMarkdown(rawText);

  summary.addEventListener("click", () => detail.classList.toggle("collapsed"));

  wrapper.append(summary, detail);
  el.appendChild(wrapper);
}

function renderOsc(e: OscLogEntry) {
  const div = document.createElement("div");
  div.textContent = `OSC ${e.kind} ; ${e.raw}`;
  oscLogEl.prepend(div);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function spawnShell(
  label: string,
  program: string,
  args: string[],
  env?: Record<string, string>,
  probeAfterMs?: number,
) {
  statusEl.textContent = `${label}: запускается…`;
  currentSessionLabel = label;
  sessionOsInfo = null;
  probeCapture = null;
  const cols = term.cols;
  const rows = term.rows;

  blockBuilder = new BlockBuilder(cols, rows);
  blockBuilder.onBlockClosed = (b) => {
    renderBlock(b);
    lastClosedBlock = b;
    if (shouldSendBlock(agentPolicy, blacklist, b)) {
      pendingBlockQueue.push(b);
      trySendPending();
    }
  };
  blockBuilder.onOscEvent = renderOsc;

  pty = await spawnPty({
    program,
    args,
    env,
    cols,
    rows,
    onData: (bytes) => {
      // Пока идёт скрытая проба хоста — ни видимый терминал, ни headless-копия её не
      // видят. Обязательно решаем одинаково для обоих: иначе их буферы разойдутся по
      // номерам строк, на которых держится нарезка на блоки (см. BlockBuilder).
      if (probeCapture && !probeCapture.done) {
        probeCapture.feed(bytes);
        if (probeCapture.done) handleProbeResult(probeCapture.result());
        return;
      }
      term.write(bytes);
      blockBuilder?.feed(bytes);
    },
    onExit: (code) => {
      statusEl.textContent = `${label}: процесс завершён (код ${code ?? "?"})`;
      btnIntegrate.disabled = true;
      btnHistory.disabled = true;
      btnProgress.disabled = true;
      btnKill.disabled = true;
      btnSpawn.disabled = false;
      btnSsh.disabled = false;
      pty = null;
      currentSessionLabel = null;
      sessionOsInfo = null;
      probeCapture = null;
    },
  });

  statusEl.textContent = `сессия активна — ${label}`;
  btnIntegrate.disabled = false;
  btnHistory.disabled = false;
  btnProgress.disabled = false;
  btnKill.disabled = false;
  btnSpawn.disabled = true;
  btnSsh.disabled = true;
  term.focus();

  if (probeAfterMs !== undefined) {
    // Эвристика вместо честного "дождались пустого промпта" (та детекция — отдельная,
    // более поздняя фича): просто ждём немного, чтобы баннер логина и промпт успели
    // отрисоваться, прежде чем втихую впечатать пробу.
    setTimeout(() => {
      if (!pty) return;
      probeCapture = new ProbeCapture();
      pty.write(buildProbeCommand() + "\r");
    }, probeAfterMs);
  }
}

btnKill.addEventListener("click", () => {
  pty?.kill().catch((err) => {
    statusEl.textContent = `ошибка завершения: ${err}`;
  });
  // UI полностью сбросится по событию pty-exit (onExit выше), killer только просит
  // процесс завершиться — ждём подтверждения от wait-потока в Rust.
});

btnSpawn.addEventListener("click", () => {
  spawnShell("Git Bash", GIT_BASH, ["--login", "-i"], {
    // MSYS-рантайм git-bash по умолчанию не знает про ConPTY и ведёт себя так, будто
    // его вывод никуда не подключён как терминал — отсюда битые Tab/история/стрелки.
    // enable_pcon — задокументированный флаг MSYS2 именно для работы под ConPTY
    // (тот же трюк использует Windows Terminal для профиля Git Bash).
    MSYS: "enable_pcon",
    MSYS2_PTY: "1",
  }).catch((err) => {
    statusEl.textContent = `ошибка запуска: ${err}`;
  });
});

// ===== Пресеты подключений (ТЗ: "Подключения и пресеты") =====

function refreshPresetSelect(selectId = "") {
  const presets = loadPresets();
  presetSelectEl.innerHTML = '<option value="">— новое подключение —</option>';
  for (const p of presets) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    presetSelectEl.appendChild(opt);
  }
  presetSelectEl.value = selectId;
  btnPresetDelete.disabled = !selectId;
}

function currentFieldsAsPreset(id: string): ConnectionPreset {
  return {
    id,
    name: presetNameEl.value.trim() || `${presetUserEl.value}@${presetHostEl.value}`,
    user: presetUserEl.value.trim(),
    host: presetHostEl.value.trim(),
    port: presetPortEl.value.trim() ? Number(presetPortEl.value.trim()) : undefined,
    keyPath: presetKeyEl.value.trim() || undefined,
  };
}

function clearPresetFields() {
  presetNameEl.value = "";
  presetUserEl.value = "";
  presetHostEl.value = "";
  presetPortEl.value = "";
  presetKeyEl.value = DEFAULT_SSH_KEY;
}

presetSelectEl.addEventListener("change", () => {
  const id = presetSelectEl.value;
  btnPresetDelete.disabled = !id;
  if (!id) {
    clearPresetFields(); // иначе в полях остаются значения ранее выбранного пресета
    return;
  }
  const p = loadPresets().find((x) => x.id === id);
  if (!p) return;
  presetNameEl.value = p.name;
  presetUserEl.value = p.user;
  presetHostEl.value = p.host;
  presetPortEl.value = p.port ? String(p.port) : "";
  presetKeyEl.value = p.keyPath ?? DEFAULT_SSH_KEY;
});

btnPresetSave.addEventListener("click", () => {
  const id = presetSelectEl.value || crypto.randomUUID();
  const preset = currentFieldsAsPreset(id);
  if (!preset.user || !preset.host) {
    statusEl.textContent = "для пресета нужны хотя бы пользователь и хост";
    return;
  }
  upsertPreset(preset);
  refreshPresetSelect(id);
});

btnPresetDelete.addEventListener("click", () => {
  const id = presetSelectEl.value;
  if (!id) return;
  removePreset(id);
  refreshPresetSelect("");
  // Поля должны реально опустеть, а не остаться с данными только что удалённого
  // пресета — иначе визуально выглядит так, будто удаление не сработало.
  clearPresetFields();
});

refreshPresetSelect();

btnSsh.addEventListener("click", () => {
  const user = presetUserEl.value.trim();
  const host = presetHostEl.value.trim();
  if (!user || !host) {
    statusEl.textContent = "укажи пользователя и хост";
    return;
  }
  const port = presetPortEl.value.trim();
  const keyPath = presetKeyEl.value.trim() || DEFAULT_SSH_KEY;
  const target = `${user}@${host}`;
  const args = ["-i", keyPath];
  if (port) args.push("-p", port);
  args.push(target);
  // Без -o StrictHostKeyChecking — подтверждение отпечатка хоста при первом подключении
  // идёт через обычный диалог ssh прямо в терминале, как и описано в ТЗ.
  spawnShell("SSH " + target, "ssh.exe", args, undefined, 1200).catch((err) => {
    statusEl.textContent = `ошибка запуска: ${err}`;
  });
});

btnIntegrate.addEventListener("click", () => {
  const line = buildIntegrationLine();
  pty?.write(line + "\r");
});

btnHistory.addEventListener("click", () => {
  pty?.write("history\r");
});

btnProgress.addEventListener("click", () => {
  const cmd =
    "for i in $(seq 1 20); do printf '\\rprogress: %3d%%' \"$((i*5))\"; sleep 0.05; done; printf '\\n'; echo PROGRESS_DONE";
  pty?.write(cmd + "\r");
});

window.addEventListener("resize", () => {
  fitAddon.fit();
  const cols = term.cols;
  const rows = term.rows;
  pty?.resize(cols, rows);
  blockBuilder?.resize(cols, rows);
});

// ===== Агент (Claude) =====

let agent: AgentHandle | null = null;
let sessionCostUsd = 0;
let streamingDiv: HTMLDivElement | null = null;
let streamingText = "";

function addChatMessage(role: "user" | "agent" | "system", text: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  // Markdown рендерим только ответам агента — это единственное, что идёт по контракту
  // ответа (ТЗ). Текст самого пользователя и наши системные пометки — просто текст,
  // без интерпретации разметки (и без риска парсинга экранов/бэктиков как markdown).
  if (role === "agent") setAgentMessageHtml(div, text);
  else div.textContent = text;
  chatLogEl.appendChild(div);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  return div;
}

function setAgentMessageHtml(div: HTMLDivElement, text: string) {
  div.innerHTML = renderAgentMarkdown(text);
}

function setAgentActive(active: boolean) {
  btnAgentStart.disabled = active;
  btnAgentStop.disabled = !active;
  btnGlance.disabled = !active;
  updateChatInputEnabled();
}

function updateChatInputEnabled() {
  const enabled = agent !== null && !agentBusy;
  chatInputEl.disabled = !enabled;
  chatSendEl.disabled = !enabled;
}

/** Пачки (ТЗ: "если агент ещё думает над предыдущим блоком, новые блоки копятся в
 * очереди и уходят одним сообщением") — вызывается и при закрытии блока, и после
 * завершения текущего хода диалога, чтобы разгрузить очередь. */
function trySendPending() {
  if (agentBusy || !agent || pendingBlockQueue.length === 0) return;
  const batch = pendingBlockQueue;
  pendingBlockQueue = [];
  agentBusy = true;
  pendingKind = "blocks";
  pendingBlocksCount = batch.length;
  pendingBatch = batch;
  updateChatInputEnabled();
  const text = redactSecrets(`${contextLine()}\n\n${formatBlocksForAgent(batch)}`);
  agent.sendText(text).catch((err) => {
    addChatMessage("system", `⚠ ошибка отправки блока(ов): ${err}`);
    agentBusy = false;
    pendingKind = null;
    updateChatInputEnabled();
  });
}

btnAgentStart.addEventListener("click", async () => {
  agentStatusEl.textContent = "запускается…";
  setAgentDot("starting");
  try {
    agent = await startAgent({
      systemPrompt,
      // Самая дешёвая модель по умолчанию для MVP-стенда — реальный выбор модели
      // (и кнопка "тяжёлая модель на сложный разбор" из ТЗ) это отдельная фича этапа 3.
      model: "claude-haiku-5-5",
      maxBudgetUsd: 0.5,
      callbacks: {
        onInit: (e) => {
          const isolated = e.tools.length === 0 && e.mcp_servers.length === 0;
          setAgentDot(isolated ? "on" : "error");
          agentStatusEl.textContent = `${e.model} · изоляция: ${isolated ? "подтверждена (0 инструментов)" : `⚠ ${e.tools.length} инстр./${e.mcp_servers.length} MCP`} · $${sessionCostUsd.toFixed(4)}`;
          addChatMessage(
            "system",
            isolated
              ? "Сессия агента поднята, инструментов и MCP-серверов нет — подтверждено из system/init."
              : `⚠ Внимание: у агента есть доступные инструменты (${e.tools.join(", ") || "—"}) или MCP-серверы (${e.mcp_servers.length}). Изоляция не подтверждена.`,
          );
        },
        onTextDelta: (delta) => {
          if (!streamingDiv) {
            streamingDiv = addChatMessage("agent", "");
            streamingDiv.classList.add("streaming");
            streamingText = "";
          }
          streamingText += delta;
          streamingDiv.textContent = streamingText;
          chatLogEl.scrollTop = chatLogEl.scrollHeight;
        },
        onTurnComplete: (text, costUsd, isError) => {
          sessionCostUsd += costUsd;
          if (streamingDiv) {
            streamingDiv.remove(); // дальше решаем сами, что показать — см. ниже
            streamingDiv = null;
          }
          const parsed = parseAgentResponse(text);
          const wasBlocks = pendingKind === "blocks";
          if (parsed.isSkip) {
            addChatMessage(
              "system",
              wasBlocks ? `агент: нечего сказать по ${pendingBlocksCount} блок(ам) (SKIP)` : "агент: SKIP",
            );
          } else {
            addChatMessage("agent", wasBlocks ? `[по ${pendingBlocksCount} блок(ам)] ${text}` : text);
          }
          if (wasBlocks) attachResponseToBlock(pendingBatch, parsed, text);
          if (isError) addChatMessage("system", "⚠ ход диалога завершился с ошибкой");
          agentStatusEl.textContent = agentStatusEl.textContent.replace(/\$[\d.]+$/, `$${sessionCostUsd.toFixed(4)}`);

          agentBusy = false;
          pendingKind = null;
          pendingBatch = [];
          updateChatInputEnabled();
          trySendPending(); // разгружаем очередь блоков, накопившуюся пока агент отвечал
        },
        onRateLimit: (e) => {
          if (e.rate_limit_info.status !== "allowed") {
            addChatMessage("system", `⚠ лимит/кредит: ${e.rate_limit_info.status} (${e.rate_limit_info.overageDisabledReason ?? ""})`);
          }
        },
        onStderr: (line) => {
          console.warn("[agent stderr]", line);
        },
        onExit: (code) => {
          agentStatusEl.textContent = `процесс завершён (код ${code ?? "?"})`;
          setAgentDot("off");
          agent = null;
          agentBusy = false;
          pendingKind = null;
          pendingBlockQueue = [];
          setAgentActive(false);
        },
      },
    });
    setAgentActive(true);
  } catch (err) {
    agentStatusEl.textContent = `ошибка запуска: ${err}`;
    setAgentDot("error");
  }
});

btnAgentStop.addEventListener("click", () => {
  agent?.stop();
});

chatFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInputEl.value.trim();
  if (!text || !agent || agentBusy) return;
  addChatMessage("user", text); // пользователь видит свой текст как есть, без затирания
  chatInputEl.value = "";
  agentBusy = true;
  pendingKind = "chat";
  updateChatInputEnabled();
  // Агенту уходит уже отредактированная копия — см. ТЗ, разд. "Безопасность и приватность":
  // затирается всё, что уходит агенту, включая сообщения в чат (пользователь мог вставить
  // в чат кусок конфига или вывода с секретом, не только печатать команды в терминал).
  agent.sendText(redactSecrets(`${contextLine()}\n\n${text}`)).catch((err) => {
    addChatMessage("system", `⚠ ошибка отправки: ${err}`);
    agentBusy = false;
    pendingKind = null;
    updateChatInputEnabled();
  });
});

chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatFormEl.requestSubmit();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "Space") {
    e.preventDefault();
    toggleAddressTarget();
  }
});
