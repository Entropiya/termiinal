// Список моделей, между которыми можно переключаться, и их запоминание. Провайдер
// определяет адаптер на стороне Rust: "claude" — живой процесс `claude -p`, "openai" —
// ChatGPT по API (см. src-tauri/src/openai.rs). Системный промпт у всех один — src/system-prompt.md.
//
// Идентификаторы моделей OpenAI — просто строки, которые уходят в запрос как есть: если
// нужной модели нет в списке или имя поменялось, правится только эта таблица. Имена взяты из
// встроенного каталога Codex CLI 0.164 (`codex debug models`, supported_in_api), живьём с вашим
// ключом они не проверены.

export type Provider = "claude" | "openai";

export interface ModelOption {
  id: string;
  provider: Provider;
  label: string;
}

export const MODELS: readonly ModelOption[] = [
  { id: "claude-haiku-5-5", provider: "claude", label: "Claude Haiku 5.5" },
  { id: "claude-sonnet-5-5", provider: "claude", label: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", provider: "claude", label: "Claude Opus 5.5" },
  { id: "gpt-6.1-sol", provider: "openai", label: "ChatGPT gpt-6.1-sol" },
  { id: "gpt-6-luna", provider: "openai", label: "ChatGPT gpt-6-luna (быстрая, дешёвая)" },
];

// Самая дешёвая модель по умолчанию, как и раньше.
export const DEFAULT_MODEL_ID = "claude-haiku-5-5";

export function findModel(id: string | null | undefined): ModelOption {
  return MODELS.find((m) => m.id === id) ?? MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!;
}

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

const MODEL_KEY = "termiinal:agent-model";
const OPENAI_KEY_KEY = "termiinal:openai-key";

function safeGet(store: KeyValueStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null; // localStorage может быть недоступен — просто считаем, что пусто
  }
}

function safeSet(store: KeyValueStore, key: string, value: string) {
  try {
    store.setItem(key, value);
  } catch {
    // не сохранилось — не критично, останется выбор до перезапуска
  }
}

export function loadSelectedModel(store: KeyValueStore): ModelOption {
  return findModel(safeGet(store, MODEL_KEY));
}

export function saveSelectedModel(store: KeyValueStore, id: string) {
  safeSet(store, MODEL_KEY, findModel(id).id);
}

export function loadOpenAiKey(store: KeyValueStore): string {
  return safeGet(store, OPENAI_KEY_KEY) ?? "";
}

export function saveOpenAiKey(store: KeyValueStore, key: string) {
  safeSet(store, OPENAI_KEY_KEY, key.trim());
}
