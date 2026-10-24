// Интеграция "Rust PTY-бэкенд → настоящий PowerShell с нашим -EncodedCommand → BlockBuilder".
// Тест сам играет роль терминала: ответы на запросы позиции курсора (ESC[6n) даёт headless-xterm из
// BlockBuilder, без этого PowerShell на PTY молчит. Нужен `pwsh` (PowerShell 7) в PATH или в PWSH_BIN;
// для Windows PowerShell 5.1 тот же сценарий проходит e2e на Windows-раннере. Без pwsh тест пропускается.

import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BlockBuilder } from "./osc-blocks";
import { powerShellArgs } from "./shell-integration";

const PWSH = process.env.PWSH_BIN ?? "pwsh";
const hasPwsh =
  process.platform !== "win32" && spawnSync(PWSH, ["-NoProfile", "-Command", "1"], { stdio: "ignore" }).status === 0;

async function waitFor(cond: () => boolean, what: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hasPwsh)("PowerShell под PTY → BlockBuilder", () => {
  it("выдаёт по блоку на команду с cmd, кодом возврата и выводом", { timeout: 300_000 }, async () => {
    const build = spawnSync(
      "cargo",
      ["build", "--quiet", "--manifest-path", "src-tauri/Cargo.toml", "--example", "pty_capture"],
      { timeout: 280_000 },
    );
    if (build.status !== 0) throw new Error(`cargo build failed: ${build.stderr?.toString()}`);

    const child = spawn("src-tauri/target/debug/examples/pty_capture", ["0", PWSH, ...powerShellArgs()], {
      env: { ...process.env, PTY_CAPTURE_RAW: "1" },
    });
    const bb = new BlockBuilder(120, 40);
    let prompts = 0; // сколько раз показан промпт (OSC 133;B)
    bb.onOscEvent = (e) => {
      if (e.kind === "133" && e.raw === "B") prompts++;
    };
    bb.headless.onData((d) => child.stdin.write(d)); // ответы "терминала" (позиция курсора и т.п.)
    child.stdout.on("data", (chunk: Buffer) => bb.feed(new Uint8Array(chunk)));
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

    try {
      await waitFor(() => prompts >= 1, "первый промпт PowerShell");
      for (const cmd of ["echo ps-marker-7", "Get-Item /такого-пути-нет", "'a','b' | Write-Output"]) {
        const before = prompts;
        child.stdin.write(cmd + "\r");
        await waitFor(() => prompts > before, `промпт после «${cmd}»`);
      }
      child.stdin.write("exit\r");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    } finally {
      child.kill();
    }

    const blocks = bb.blocks.filter((b) => b.cmd !== null && b.cmd !== "exit");
    expect(blocks.map((b) => b.cmd)).toEqual(["echo ps-marker-7", "Get-Item /такого-пути-нет", "'a','b' | Write-Output"]);
    expect(blocks.map((b) => b.exitCode)).toEqual([0, 1, 0]);
    expect(blocks[0].output).toBe("ps-marker-7");
    expect(blocks[1].output).toContain("такого-пути-нет");
    expect(blocks[2].output).toBe("a\nb");
    expect(blocks[0].cwd).toMatch(/^\//);
  });
});
