// Сборка системного промпта агента. Поведение моделей задают файлы, а не код:
//   - src/system-prompt.md          — основа (контекст, контракт ответа, безопасность);
//   - src/system-prompt-teaching.md — режим обучения: лесенка подсказок вместо готового ответа.
// Режим обучения — это основа + ещё один раздел, поэтому оба провайдера (Claude и ChatGPT)
// получают идентичный текст. Идея режима (одна идея за ответ, маленькая практика, правило на
// запомнить, «предлагай, не приказывай») взята из проекта Claudemy (MIT, Assaf Kipnis).

import basePrompt from "./system-prompt.md?raw";
import teachingPrompt from "./system-prompt-teaching.md?raw";

export type AnswerStyle = "teach" | "direct";

export interface StyleOption {
  id: AnswerStyle;
  label: string;
}

export const STYLES: readonly StyleOption[] = [
  { id: "teach", label: "Обучение" },
  { id: "direct", label: "Прямой ответ" },
];

// Пользователь хочет учиться, а не получать готовые команды, поэтому по умолчанию — обучение.
export const DEFAULT_STYLE: AnswerStyle = "teach";

export function buildSystemPrompt(style: AnswerStyle): string {
  return style === "teach" ? `${basePrompt.trimEnd()}\n\n${teachingPrompt.trim()}\n` : basePrompt;
}

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;
const STYLE_KEY = "termiinal:answer-style";

export function parseStyle(value: string | null | undefined): AnswerStyle {
  return STYLES.some((s) => s.id === value) ? (value as AnswerStyle) : DEFAULT_STYLE;
}

export function loadStyle(store: KeyValueStore): AnswerStyle {
  try {
    return parseStyle(store.getItem(STYLE_KEY));
  } catch {
    return DEFAULT_STYLE;
  }
}

export function saveStyle(store: KeyValueStore, style: AnswerStyle) {
  try {
    store.setItem(STYLE_KEY, parseStyle(style));
  } catch {
    // не сохранилось — останется выбор до перезапуска
  }
}
