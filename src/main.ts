import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { spawnPty, type PtyHandle } from "./pty";
import { BlockBuilder, type Block } from "./osc-blocks";
import { buildIntegrationLine } from "./shell-integration";
import { startAgent, type AgentHandle } from "./agent";
import { redactSecrets } from "./redact";
import { shouldSendBlock, formatBlocksForAgent, DEFAULT_BLACKLIST, type AgentPolicy } from "./block-agent";
import { parseAgentResponse, parsePlanChecklist, type PlanItem } from "./agent-contract";
import { renderAgentMarkdown } from "./render-markdown";
import { loadPresets, upsertPreset, removePreset, type ConnectionPreset } from "./presets";
import { buildProbeCommand, ProbeCapture, type ProbeResult } from "./host-probe";
import { classifyPaste, type DangerMatch } from "./paste-guard";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import systemPrompt from "./system-prompt.md?raw";

// ТЗ, разд. "Закрытие Tauri": "ссылки из ответов открываются только во внешнем браузере".
// Единственное место, откуда вообще могут взяться <a>-ссылки — markdown-рендер ответа
// агента (src/render-markdown.ts); перехватываем все клики по ним на уровне документа,
// а не точечно в чате, чтобы не зависеть от того, где именно такая ссылка окажется.
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest?.("a[href]");
  if (!a) return;
  e.preventDefault();
  openUrl(a.getAttribute("href")!).catch(() => {});
});

// Закрывать выпадающие меню («Дополнительно», меню агента) при клике вне них — иначе
// <details> остаётся открытым поверх интерфейса, пока не кликнешь по summary ещё раз.
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  document.querySelectorAll<HTMLDetailsElement>("details.dropdown[open]").forEach((d) => {
    if (!d.contains(target)) d.removeAttribute("open");
  });
});

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const DEFAULT_SSH_KEY = "C:\\Users\\Pakochka\\.ssh\\id_ed25519";

const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const shellEl = document.querySelector<HTMLElement>(".shell")!;
const btnSsh = document.querySelector<HTMLButtonElement>("#btn-ssh")!;
const btnConnect = document.querySelector<HTMLButtonElement>("#btn-connect")!;
const sessionSummaryEl = document.querySelector<HTMLSpanElement>("#session-summary")!;
const presetNameEl = document.querySelector<HTMLInputElement>("#preset-name")!;
const presetUserEl = document.querySelector<HTMLInputElement>("#preset-user")!;
const presetHostEl = document.querySelector<HTMLInputElement>("#preset-host")!;
const presetPortEl = document.querySelector<HTMLInputElement>("#preset-port")!;
const presetKeyEl = document.querySelector<HTMLInputElement>("#preset-key")!;
const btnPresetSave = document.querySelector<HTMLButtonElement>("#btn-preset-save")!;
const btnBrowseKey = document.querySelector<HTMLButtonElement>("#btn-browse-key")!;
const savePromptEl = document.querySelector<HTMLDivElement>("#save-prompt")!;
const savePromptTextEl = document.querySelector<HTMLSpanElement>("#save-prompt-text")!;
const btnSavePromptYes = document.querySelector<HTMLButtonElement>("#btn-save-prompt-yes")!;
const btnSavePromptNo = document.querySelector<HTMLButtonElement>("#btn-save-prompt-no")!;
const btnIntegrate = document.querySelector<HTMLButtonElement>("#btn-integrate")!;
const planListEl = document.querySelector<HTMLUListElement>("#plan-list")!;
const pasteDangerEl = document.querySelector<HTMLDivElement>("#paste-danger")!;
const pasteDangerTextEl = document.querySelector<HTMLSpanElement>("#paste-danger-text")!;
const btnPasteDangerYes = document.querySelector<HTMLButtonElement>("#btn-paste-danger-yes")!;
const btnPasteDangerNo = document.querySelector<HTMLButtonElement>("#btn-paste-danger-no")!;
const blocksEl = document.querySelector<HTMLDivElement>("#blocks")!;

// ===== Панель задач слева: каждая из четырёх рабочих панелей (Терминал, Чат, План,
// Блоки) прячется/показывается собственной кнопкой независимо от остальных — это
// заменяет три жёсткие раскладки "Чат"/"Терминал"/"Сплит" из ТЗ (разд. "Режимы
// интерфейса"): "Сплит" получается сам собой, когда показаны все панели сразу, а не
// отдельным режимом. См. обсуждение в docs/stage3.md.
//
// Ключ для "side" оставлен старым (`terminal-mentor:side-collapsed`) specifically —
// раньше это была кнопка "свернуть Блоки в бок" с той же семантикой (1 = спрятано),
// так сохранённая у пользователя настройка не сбрасывается этим рефакторингом.
const paneTermEl = document.querySelector<HTMLElement>("#pane-term")!;
const paneChatEl = document.querySelector<HTMLElement>("#pane-chat")!;
const panePlanEl = document.querySelector<HTMLElement>("#pane-plan")!;
const paneSideEl = document.querySelector<HTMLElement>("#pane-side")!;

interface DockPane {
  el: HTMLElement;
  btn: HTMLButtonElement;
  storageKey: string;
}

type PaneId = "term" | "chat" | "plan" | "side";

const dockPanes: Record<PaneId, DockPane> = {
  term: { el: paneTermEl, btn: document.querySelector<HTMLButtonElement>("#dock-term")!, storageKey: "terminal-mentor:term-hidden" },
  chat: { el: paneChatEl, btn: document.querySelector<HTMLButtonElement>("#dock-chat")!, storageKey: "terminal-mentor:chat-hidden" },
  plan: { el: panePlanEl, btn: document.querySelector<HTMLButtonElement>("#dock-plan")!, storageKey: "terminal-mentor:plan-hidden" },
  side: { el: paneSideEl, btn: document.querySelector<HTMLButtonElement>("#dock-blocks")!, storageKey: "terminal-mentor:side-collapsed" },
};

// Порядок панелей в DOM/на экране — для расстановки разделителей между соседями.
const PANE_ORDER: PaneId[] = ["term", "chat", "plan", "side"];
// Нижняя граница ширины в пикселях — не даёт панели схлопнуться до нечитаемого
// состояния при перетаскивании разделителя, независимо от flex-grow.
const PANE_MIN_WIDTH: Record<PaneId, number> = { term: 240, chat: 280, plan: 220, side: 300 };

// ===== Ширина панелей — через flex-grow, а не фиксированные пиксели, чтобы раскладка
// подстраивалась под размер окна пропорционально (а не оставалась привязанной к старым
// px при ресайзе окна). Если видна только одна панель — у неё нет соседей, делящих
// flex-grow, так что она естественно занимает всю ширину без доп. кода. =====
function paneGrowKey(id: PaneId): string {
  return `terminal-mentor:pane-grow:${id}`;
}

function getPaneGrow(id: PaneId): number {
  const saved = Number(localStorage.getItem(paneGrowKey(id)));
  return saved > 0 ? saved : 1;
}

function setPaneGrow(id: PaneId, grow: number) {
  dockPanes[id].el.style.flex = `${grow} 1 0%`;
  localStorage.setItem(paneGrowKey(id), String(grow));
}

for (const id of PANE_ORDER) setPaneGrow(id, getPaneGrow(id));

// Пул разделителей — их не больше, чем промежутков между панелями (N-1), независимо от
// того, сколько панелей сейчас видно. relayoutResizers переставляет их между реально
// видимыми соседями каждый раз, когда что-то прячется/показывается кнопкой в dockPanes.
const resizerPool: HTMLDivElement[] = PANE_ORDER.slice(1).map(() => {
  const d = document.createElement("div");
  d.className = "resizer";
  d.title = "Перетащи, чтобы изменить соотношение";
  return d;
});

function relayoutResizers() {
  const visible = PANE_ORDER.filter((id) => !dockPanes[id].el.classList.contains("pane-hidden"));
  resizerPool.forEach((r) => r.remove());
  for (let i = 0; i < visible.length - 1; i++) {
    const r = resizerPool[i];
    r.dataset.left = visible[i];
    r.dataset.right = visible[i + 1];
    dockPanes[visible[i]].el.after(r);
  }
}

interface ResizeState {
  el: HTMLDivElement;
  left: PaneId;
  right: PaneId;
  combinedGrow: number;
  totalPx: number;
  leftEdgePx: number;
}
let resizing: ResizeState | null = null;

for (const r of resizerPool) {
  r.addEventListener("mousedown", (e) => {
    const left = r.dataset.left as PaneId;
    const right = r.dataset.right as PaneId;
    const leftRect = dockPanes[left].el.getBoundingClientRect();
    const rightRect = dockPanes[right].el.getBoundingClientRect();
    resizing = {
      el: r,
      left,
      right,
      combinedGrow: getPaneGrow(left) + getPaneGrow(right),
      totalPx: leftRect.width + rightRect.width,
      leftEdgePx: leftRect.left,
    };
    r.classList.add("dragging");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
}

window.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const { left, right, combinedGrow, totalPx, leftEdgePx } = resizing;
  // Перераспределяем ТОЛЬКО между left/right, их сумма flex-grow не меняется — поэтому
  // ширина остальных (не участвующих в этом перетаскивании) панелей не дёргается.
  const widthLeft = Math.max(
    PANE_MIN_WIDTH[left],
    Math.min(totalPx - PANE_MIN_WIDTH[right], e.clientX - leftEdgePx),
  );
  const fracLeft = widthLeft / totalPx;
  setPaneGrow(left, combinedGrow * fracLeft);
  setPaneGrow(right, combinedGrow * (1 - fracLeft));
  if (left === "term" || right === "term") syncTermSize();
});

window.addEventListener("mouseup", () => {
  if (!resizing) return;
  resizing.el.classList.remove("dragging");
  document.body.style.userSelect = "";
  resizing = null;
});

function setPaneHidden(id: PaneId, hidden: boolean) {
  const p = dockPanes[id];
  p.el.classList.toggle("pane-hidden", hidden);
  p.btn.classList.toggle("active", !hidden);
  localStorage.setItem(p.storageKey, hidden ? "1" : "0");
  relayoutResizers();
  // xterm/fitAddon не умеют посчитать размер, пока контейнер display:none — досчитываем
  // его, когда терминал возвращается на экран (см. syncTermSize ниже).
  if (id === "term" && !hidden) requestAnimationFrame(syncTermSize);
}

// По умолчанию (пока пользователь ничего сам не прятал/не показывал) открыт только
// терминал — остальные три панели включаются по запросу кнопкой в панели задач.
// Как только в localStorage появляется явное значение, оно главнее этого дефолта.
const PANE_DEFAULT_HIDDEN: Record<PaneId, boolean> = { term: false, chat: true, plan: true, side: true };

for (const id of PANE_ORDER) {
  const p = dockPanes[id];
  p.btn.addEventListener("click", () => setPaneHidden(id, !p.el.classList.contains("pane-hidden")));
  const stored = localStorage.getItem(p.storageKey);
  setPaneHidden(id, stored !== null ? stored === "1" : PANE_DEFAULT_HIDDEN[id]);
}

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

// Чек-лист риск-прототипа и сырой OSC-лог (этап 1) убраны из основного интерфейса —
// своё дело они сделали, результат задокументирован в docs/stage1.md. BlockBuilder
// по-прежнему пишет весь OSC-поток в .oscLog (поле класса) на случай будущей отладки,
// просто это больше не рендерится отдельной панелью.

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
  return true;
});

// ===== Защита от опасных команд при вставке (ТЗ, разд. "Вставка команд") =====
// Перехватываем 'paste' на контейнере #xterm в фазе capture — это раньше, чем внутренний
// обработчик xterm.js на его скрытой textarea (у него — bubble-фаза), поэтому
// preventDefault()+stopPropagation() здесь гарантированно не дают xterm вставить текст
// мимо проверки.
//
// Не сделано из этого раздела ТЗ: ограничение многострочной вставки до одной строки в
// шеллах без bracketed paste (ash/dash) — у проекта пока нет отслеживания "сейчас bash
// или ash/dash" (см. docs/stage2.md). Многострочная вставка всегда уходит как есть, с
// оборачиванием в bracketed paste, если шелл его включил.
let pendingPasteText: string | null = null;

function forwardPasteToPty(text: string) {
  if (!pty) return;
  const wrapped = term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
  pty.write(wrapped);
}

function showPasteDangerPrompt(matches: DangerMatch[]) {
  pasteDangerTextEl.innerHTML =
    "⚠ В буфере — потенциально опасная команда:<br>" +
    Array.from(new Set(matches.map((m) => `${m.group}: ${m.label}`)))
      .map(escapeHtml)
      .join("<br>");
  pasteDangerEl.classList.remove("hidden");
}

function hidePasteDangerPrompt() {
  pendingPasteText = null;
  pasteDangerEl.classList.add("hidden");
}

btnPasteDangerYes.addEventListener("click", () => {
  if (pendingPasteText !== null) forwardPasteToPty(pendingPasteText);
  hidePasteDangerPrompt();
});
btnPasteDangerNo.addEventListener("click", hidePasteDangerPrompt);

document.querySelector<HTMLDivElement>("#xterm")!.addEventListener(
  "paste",
  (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    const matches = classifyPaste(text);
    if (matches.length === 0) {
      forwardPasteToPty(text);
    } else {
      pendingPasteText = text;
      showPasteDangerPrompt(matches);
    }
  },
  { capture: true },
);

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

// ===== План (ТЗ: "Состояние держит приложение. План и лог блоков — у приложения,
// сессия агента — расходник"). Живёт только в памяти текущего запуска приложения —
// переживание перезапуска и экспорт это отдельный пункт этапа 3 (хранение сессий,
// см. docs/stage3.md), пока не сделан. Агент присылает ПОЛНЫЙ снимок плана в каждом
// ```plan блоке (ТЗ: "Обновление плана"), поэтому просто заменяем целиком, без диффа. =====
let currentPlan: PlanItem[] = [];

function renderPlan() {
  // Видимость самой панели плана теперь не зависит от того, есть ли план — это
  // решает кнопка в панели задач (см. dockPanes выше). Если плана ещё нет, просто
  // показываем заглушку вместо пустого списка.
  planListEl.innerHTML = currentPlan.length
    ? currentPlan
        .map((item) => `<li class="${item.done ? "done" : ""}">${item.done ? "☑" : "☐"} ${escapeHtml(item.text)}</li>`)
        .join("")
    : `<li class="plan-empty">План пока не составлен.</li>`;
}
renderPlan();
let currentSessionLabel: string | null = null;
let sessionOsInfo: { osId: string | null; osVersionId: string | null } | null = null;
let probeCapture: ProbeCapture | null = null;
// После самого маркера конца пробы шелл всё равно дорисует СЛЕДУЮЩИЙ, уже настоящий
// промпт — это неизбежно после любой команды, его отдельно не спрятать на уровне самой
// команды. Прячем и его тоже: держим подавление, пока не наступит короткая пауза тишины
// в байтах (разумное допущение, что это и есть хвостовая перерисовка, а не что-то
// содержательное — в момент пробы пользователь ещё ничего не печатает).
let probeTrailingSuppress = false;
let probeTrailingTimer: ReturnType<typeof setTimeout> | null = null;
// Если проба получила hostname, интеграцию шлём сами (см. handleProbeResult) — но не
// СРАЗУ: это гонка с подавлением выше. Пока хвостовая перерисовка промпта ещё может быть
// в пути по сети, её эхо и эхо самой строки интеграции перемешались бы. Поэтому только
// ставим флаг здесь, а реально печатаем позже, когда подавление само естественно закончится.
let pendingAutoIntegration = false;

function scheduleProbeTrailingEnd() {
  if (probeTrailingTimer) clearTimeout(probeTrailingTimer);
  probeTrailingTimer = setTimeout(() => {
    probeTrailingSuppress = false;
    probeTrailingTimer = null;
    if (pendingAutoIntegration) {
      pendingAutoIntegration = false;
      injectIntegration("Интеграция внедрена автоматически (hostname опознан).");
    }
  }, 250);
}

// Строка интеграции — служебная деталь реализации, печатать её на экран пользователю
// незачем (а после фикса ESC-байтов из этапа 2 она ещё и читается как есть, длинная и
// нечитаемая на глаз). Прячем её собственное эхо так же, как прячем пробу — только
// граница точная: эхо набранной строки заканчивается первым же переводом строки
// (тем, что отправляет сама ssh/bash, когда получает Enter), в отличие от пробы, где
// точных маркеров начала/конца у нас не было.
let hidingIntegrationEcho = false;
let hideEchoDecoder: TextDecoder | null = null;

function injectIntegration(note?: string) {
  hidingIntegrationEcho = true;
  hideEchoDecoder = new TextDecoder();
  pty?.write(buildIntegrationLine() + "\r");
  if (note) addChatMessage("system", note);
}

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
  // Пользователь явно согласился на компромисс "как у пробы": если проба вообще
  // получила осмысленный hostname обратно, значит эхо точно было включено и мы
  // действительно сидели на обычном рабочем промпте (а не, скажем, в приглашении
  // пароля) — это и есть наше подтверждение "можно печатать", раз честного разбора
  // текста промпта (как того просит ТЗ для автовключения) у нас пока нет. Саму отправку
  // см. в scheduleProbeTrailingEnd — тут только ставим флаг, см. комментарий там.
  if (r.hostname) pendingAutoIntegration = true;
  // Подключение заработало по-настоящему (проба прошла) — если это было НЕ из уже
  // сохранённого пресета, самое время предложить сохранить (см. connectedFromSavedPreset).
  if (r.hostname && !connectedFromSavedPreset) showSavePrompt();
}

function showSavePrompt() {
  savePromptTextEl.textContent = `Сохранить подключение «${presetNameEl.value || presetHostEl.value}» как пресет?`;
  savePromptEl.classList.remove("hidden");
}

function hideSavePrompt() {
  savePromptEl.classList.add("hidden");
}

btnSavePromptYes.addEventListener("click", () => {
  const id = crypto.randomUUID();
  const preset = currentFieldsAsPreset(id);
  if (preset.user && preset.host) {
    upsertPreset(preset);
    renderLauncherList();
  }
  hideSavePrompt();
});

btnSavePromptNo.addEventListener("click", hideSavePrompt);

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

// Хоткей "глянь" (ТЗ: один на всё). Два случая:
// - команда сейчас выполняется -> живой текстовый снимок последних 60 строк из
//   headless-буфера (peekRunningBlock), а не скриншот экрана: тот же путь, что у
//   закрытых блоков (затирание секретов, контракт ответа), без скриншотов и доступа
//   к экрану — см. обсуждение в docs/stage2.md.
// - иначе — форсирует отправку последнего ЗАКРЫТОГО блока в обход политики/списка.
const PEEK_MAX_LINES = 60; // тот же порог, что открытый вопрос в tz.md про обрезку вывода

btnGlance.addEventListener("click", () => {
  const running = blockBuilder?.peekRunningBlock(PEEK_MAX_LINES);
  if (running) {
    // Синтетический отрицательный id: это одноразовый снимок, а не настоящий блок
    // из нарезки — не должен занимать номер из blockBuilder.blockSeq (команда ещё
    // выполняется и позже честно закроется своим обычным блоком с обычным id).
    const block: Block = { id: -Date.now(), ...running };
    renderBlock(block);
    pendingBlockQueue.push(block);
    if (agentBusy) {
      addChatMessage("system", "«Глянь»: агент занят, снимок встал в очередь.");
    }
    trySendPending();
    return;
  }
  if (!lastClosedBlock) {
    // Раньше молча ничего не делала — самая вероятная причина "не работает":
    // блоков ещё нет (интеграция не внедрена или ни одна команда не завершилась).
    addChatMessage("system", "⚠ «Глянь»: ещё нет ни одного закрытого блока — нажми «Внедрить интеграцию» и выполни команду в шелле.");
    return;
  }
  pendingBlockQueue.push(lastClosedBlock);
  if (agentBusy) {
    addChatMessage("system", "«Глянь»: агент занят, блок встал в очередь.");
  }
  trySendPending();
});

const blockElements = new Map<number, HTMLDivElement>();

function renderBlock(b: Block) {
  const div = document.createElement("div");
  div.className = b.running ? "block block-running" : "block";
  const status = b.running ? "выполняется… (снимок, не итог)" : `exit=${b.exitCode ?? "?"}`;
  div.innerHTML = `
    <div class="cmd">${escapeHtml(b.cmd ?? "(нет текста команды)")}</div>
    <div class="meta">${status} cwd=${escapeHtml(b.cwd ?? "?")} строки ${b.startRow}–${b.endRow}</div>
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
  probeTrailingSuppress = false;
  pendingAutoIntegration = false;
  hidingIntegrationEcho = false;
  hideEchoDecoder = null;
  if (probeTrailingTimer) {
    clearTimeout(probeTrailingTimer);
    probeTrailingTimer = null;
  }
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
  pty = await spawnPty({
    program,
    args,
    env,
    cols,
    rows,
    onData: (bytes) => {
      // Пока идёт скрытая проба хоста (и короткое время после неё, пока шелл дорисовывает
      // следующий промпт) — ни видимый терминал, ни headless-копия её не видят. Обязательно
      // решаем одинаково для обоих: иначе их буферы разойдутся по номерам строк, на
      // которых держится нарезка на блоки (см. BlockBuilder).
      if (probeCapture) {
        probeCapture.feed(bytes);
        if (probeCapture.done) {
          handleProbeResult(probeCapture.result());
          probeCapture = null;
          probeTrailingSuppress = true;
        }
        scheduleProbeTrailingEnd();
        return;
      }
      if (probeTrailingSuppress) {
        scheduleProbeTrailingEnd();
        return;
      }
      if (hidingIntegrationEcho) {
        const text = hideEchoDecoder!.decode(bytes, { stream: true });
        const nlIdx = text.indexOf("\n");
        if (nlIdx === -1) return; // конец набранной строки ещё не пришёл — молчим
        hidingIntegrationEcho = false;
        hideEchoDecoder = null;
        const visible = text.slice(nlIdx + 1);
        if (visible) {
          term.write(visible);
          blockBuilder?.feed(new TextEncoder().encode(visible));
        }
        return;
      }
      term.write(bytes);
      blockBuilder?.feed(bytes);
    },
    onExit: (code) => {
      statusEl.textContent = `${label}: процесс завершён (код ${code ?? "?"})`;
      setSessionActive(false);
      // После реального отключения форма "Новое подключение" должна начинаться с
      // нуля, а не с полей только что завершённой сессии — иначе выглядит как
      // "предзаполнение предыдущей". Не трогаем это в setSessionActive() саму —
      // туда же ведёт и самый первый вызов при старте приложения, когда поля должны
      // остаться с их обычными дефолтами, а не обнуляться.
      clearPresetFields();
      pty = null;
      currentSessionLabel = null;
      sessionOsInfo = null;
      probeCapture = null;
      probeTrailingSuppress = false;
      pendingAutoIntegration = false;
      hidingIntegrationEcho = false;
      hideEchoDecoder = null;
      if (probeTrailingTimer) {
        clearTimeout(probeTrailingTimer);
        probeTrailingTimer = null;
      }
    },
  });

  statusEl.textContent = `сессия активна — ${label}`;
  setSessionActive(true);
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

// Отдельная кнопка "Завершить сессию" не нужна, пока сессии нет — "Подключиться"
// сама становится "Завершить сессию", пока она активна (см. btnSsh ниже).
// Размеры окна для "менеджера подключений" (нет сессии) и для рабочей сессии — см.
// setSessionActive ниже. Совпадают со стартовыми размерами из tauri.conf.json (там —
// размер самого первого окна при запуске, тут — то, во что/из чего прыгаем при смене
// состояния внутри уже запущенного процесса).
const LAUNCHER_WINDOW_SIZE = new LogicalSize(460, 640);
const SESSION_WINDOW_SIZE = new LogicalSize(1280, 860);

function setSessionActive(active: boolean) {
  btnIntegrate.disabled = !active;
  shellEl.dataset.session = active ? "active" : "idle";
  sessionSummaryEl.textContent = active ? currentSessionLabel ?? "" : "";
  if (!active) {
    hideSavePrompt();
    hidePasteDangerPrompt();
  }
  // Пока сессии нет — маленькое несворачиваемое окно "менеджера подключений" (а-ля
  // PuTTY: список пресетов + новое подключение). Как только сессия реально поднялась,
  // окно разворачивается в рабочий размер и становится обычным resizable-окном; при
  // завершении сессии (кнопкой или сам процесс вышел, см. onExit в spawnShell) —
  // сжимается обратно. Это одно и то же окно ОС, не два разных — плавнее, чем закрывать
  // одно окно и открывать другое, и работает одинаково для первого и для повторного
  // подключения в одном запуске приложения.
  const win = getCurrentWindow();
  win.setResizable(active).catch((err) => console.warn("[window] setResizable", err));
  win
    .setSize(active ? SESSION_WINDOW_SIZE : LAUNCHER_WINDOW_SIZE)
    .then(() => win.center())
    .catch((err) => console.warn("[window] setSize/center", err));
  win
    .setTitle(active && currentSessionLabel ? `${currentSessionLabel} — terminal-mentor` : "terminal-mentor")
    .catch((err) => console.warn("[window] setTitle", err));
}

// Раньше была ещё отдельная кнопка "Git Bash (локально)" в "Дополнительно" — убрали:
// она дублировала эту же кнопку из лаунчера (#btn-launcher-gitbash ниже) и всегда была
// disabled, пока сессия активна (а "Дополнительно" теперь и так показывается только
// внутри активной сессии — см. .toolbar-connect в styles.css), то есть толку от неё
// не было в принципе.
function spawnGitBash() {
  spawnShell("Git Bash", GIT_BASH, ["--login", "-i"], {
    // MSYS-рантайм git-bash по умолчанию не знает про ConPTY и ведёт себя так, будто
    // его вывод никуда не подключён как терминал — отсюда битые Tab/история/стрелки.
    // enable_pcon — задокументированный флаг MSYS2 именно для работы под ConPTY
    // (тот же трюк использует Windows Terminal для профиля Git Bash).
    MSYS: "enable_pcon",
    MSYS2_PTY: "1",
    // Без этого MSYS2 сама подставляет LANG под язык интерфейса Windows (у нас — ru-RU),
    // когда переменная не задана — вот откуда были русские сообщения coreutils/bash,
    // хотя никто их явно не просил. C.UTF-8 — нейтральный дефолт (как обычно "из
    // коробки" у самого инструмента), не привязанный к языку конкретной машины.
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  }).catch((err) => {
    statusEl.textContent = `ошибка запуска: ${err}`;
  });
}

// ===== Пресеты подключений (ТЗ: "Подключения и пресеты") =====
// Раньше тут был <select> со списком пресетов, который подставлял их значения в эти
// же поля для просмотра/редактирования — убрали по просьбе пользователя: форма теперь
// ВСЕГДА про новое подключение, без скрытого состояния "а вдруг это открытый пресет".
// Открыть сохранённый пресет — это клик по нему в списке лаунчера (сразу подключает,
// см. renderLauncherList ниже); удалить его — крестик у той же строки списка.

function clearPresetFields() {
  presetNameEl.value = "";
  presetUserEl.value = "";
  presetHostEl.value = "";
  presetPortEl.value = "";
  presetKeyEl.value = DEFAULT_SSH_KEY;
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

btnPresetSave.addEventListener("click", () => {
  const preset = currentFieldsAsPreset(crypto.randomUUID());
  if (!preset.user || !preset.host) {
    statusEl.textContent = "для пресета нужны хотя бы пользователь и хост";
    return;
  }
  upsertPreset(preset);
  renderLauncherList();
});

btnBrowseKey.addEventListener("click", async () => {
  const path = await openFileDialog({ title: "Файл ключа SSH", multiple: false, directory: false }).catch(
    (err) => {
      console.warn("[dialog] open", err);
      return null;
    },
  );
  if (typeof path === "string") presetKeyEl.value = path;
});

// Подключились кликом по уже сохранённому пресету в списке лаунчера, а не через форму
// нового подключения — не предлагаем banner'ом "сохранить?" то, что уже сохранено
// (см. handleProbeResult/showSavePrompt выше).
let connectedFromSavedPreset = false;

function connectSsh() {
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
}

btnConnect.addEventListener("click", () => {
  connectedFromSavedPreset = false;
  connectSsh();
});

// btn-ssh виден только внутри активной сессии (см. .toolbar-connect в styles.css) —
// у него одна роль, завершить её, а не переключаться между "подключиться"/"завершить".
btnSsh.addEventListener("click", () => {
  pty?.kill().catch((err) => {
    statusEl.textContent = `ошибка завершения: ${err}`;
  });
  // UI полностью сбросится по событию pty-exit (onExit выше), killer только просит
  // процесс завершиться — ждём подтверждения от wait-потока в Rust.
});

// ===== Стартовый экран (а-ля PuTTY) =====

const launcherListEl = document.querySelector<HTMLUListElement>("#launcher-list")!;
const btnLauncherGitBash = document.querySelector<HTMLButtonElement>("#btn-launcher-gitbash")!;

function renderLauncherList() {
  const presets = loadPresets();
  launcherListEl.innerHTML = "";
  if (presets.length === 0) {
    const li = document.createElement("li");
    li.className = "launcher-empty";
    li.textContent = "пока пусто — подключись один раз, предложим сохранить";
    launcherListEl.appendChild(li);
    return;
  }
  for (const p of presets) {
    const li = document.createElement("li");
    li.className = "launcher-preset";
    li.innerHTML = `
      <span class="name">${escapeHtml(p.name)}</span>
      <span class="target">${escapeHtml(p.user)}@${escapeHtml(p.host)}${p.port ? ":" + p.port : ""}</span>
    `;
    const del = document.createElement("button");
    del.className = "launcher-preset-delete";
    del.textContent = "✕";
    del.title = "Удалить пресет";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removePreset(p.id);
      renderLauncherList();
    });
    li.appendChild(del);
    li.addEventListener("click", () => {
      presetNameEl.value = p.name;
      presetUserEl.value = p.user;
      presetHostEl.value = p.host;
      presetPortEl.value = p.port ? String(p.port) : "";
      presetKeyEl.value = p.keyPath ?? DEFAULT_SSH_KEY;
      connectedFromSavedPreset = true;
      connectSsh();
    });
    launcherListEl.appendChild(li);
  }
}

btnLauncherGitBash.addEventListener("click", spawnGitBash);

renderLauncherList();
setSessionActive(false);

btnIntegrate.addEventListener("click", () => injectIntegration());

function syncTermSize() {
  fitAddon.fit();
  const cols = term.cols;
  const rows = term.rows;
  pty?.resize(cols, rows);
  blockBuilder?.resize(cols, rows);
}

window.addEventListener("resize", syncTermSize);

// Ширина панелей (flex-grow) и разделители между ними — см. dockPanes/setPaneGrow/
// relayoutResizers выше, рядом с панелью задач.

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

async function startAgentSession() {
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
          agentStatusEl.textContent = `${e.model} · $${sessionCostUsd.toFixed(4)}`;
          // Молчим, когда всё в порядке — предупреждаем только если изоляция НЕ
          // подтвердилась, это единственное, что реально требует внимания пользователя.
          if (!isolated) {
            addChatMessage(
              "system",
              `⚠ Внимание: у агента есть доступные инструменты (${e.tools.join(", ") || "—"}) или MCP-серверы (${e.mcp_servers.length}). Изоляция не подтверждена.`,
            );
          }
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
          if (parsed.plan !== null) {
            currentPlan = parsePlanChecklist(parsed.plan);
            renderPlan();
          }
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
    // `claude -p --input-format stream-json` не присылает вообще ничего, даже system/init,
    // пока не получит первое сообщение — проверено эмпирически (см. docs/stage2.md).
    // Поэтому дальше честно "ждёт", а не "запускается" — процесс уже живой, просто
    // пока нечего подтвердить (изоляцию покажем, когда придёт init на первое сообщение).
    agentStatusEl.textContent = "ждёт первого сообщения…";
    setAgentActive(true);
  } catch (err) {
    agentStatusEl.textContent = `ошибка запуска: ${err}`;
    setAgentDot("error");
  }
}

// Отдельных кнопок старт/стоп больше нет — сам статус кликабелен: "не запущен" запускает,
// название модели (пока агент жив) останавливает.
agentStatusEl.addEventListener("click", () => {
  if (agent) agent.stop();
  else startAgentSession();
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

// ===== Проверка обновлений (ТЗ, этап 5 "Раздача коллегам") =====
// tauri-plugin-updater — проверяет https://github.com/.../releases/latest/download/
// latest.json (см. src-tauri/tauri.conf.json), который заливает CI при релизе (см.
// .github/workflows/release.yml). Баннер поверх всего — независимо от того, идёт
// сессия или открыт лаунчер, обновление может понадобиться в любом из состояний.
const updateBannerEl = document.querySelector<HTMLDivElement>("#update-banner")!;
const updateBannerTextEl = document.querySelector<HTMLSpanElement>("#update-banner-text")!;
const btnUpdateInstall = document.querySelector<HTMLButtonElement>("#btn-update-install")!;
const btnUpdateDismiss = document.querySelector<HTMLButtonElement>("#btn-update-dismiss")!;

let pendingUpdate: Awaited<ReturnType<typeof checkForUpdate>> | null = null;

async function checkForUpdatesOnce() {
  let update: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    update = await checkForUpdate();
  } catch (err) {
    console.warn("[updater] check", err);
    return;
  }
  if (!update) return;
  pendingUpdate = update;
  updateBannerTextEl.textContent = `Доступно обновление ${update.version} (сейчас ${update.currentVersion}).`;
  updateBannerEl.classList.remove("hidden");
}

btnUpdateInstall.addEventListener("click", async () => {
  if (!pendingUpdate) return;
  btnUpdateInstall.disabled = true;
  btnUpdateInstall.textContent = "Скачивание…";
  try {
    // downloadAndInstall долго (скачивание + запуск инсталлятора) — в сессии при этом
    // может идти работа, поэтому не блокируем остальной интерфейс, только эту кнопку.
    await pendingUpdate.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.warn("[updater] install", err);
    btnUpdateInstall.disabled = false;
    btnUpdateInstall.textContent = "Установить и перезапустить";
    updateBannerTextEl.textContent = `Не удалось установить обновление: ${err}`;
  }
});

btnUpdateDismiss.addEventListener("click", () => {
  updateBannerEl.classList.add("hidden");
});

// Один раз при старте — приложение обычно запускают заново, а не держат сутками, так
// что периодический повтор-опрос пока избыточен (можно добавить позже при необходимости).
checkForUpdatesOnce();
