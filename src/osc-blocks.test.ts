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

describe("BlockBuilder — закрытие блоков по OSC 133/633/7", () => {
  it("собирает блок: команда из 633;E, cwd из OSC 7, код возврата из 133;D", async () => {
    const bb = new BlockBuilder(80, 24);
    const closed: unknown[] = [];
    bb.onBlockClosed = (b) => closed.push(b);

    await feed(bb, "\x1b]7;file://myhost/home/user/proj\x07");
    await feed(bb, "\x1b]133;A\x07$ \x1b]133;B\x07ls -la\r\n"); // промпт + эхо команды + Enter
    await feed(bb, "\x1b]633;E;ls -la\x07\x1b]133;C\x07");
    await feed(bb, "file1\r\nfile2\r\n");
    await feed(bb, "\x1b]133;D;0\x07");

    expect(bb.blocks).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(bb.blocks[0]).toMatchObject({
      id: 0,
      cmd: "ls -la",
      cwd: "/home/user/proj",
      exitCode: 0,
      output: "file1\nfile2",
    });
  });

  it("ненулевой и отсутствующий код возврата", async () => {
    const bb = new BlockBuilder(80, 24);
    await feed(bb, "\x1b]633;E;false\x07\x1b]133;C\x07\x1b]133;D;1\x07");
    await feed(bb, "\x1b]633;E;true\x07\x1b]133;C\x07\x1b]133;D\x07");

    expect(bb.blocks.map((b) => b.exitCode)).toEqual([1, null]);
  });

  it("D без предшествующего C (первый промпт сессии) блок не создаёт", async () => {
    const bb = new BlockBuilder(80, 24);
    await feed(bb, "\x1b]133;D;0\x07");
    expect(bb.blocks).toHaveLength(0);
  });

  it("id растут подряд, команда и cwd не утекают в следующий блок", async () => {
    const bb = new BlockBuilder(80, 24);
    await feed(bb, "\x1b]633;E;first\x07\x1b]133;C\x07a\r\n\x1b]133;D;0\x07");
    await feed(bb, "\x1b]133;C\x07b\r\n\x1b]133;D;0\x07");

    expect(bb.blocks.map((b) => [b.id, b.cmd, b.output])).toEqual([
      [0, "first", "a"],
      [1, null, "b"],
    ]);
  });

  it("длинная строка, перенесённая терминалом, склеивается обратно в одну", async () => {
    const bb = new BlockBuilder(10, 24);
    await feed(bb, "\x1b]133;C\x07");
    await feed(bb, "0123456789ABCDEF\r\n");
    await feed(bb, "\x1b]133;D;0\x07");

    expect(bb.blocks[0].output).toBe("0123456789ABCDEF");
  });

  it("маркер, разрезанный границей чанков, всё равно разбирается", async () => {
    const bb = new BlockBuilder(80, 24);
    await feed(bb, "\x1b]633;E;sl");
    await feed(bb, "eep 1\x07\x1b]13");
    await feed(bb, "3;C\x07ok\r\n\x1b]133;D;0\x07");

    expect(bb.blocks[0]).toMatchObject({ cmd: "sleep 1", output: "ok", exitCode: 0 });
  });

  it("atPromptStart: true между B и C, false после C", async () => {
    const bb = new BlockBuilder(80, 24);
    expect(bb.atPromptStart).toBe(false);
    await feed(bb, "\x1b]133;B\x07");
    expect(bb.atPromptStart).toBe(true);
    await feed(bb, "\x1b]133;C\x07");
    expect(bb.atPromptStart).toBe(false);
  });

  it("oscLog хранит сырой текст каждого разобранного маркера", async () => {
    const bb = new BlockBuilder(80, 24);
    await feed(bb, "\x1b]133;A\x07\x1b]633;E;x\x07\x1b]7;file://h/tmp\x07");

    expect(bb.oscLog).toEqual([
      { kind: "133", raw: "A" },
      { kind: "633", raw: "E;x" },
      { kind: "7", raw: "file://h/tmp" },
    ]);
  });
});
