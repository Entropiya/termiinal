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

import { buildPowerShellIntegrationScript, encodePowerShellCommand, powerShellArgs } from "./shell-integration";

describe("PowerShell-интеграция", () => {
  const script = buildPowerShellIntegrationScript();

  it("не содержит настоящих управляющих байтов: ESC/BEL строятся через [char]", () => {
    expect(script).not.toMatch(/[\x1b\x07\r]/);
    expect(script).toContain("[char]27");
  });

  it("шлёт все маркеры, на которые рассчитан парсер", () => {
    for (const marker of ["]133;D;", "]133;A", "]133;B", "]133;C", "]633;E;", "]7;file://"]) {
      expect(script).toContain(marker);
    }
  });

  it("совместима с Windows PowerShell 5.1: без `e, &&, ??, тернарных операторов", () => {
    expect(script).not.toMatch(/`e|&&|\?\?|\?\s.*\s:\s/);
  });

  it("кодируется в -EncodedCommand (base64 UTF-16LE) без потерь", () => {
    const enc = encodePowerShellCommand(script);
    const decoded = Buffer.from(enc, "base64").toString("utf16le");
    expect(decoded).toBe(script);
    expect(powerShellArgs()).toEqual(["-NoLogo", "-NoExit", "-EncodedCommand", enc]);
  });

  it("поместится в командную строку Windows с большим запасом", () => {
    expect(encodePowerShellCommand(script).length).toBeLessThan(8000);
  });
});
