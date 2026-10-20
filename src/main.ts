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
import systemPrompt from "./system-prompt.md?raw";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const SSH_KEY = "C:\\Users\\Pakochka\\.ssh\\id_ed25519";

const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const btnSpawn = document.querySelector<HTMLButtonElement>("#btn-spawn")!;
const btnSsh = document.querySelector<HTMLButtonElement>("#btn-ssh")!;
const sshTargetEl = document.querySelector<HTMLInputElement>("#ssh-target")!;
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
  return true;
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
let lastClosedBlock: Block | null = null;

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

function renderBlock(b: Block) {
  const div = document.createElement("div");
  div.className = "block";
  div.innerHTML = `
    <div class="cmd">${escapeHtml(b.cmd ?? "(нет текста команды)")}</div>
    <div class="meta">exit=${b.exitCode ?? "?"} cwd=${escapeHtml(b.cwd ?? "?")} строки ${b.startRow}–${b.endRow}</div>
    <pre>${escapeHtml(b.output)}</pre>
  `;
  blocksEl.prepend(div);
}

function renderOsc(e: OscLogEntry) {
  const div = document.createElement("div");
  div.textContent = `OSC ${e.kind} ; ${e.raw}`;
  oscLogEl.prepend(div);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function spawnShell(label: string, program: string, args: string[], env?: Record<string, string>) {
  statusEl.textContent = `${label}: запускается…`;
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
    },
  });

  term.onData((data) => {
    pty?.write(data);
  });

  statusEl.textContent = `сессия активна — ${label}`;
  btnIntegrate.disabled = false;
  btnHistory.disabled = false;
  btnProgress.disabled = false;
  btnKill.disabled = false;
  btnSpawn.disabled = true;
  btnSsh.disabled = true;
  term.focus();
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

btnSsh.addEventListener("click", () => {
  const target = sshTargetEl.value.trim();
  if (!target) return;
  // Без -o StrictHostKeyChecking — подтверждение отпечатка хоста при первом подключении
  // идёт через обычный диалог ssh прямо в терминале, как и описано в ТЗ.
  spawnShell("SSH " + target, "ssh.exe", ["-i", SSH_KEY, target]).catch((err) => {
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
  div.textContent = text;
  chatLogEl.appendChild(div);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  return div;
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
  updateChatInputEnabled();
  const text = redactSecrets(formatBlocksForAgent(batch));
  agent.sendText(text).catch((err) => {
    addChatMessage("system", `⚠ ошибка отправки блока(ов): ${err}`);
    agentBusy = false;
    pendingKind = null;
    updateChatInputEnabled();
  });
}

btnAgentStart.addEventListener("click", async () => {
  agentStatusEl.textContent = "запускается…";
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
          if (isError) addChatMessage("system", "⚠ ход диалога завершился с ошибкой");
          agentStatusEl.textContent = agentStatusEl.textContent.replace(/\$[\d.]+$/, `$${sessionCostUsd.toFixed(4)}`);

          agentBusy = false;
          pendingKind = null;
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
  agent.sendText(redactSecrets(text)).catch((err) => {
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
  }
});
