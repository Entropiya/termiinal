import { describe, expect, it } from "vitest";
import { shouldSendBlock, formatBlocksForAgent, DEFAULT_BLACKLIST } from "./block-agent";
import type { Block } from "./osc-blocks";

const blacklist = new Set(DEFAULT_BLACKLIST);

function block(partial: Partial<Block>): Block {
  return { id: 0, cmd: null, cwd: null, exitCode: 0, output: "", startRow: 0, endRow: 1, ...partial };
}

describe("shouldSendBlock", () => {
  it("auto: обычная команда уходит", () => {
    expect(shouldSendBlock("auto", blacklist, block({ cmd: "apt update" }))).toBe(true);
  });

  it("auto: команда из чёрного списка не уходит", () => {
    expect(shouldSendBlock("auto", blacklist, block({ cmd: "ls -la" }))).toBe(false);
  });

  it("auto: 'cd /' тоже чёрный список (по первому слову)", () => {
    expect(shouldSendBlock("auto", blacklist, block({ cmd: "cd /var/log" }))).toBe(false);
  });

  it("errors-only: пропускает успешные", () => {
    expect(shouldSendBlock("errors-only", blacklist, block({ cmd: "apt update", exitCode: 0 }))).toBe(false);
  });

  it("errors-only: пропускает ошибки", () => {
    expect(shouldSendBlock("errors-only", blacklist, block({ cmd: "apt update", exitCode: 1 }))).toBe(true);
  });

  it("manual: ничего само не уходит", () => {
    expect(shouldSendBlock("manual", blacklist, block({ cmd: "apt update", exitCode: 1 }))).toBe(false);
  });

  it("чёрный список всегда приоритетнее, даже при ошибке", () => {
    expect(shouldSendBlock("errors-only", blacklist, block({ cmd: "pwd", exitCode: 1 }))).toBe(false);
  });
});

describe("formatBlocksForAgent", () => {
  it("один блок", () => {
    const text = formatBlocksForAgent([block({ cmd: "apt update", cwd: "/root", exitCode: 0, output: "Hit:1 ..." })]);
    expect(text).toContain("$ apt update");
    expect(text).toContain("exit=0");
    expect(text).toContain("Hit:1 ...");
  });

  it("пачка из нескольких блоков склеивается через пустую строку", () => {
    const text = formatBlocksForAgent([block({ cmd: "a" }), block({ cmd: "b" })]);
    expect(text).toBe(
      "[БЛОК] cwd=? exit=0\n$ a\n\n\n[БЛОК] cwd=? exit=0\n$ b\n",
    );
  });

  it("живой снимок (running) не пишет exit= — агент не должен принять его за итог", () => {
    const text = formatBlocksForAgent([
      block({ cmd: "apt update", exitCode: null, running: true, output: "Hit:1 ..." }),
    ]);
    expect(text).not.toContain("exit=");
    expect(text).toContain("ВЫПОЛНЯЕТСЯ");
    expect(text).toContain("Hit:1 ...");
  });
});
