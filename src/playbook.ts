// «Правила на запомнить»: в режиме обучения агент формулирует их блоком ```rule, приложение
// копит их у пользователя (идея плейбука из Claudemy). Хранилище — localStorage, как и пресеты.

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

const RULES_KEY = "termiinal:rules";
export const MAX_RULES = 100;

function norm(rule: string): string {
  return rule.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Новые правила — в начало списка; повтор (без учёта регистра и пробелов) не добавляется. */
export function addRules(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(existing.map(norm));
  const fresh: string[] = [];
  for (const r of incoming) {
    const clean = r.trim().replace(/\s+/g, " ");
    if (!clean || seen.has(norm(clean))) continue;
    seen.add(norm(clean));
    fresh.push(clean);
  }
  return [...fresh, ...existing].slice(0, MAX_RULES);
}

export function removeRule(rules: readonly string[], index: number): string[] {
  return rules.filter((_, i) => i !== index);
}

export function loadRules(store: KeyValueStore): string[] {
  try {
    const parsed = JSON.parse(store.getItem(RULES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

export function saveRules(store: KeyValueStore, rules: readonly string[]) {
  try {
    store.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    // не критично
  }
}
