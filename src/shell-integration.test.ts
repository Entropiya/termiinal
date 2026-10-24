import { describe, expect, it } from "vitest";
import { buildIntegrationLine } from "./shell-integration";

describe("buildIntegrationLine", () => {
  const line = buildIntegrationLine();

  it("одна логическая строка: ни переводов строки, ни настоящего ESC-байта", () => {
    expect(line).not.toMatch(/[\r\n\x1b]/);
  });

  it("начинается с пробела (HISTCONTROL=ignorespace) и самоудаляется из истории", () => {
    expect(line.startsWith(" ")).toBe(true);
    expect(line).toContain("history -d");
  });

  it("содержит все маркеры, на которые рассчитан парсер", () => {
    for (const marker of ["]633;E;", "]133;C", "]133;D;", "]133;A", "]133;B", "]7;file://"]) {
      expect(line).toContain(marker);
    }
  });
});
