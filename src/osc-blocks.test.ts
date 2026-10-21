import { describe, expect, it } from "vitest";
import { BlockBuilder } from "./osc-blocks";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** @xterm/headless write() асинхронный внутри (планируется через setTimeout), хотя
 * сигнатура выглядит синхронной — ждём через переданный в feed() callback, чтобы
 * проверять состояние BlockBuilder только после того, как чанк реально разобран. */
function feed(bb: BlockBuilder, s: string): Promise<void> {
  return new Promise((resolve) => bb.feed(enc(s), resolve));
}

describe("BlockBuilder.peekRunningBlock", () => {
  it("null, когда сейчас не выполняется команда (мы на промпте)", () => {
    const bb = new BlockBuilder(80, 24);
    expect(bb.peekRunningBlock(60)).toBeNull();
  });

  it("отдаёт напечатанное между C и текущим моментом, не дожидаясь D", async () => {
    const bb = new BlockBuilder(80, 24);
    await feed(bb, "\x1b]633;E;apt update\x07");
    await feed(bb, "\x1b]133;C\x07");
    await feed(bb, "Hit:1 http://deb.debian.org ...\r\n");
    await feed(bb, "Fetched 1 B\r\n");

    const snap = bb.peekRunningBlock(60);
    expect(snap).not.toBeNull();
    expect(snap!.running).toBe(true);
    expect(snap!.exitCode).toBeNull();
    expect(snap!.cmd).toBe("apt update");
    expect(snap!.output).toBe("Hit:1 http://deb.debian.org ...\nFetched 1 B");

    // Команда ещё не закрыта — настоящих блоков нет.
    expect(bb.blocks).toHaveLength(0);
  });

  it("обрезает до последних maxLines строк (долгий вывод типа apt/docker pull)", async () => {
    const bb = new BlockBuilder(80, 24);
    await feed(bb, "\x1b]133;C\x07");
    for (let i = 1; i <= 10; i++) await feed(bb, `line ${i}\r\n`);

    const snap = bb.peekRunningBlock(3);
    expect(snap!.output.split("\n")).toEqual(["line 8", "line 9", "line 10"]);
  });

  it("null сразу после закрытия блока (D) — до следующего C команда не выполняется", async () => {
    const bb = new BlockBuilder(80, 24);
    await feed(bb, "\x1b]133;C\x07");
    await feed(bb, "ok\r\n");
    await feed(bb, "\x1b]133;D;0\x07");

    expect(bb.peekRunningBlock(60)).toBeNull();
    expect(bb.blocks).toHaveLength(1); // сам закрытый блок на месте, без изменений
  });
});
