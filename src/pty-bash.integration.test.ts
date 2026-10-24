// Интеграция "Rust PTY-бэкенд → настоящий bash → BlockBuilder": внедряем ту же строку
// shell integration, что и приложение (buildIntegrationLine), гоняем команды и смотрим,
// какие блоки выдал парсер. Только Linux/macOS: нужен bash и Unix-бэкенд; на Windows
// то же самое покрывает e2e через tauri-driver.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BlockBuilder } from "./osc-blocks";
import { buildIntegrationLine } from "./shell-integration";

function capture(lines: string[]): Uint8Array {
  const r = spawnSync(
    "cargo",
    ["run", "--quiet", "--manifest-path", "src-tauri/Cargo.toml", "--example", "pty_capture", "--", "250", "bash", "--norc", "--noprofile", "-i"],
    { input: lines.join("\n") + "\n", maxBuffer: 16 * 1024 * 1024, timeout: 280_000 },
  );
  if (r.status !== 0) throw new Error(`pty_capture failed: ${r.stderr?.toString()}`);
  return new Uint8Array(r.stdout);
}

function feedAll(bb: BlockBuilder, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve) => bb.feed(bytes, resolve));
}

describe.skipIf(process.platform === "win32")("bash под PTY → BlockBuilder", () => {
  it("выдаёт по блоку на команду с cmd, кодом возврата и выводом", { timeout: 300_000 }, async () => {
    const bytes = capture([
      buildIntegrationLine(),
      "echo hello-$((40 + 2))",
      "false",
      "printf 'a\\nb\\n'",
      "exit",
    ]);

    const bb = new BlockBuilder(120, 40);
    await feedAll(bb, bytes);

    const blocks = bb.blocks.filter((b) => b.cmd !== null && b.cmd !== "exit");
    expect(blocks.map((b) => b.cmd)).toEqual(["echo hello-$((40 + 2))", "false", "printf 'a\\nb\\n'"]);
    expect(blocks.map((b) => b.exitCode)).toEqual([0, 1, 0]);
    expect(blocks[0].output).toBe("hello-42");
    expect(blocks[1].output).toBe("");
    expect(blocks[2].output).toBe("a\nb");
    // cwd пришёл через OSC 7 и в блок попал
    expect(blocks[0].cwd).toMatch(/^\//);
  });
});
