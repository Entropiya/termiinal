// Разбор OSC 133/633/7 на headless-копии терминала и сборка "блоков" ровно так,
// как описано в ТЗ (разд. "Интеграция с шеллом и нарезка на блоки"): границы блока
// считаются по номеру строки в буфере на момент маркера, а не по тексту — чтобы
// переживать перерисовки прогресс-баров.

import { Terminal } from "@xterm/headless";

export interface Block {
  id: number;
  cmd: string | null;
  cwd: string | null;
  exitCode: number | null;
  output: string;
  startRow: number;
  endRow: number | null;
}

export interface OscLogEntry {
  raw: string; // то, что реально пришло в OSC-обработчик (для сверки "дошло ли целым")
  kind: "133" | "633" | "7";
}

export class BlockBuilder {
  readonly headless: Terminal;
  readonly blocks: Block[] = [];
  readonly oscLog: OscLogEntry[] = [];

  private pendingCwd: string | null = null;
  private pendingCmd: string | null = null;
  private execStartRow: number | null = null;
  private blockSeq = 0;

  onBlockClosed: ((b: Block) => void) | null = null;
  onOscEvent: ((e: OscLogEntry) => void) | null = null;

  constructor(cols: number, rows: number) {
    this.headless = new Terminal({ cols, rows, allowProposedApi: true });

    this.headless.parser.registerOscHandler(133, (data) => {
      this.log("133", data);
      const [code, rest] = splitFirst(data);
      if (code === "C") {
        // Начало выполнения — именно отсюда и до маркера D идёт "чистый" вывод команды.
        this.execStartRow = this.absCursorRow();
      } else if (code === "D") {
        const exitCode = rest !== undefined && rest !== "" ? Number(rest) : null;
        this.closeBlock(exitCode);
      }
      return true;
    });

    this.headless.parser.registerOscHandler(633, (data) => {
      this.log("633", data);
      const [code, rest] = splitFirst(data);
      if (code === "E") {
        this.pendingCmd = rest ?? "";
      }
      return true;
    });

    this.headless.parser.registerOscHandler(7, (data) => {
      this.log("7", data);
      // Формат OSC 7: file://host/path — берём всё после третьего слэша.
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      this.pendingCwd = m ? m[1] : data;
      return true;
    });
  }

  private log(kind: OscLogEntry["kind"], raw: string) {
    const entry = { kind, raw };
    this.oscLog.push(entry);
    this.onOscEvent?.(entry);
  }

  private absCursorRow(): number {
    const buf = this.headless.buffer.active;
    return buf.baseY + buf.cursorY;
  }

  /** Вызывать на каждый пришедший чанк байт, синхронно с записью в видимый терминал. */
  feed(bytes: Uint8Array) {
    this.headless.write(bytes);
  }

  resize(cols: number, rows: number) {
    this.headless.resize(cols, rows);
  }

  private closeBlock(exitCode: number | null) {
    if (this.execStartRow === null) {
      // D без предшествующего C — например, самый первый prompt сессии. Пропускаем.
      return;
    }
    const endRow = this.absCursorRow();
    const output = this.readRows(this.execStartRow, endRow);
    const block: Block = {
      id: this.blockSeq++,
      cmd: this.pendingCmd,
      cwd: this.pendingCwd,
      exitCode,
      output,
      startRow: this.execStartRow,
      endRow,
    };
    this.blocks.push(block);
    this.onBlockClosed?.(block);
    this.pendingCmd = null;
    this.execStartRow = null;
  }

  /** Склеивает строки буфера [fromAbs, toAbs) обратно в логические, учитывая isWrapped. */
  private readRows(fromAbs: number, toAbs: number): string {
    const buf = this.headless.buffer.active;
    const lines: string[] = [];
    for (let y = fromAbs; y < toAbs; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }
    return lines.join("\n");
  }
}

function splitFirst(data: string): [string, string | undefined] {
  const i = data.indexOf(";");
  if (i === -1) return [data, undefined];
  return [data.slice(0, i), data.slice(i + 1)];
}
