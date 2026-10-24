import { describe, expect, it } from "vitest";
import { agentStartArgs } from "./agent";
import { addRules, loadRules, MAX_RULES, removeRule, saveRules } from "./playbook";
import { parseAgentResponse } from "./agent-contract";
import { buildSystemPrompt, DEFAULT_STYLE, loadStyle, parseStyle, saveStyle } from "./prompts";
import basePrompt from "./system-prompt.md?raw";
import teachingPrompt from "./system-prompt-teaching.md?raw";

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("системный промпт по режимам", () => {
  it("прямой режим — это ровно основа, режим обучения — основа + раздел обучения", () => {
    expect(buildSystemPrompt("direct")).toBe(basePrompt);
    const teach = buildSystemPrompt("teach");
    expect(teach.startsWith(basePrompt.trimEnd())).toBe(true);
    expect(teach).toContain(teachingPrompt.trim());
  });

  it("по умолчанию — обучение", () => {
    expect(DEFAULT_STYLE).toBe("teach");
    expect(loadStyle(memoryStore())).toBe("teach");
  });

  it("раздел обучения описывает лесенку, правило и запрет приказов", () => {
    for (const marker of ["Лесенка подсказок", "Наводка", "Направление", "Решение", "`rule`", "Предлагай, не приказывай", "SKIP"]) {
      expect(teachingPrompt).toContain(marker);
    }
  });

  it("Claude и ChatGPT получают одинаковый текст в обоих режимах", () => {
    for (const style of ["teach", "direct"] as const) {
      const systemPrompt = buildSystemPrompt(style);
      const claude = agentStartArgs({ systemPrompt, provider: "claude", model: "claude-haiku-5-5" });
      const gpt = agentStartArgs({ systemPrompt, provider: "openai", model: "gpt-6.1-sol", apiKey: "k" });
      expect(gpt.systemPrompt).toBe(claude.systemPrompt);
    }
  });

  it("режим запоминается; мусор в хранилище даёт режим по умолчанию", () => {
    const store = memoryStore();
    saveStyle(store, "direct");
    expect(loadStyle(store)).toBe("direct");
    expect(parseStyle("что-то странное")).toBe("teach");
    expect(parseStyle(null)).toBe("teach");
  });
});

describe("блок rule в ответе агента", () => {
  it("попадает в rules и не считается командой для вставки", () => {
    const parsed = parseAgentResponse("Итог.\n\n```rule\nСначала ls, потом rm.\n```\n\n```bash\nls\n```");
    expect(parsed.rules).toEqual(["Сначала ls, потом rm."]);
    expect(parsed.bashBlocks).toEqual(["ls"]);
  });

  it("пустой rule и ответ без rule дают пустой список; SKIP тоже", () => {
    expect(parseAgentResponse("Текст.\n\n```rule\n\n```").rules).toEqual([]);
    expect(parseAgentResponse("просто текст").rules).toEqual([]);
    expect(parseAgentResponse("SKIP").rules).toEqual([]);
  });
});

describe("правила на запомнить", () => {
  it("новые правила в начале, повторы без учёта регистра и пробелов отбрасываются", () => {
    let rules = addRules([], ["Правило  раз", "правило два"]);
    expect(rules).toEqual(["Правило раз", "правило два"]);
    rules = addRules(rules, ["ПРАВИЛО РАЗ", "Правило три", "  "]);
    expect(rules).toEqual(["Правило три", "Правило раз", "правило два"]);
  });

  it("список ограничен, удаление по индексу", () => {
    const many = Array.from({ length: MAX_RULES + 20 }, (_, i) => `r${i}`);
    expect(addRules([], many)).toHaveLength(MAX_RULES);
    expect(removeRule(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });

  it("сохраняются; битое хранилище не роняет", () => {
    const store = memoryStore();
    expect(loadRules(store)).toEqual([]);
    saveRules(store, ["a", "b"]);
    expect(loadRules(store)).toEqual(["a", "b"]);
    store.setItem("termiinal:rules", "{не json");
    expect(loadRules(store)).toEqual([]);
    store.setItem("termiinal:rules", JSON.stringify(["ok", 5, null]));
    expect(loadRules(store)).toEqual(["ok"]);
  });
});
