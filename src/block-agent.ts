// Политика "когда блок уходит агенту" (ТЗ, разд. "Когда вызывается агент") — только
// чистые функции: решение "слать или нет" + форматирование. Очередь/занятость агента —
// это уже состояние конкретной сессии, живёт в main.ts, а не здесь.

import type { Block } from "./osc-blocks";

export type AgentPolicy = "auto" | "errors-only" | "manual";

export const DEFAULT_BLACKLIST = ["cd", "ls", "clear", "pwd", "history", "exit"];

function baseCommand(cmd: string | null): string {
  if (!cmd) return "";
  return cmd.trim().split(/\s+/, 1)[0] ?? "";
}

/** Решает, уходит ли ЗАКРЫТЫЙ блок агенту согласно текущей политике. Хоткей "глянь"
 * эту функцию не вызывает вовсе — он форсирует отправку в обход политики и списка. */
export function shouldSendBlock(policy: AgentPolicy, blacklist: Set<string>, b: Block): boolean {
  if (blacklist.has(baseCommand(b.cmd))) return false;
  if (policy === "manual") return false;
  if (policy === "errors-only") return b.exitCode !== null && b.exitCode !== 0;
  return true;
}

/** Склеивает один или несколько блоков (пачка, см. ТЗ "Пачки") в одно сообщение агенту. */
export function formatBlocksForAgent(blocks: Block[]): string {
  return blocks.map(formatOneBlock).join("\n\n");
}

function formatOneBlock(b: Block): string {
  return `[БЛОК] cwd=${b.cwd ?? "?"} exit=${b.exitCode ?? "?"}\n$ ${b.cmd ?? "(нет текста команды)"}\n${b.output}`;
}
