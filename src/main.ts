import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { spawnPty, type PtyHandle } from "./pty";
import { BlockBuilder, type Block, type OscLogEntry } from "./osc-blocks";
import { buildIntegrationLine } from "./shell-integration";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const SSH_KEY = "C:\\Users\\Pakochka\\.ssh\\id_ed25519";

const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const btnSpawn = document.querySelector<HTMLButtonElement>("#btn-spawn")!;
const btnSsh = document.querySelector<HTMLButtonElement>("#btn-ssh")!;
const sshTargetEl = document.querySelector<HTMLInputElement>("#ssh-target")!;
const btnIntegrate = document.querySelector<HTMLButtonElement>("#btn-integrate")!;
const btnHistory = document.querySelector<HTMLButtonElement>("#btn-history")!;
const btnProgress = document.querySelector<HTMLButtonElement>("#btn-progress")!;
const blocksEl = document.querySelector<HTMLDivElement>("#blocks")!;
const oscLogEl = document.querySelector<HTMLDivElement>("#osc-log")!;
const checklistEl = document.querySelector<HTMLUListElement>("#checklist")!;

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
  blockBuilder.onBlockClosed = renderBlock;
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
      btnSpawn.disabled = false;
      btnSsh.disabled = false;
    },
  });

  term.onData((data) => {
    pty?.write(data);
  });

  statusEl.textContent = `сессия активна — ${label}`;
  btnIntegrate.disabled = false;
  btnHistory.disabled = false;
  btnProgress.disabled = false;
  btnSpawn.disabled = true;
  btnSsh.disabled = true;
  term.focus();
}

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
