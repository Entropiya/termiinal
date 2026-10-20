// Тонкая обёртка над Rust-командами pty_* и их событиями.
// Байты идут через IPC как base64 (см. src-tauri/src/pty.rs) — здесь декодируются
// в Uint8Array и передаются как есть в xterm.js/@xterm/headless, без прогона через
// строковый UTF-8 на границе Rust/JS (это и есть то, что мы проверяем на этапе 1).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PtyHandle {
  id: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function spawnPty(opts: {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number | null) => void;
}): Promise<PtyHandle & { dispose(): void }> {
  const id = await invoke<string>("pty_spawn", {
    program: opts.program,
    args: opts.args ?? [],
    cwd: opts.cwd ?? null,
    env: opts.env ?? null,
    cols: opts.cols,
    rows: opts.rows,
  });

  const unlistenData: UnlistenFn = await listen<{ id: string; dataB64: string }>(
    "pty-output",
    (event) => {
      if (event.payload.id !== id) return;
      opts.onData(b64ToBytes(event.payload.dataB64));
    },
  );

  const unlistenExit: UnlistenFn = await listen<{ id: string; code: number | null }>(
    "pty-exit",
    (event) => {
      if (event.payload.id !== id) return;
      opts.onExit(event.payload.code);
    },
  );

  return {
    id,
    write: (data: string) => invoke("pty_write", { id, data }),
    resize: (cols: number, rows: number) => invoke("pty_resize", { id, cols, rows }),
    kill: () => invoke("pty_kill", { id }),
    dispose() {
      unlistenData();
      unlistenExit();
    },
  };
}
