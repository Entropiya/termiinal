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
  /** true только для живого снимка хоткея "глянь" (см. peekRunningBlock) — команда
   * ещё выполняется, вывод может быть обрезан и не окончателен. Обычные закрытые
   * блоки это поле не ставят (undefined === false). */
  running?: boolean;
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

  /** ТЗ: «пустой промпт» для перехвата `! ` — "после B, до первого нажатия". Грубое
   * приближение: true с момента показа промпта (B) до начала выполнения (C). Не отличает
   * "ничего не напечатано" от "напечатали и стёрли обратно в ноль" — для MVP этого
   * перехвата достаточно, точный учёт пустоты строки требует знать курсор И текст строки
   * одновременно, это уже сама строка ввода, а не то, что видно в выводе шелла. */
  atPromptStart = false;

  onBlockClosed: ((b: Block) => void) | null = null;
  onOscEvent: ((e: OscLogEntry) => void) | null = null;

  constructor(cols: number, rows: number) {
    this.headless = new Terminal({ cols, rows, allowProposedApi: true });

    this.headless.parser.registerOscHandler(133, (data) => {
      this.log("133", data);
      const [code, rest] = splitFirst(data);
      if (code === "B") {
        this.atPromptStart = true;
      } else if (code === "C") {
        // Начало выполнения — именно отсюда и до маркера D идёт "чистый" вывод команды.
        this.atPromptStart = false;
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

  /** Вызывать на каждый пришедший чанк байт, синхронно с записью в видимый терминал.
   * callback (нужен только тестам) вызывается, когда headless-терминал реально
   * разобрал этот чанк — у @xterm/headless write() всегда асинхронный внутри
   * (планируется через setTimeout), несмотря на синхронную на вид сигнатуру. */
  feed(bytes: Uint8Array, callback?: () => void) {
    this.headless.write(bytes, callback);
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

  /** Снимок ещё НЕ закрытого блока для хоткея "глянь" (ТЗ: случай "на незавершённом
   * блоке -> снимок текущего экрана"). Берёт всё, что уже напечатано между OSC 133 C
   * и текущим положением курсора, не дожидаясь D — команда может идти долго (apt,
   * docker pull). Возвращает последние maxLines строк, а не всё (тот же порог, что
   * у закрытых блоков, см. открытый вопрос в tz.md), чтобы снимок был предсказуемого
   * размера. null, если сейчас не выполняется команда (мы на промпте). */
  peekRunningBlock(maxLines: number): Omit<Block, "id"> | null {
    if (this.execStartRow === null) return null;
    const endRow = this.absCursorRow();
    const full = this.readRows(this.execStartRow, endRow);
    const lines = full.split("\n");
    const output = lines.length > maxLines ? lines.slice(lines.length - maxLines).join("\n") : full;
    return {
      cmd: this.pendingCmd,
      cwd: this.pendingCwd,
      exitCode: null,
      output,
      startRow: this.execStartRow,
      endRow,
      running: true,
    };
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
