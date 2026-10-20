// Обёртка над agent_* командами и протоколом `claude -p --input-format stream-json
// --output-format stream-json`. Формы событий ниже сняты живьём с claude-code 2.1.304
// (см. docs/stage2.md) — это не официально задокументированный формат, при смене
// версии CLI может потребоваться правка.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface InitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: string[];
  mcp_servers: unknown[];
  model: string;
}
interface AssistantEvent {
  type: "assistant";
  message: { content: Array<{ type: string; text?: string }> };
}
interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  result: string;
  total_cost_usd: number;
  duration_ms: number;
}
interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: { status: string; overageDisabledReason?: string };
}
interface StreamDeltaEvent {
  type: "stream_event";
  event: { type: string; delta?: { type: string; text?: string } };
}
type AgentLine =
  | InitEvent
  | AssistantEvent
  | ResultEvent
  | RateLimitEvent
  | StreamDeltaEvent
  | { type: string; [k: string]: unknown };

export interface AgentHandle {
  id: string;
  sendText(text: string): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}

export interface AgentCallbacks {
  /** Инициализация сессии — отсюда видно, реально ли изоляция пустая (tools/mcp_servers). */
  onInit?(e: InitEvent): void;
  /** Текстовая дельта для живого "печатания" ответа (необязательно использовать). */
  onTextDelta?(text: string): void;
  /** Полный текст ответа на завершённый ход диалога. */
  onTurnComplete?(text: string, costUsd: number, isError: boolean): void;
  onRateLimit?(e: RateLimitEvent): void;
  onStderr?(line: string): void;
  onExit?(code: number | null): void;
  /** Любая строка, которую не разобрали выше — на всякий случай, чтобы не терять данные. */
  onRaw?(line: AgentLine): void;
}

export async function startAgent(opts: {
  systemPrompt: string;
  model?: string;
  maxBudgetUsd?: number;
  callbacks: AgentCallbacks;
}): Promise<AgentHandle> {
  const id = await invoke<string>("agent_start", {
    systemPrompt: opts.systemPrompt,
    model: opts.model ?? null,
    maxBudgetUsd: opts.maxBudgetUsd ?? null,
  });

  const unlistenEvent: UnlistenFn = await listen<{ id: string; line: string }>(
    "agent-event",
    (ev) => {
      if (ev.payload.id !== id) return;
      let parsed: AgentLine;
      try {
        parsed = JSON.parse(ev.payload.line);
      } catch {
        opts.callbacks.onRaw?.({ type: "unparsed", line: ev.payload.line });
        return;
      }
      dispatch(parsed, opts.callbacks);
    },
  );

  const unlistenStderr: UnlistenFn = await listen<{ id: string; line: string }>(
    "agent-stderr",
    (ev) => {
      if (ev.payload.id !== id) return;
      opts.callbacks.onStderr?.(ev.payload.line);
    },
  );

  const unlistenExit: UnlistenFn = await listen<{ id: string; code: number | null }>(
    "agent-exit",
    (ev) => {
      if (ev.payload.id !== id) return;
      opts.callbacks.onExit?.(ev.payload.code);
    },
  );

  return {
    id,
    sendText: (text: string) => {
      const line = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      });
      return invoke("agent_send", { id, jsonLine: line });
    },
    stop: () => invoke("agent_stop", { id }),
    dispose() {
      unlistenEvent();
      unlistenStderr();
      unlistenExit();
    },
  };
}

function dispatch(ev: AgentLine, cb: AgentCallbacks) {
  switch (ev.type) {
    case "system":
      if ((ev as InitEvent).subtype === "init") cb.onInit?.(ev as InitEvent);
      break;
    case "stream_event": {
      const d = (ev as StreamDeltaEvent).event?.delta;
      if (d?.type === "text_delta" && d.text) cb.onTextDelta?.(d.text);
      break;
    }
    case "rate_limit_event":
      cb.onRateLimit?.(ev as RateLimitEvent);
      break;
    case "result": {
      const r = ev as ResultEvent;
      cb.onTurnComplete?.(r.result, r.total_cost_usd, r.is_error);
      break;
    }
    default:
      cb.onRaw?.(ev);
  }
}
