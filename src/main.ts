import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { spawnPty, type PtyHandle } from "./pty";
import { BlockBuilder, type Block, type OscLogEntry } from "./osc-blocks";
import { buildIntegrationLine } from "./shell-integration";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const btnSpawn = document.querySelector<HTMLButtonElement>("#btn-spawn")!;
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

async function spawn() {
  statusEl.textContent = "запускается…";
  const cols = term.cols;
  const rows = term.rows;

  blockBuilder = new BlockBuilder(cols, rows);
  blockBuilder.onBlockClosed = renderBlock;
  blockBuilder.onOscEvent = renderOsc;

  pty = await spawnPty({
    program: GIT_BASH,
    args: ["--login", "-i"],
    cols,
    rows,
    onData: (bytes) => {
      term.write(bytes);
      blockBuilder?.feed(bytes);
    },
    onExit: (code) => {
      statusEl.textContent = `процесс завершён (код ${code ?? "?"})`;
      btnIntegrate.disabled = true;
      btnHistory.disabled = true;
      btnProgress.disabled = true;
    },
  });

  term.onData((data) => {
    pty?.write(data);
  });

  statusEl.textContent = "сессия активна — Git Bash";
  btnIntegrate.disabled = false;
  btnHistory.disabled = false;
  btnProgress.disabled = false;
  btnSpawn.disabled = true;
  term.focus();
}

btnSpawn.addEventListener("click", () => {
  spawn().catch((err) => {
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
