import { describe, expect, it } from "vitest";
import { agentStartArgs } from "./agent";
import {
  DEFAULT_MODEL_ID,
  findModel,
  loadOpenAiKey,
  loadSelectedModel,
  MODELS,
  saveOpenAiKey,
  saveSelectedModel,
} from "./models";
import systemPrompt from "./system-prompt.md?raw";

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("список моделей", () => {
  it("есть и Claude, и ChatGPT; id уникальны; модель по умолчанию в списке", () => {
    expect(new Set(MODELS.map((m) => m.provider))).toEqual(new Set(["claude", "openai"]));
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
    expect(MODELS.some((m) => m.id === DEFAULT_MODEL_ID)).toBe(true);
  });

  it("неизвестный id падает на модель по умолчанию", () => {
    expect(findModel("nope").id).toBe(DEFAULT_MODEL_ID);
    expect(findModel(null).id).toBe(DEFAULT_MODEL_ID);
  });

  it("выбор запоминается; битое хранилище не роняет", () => {
    const store = memoryStore();
    expect(loadSelectedModel(store).id).toBe(DEFAULT_MODEL_ID);
    saveSelectedModel(store, "gpt-6.1-sol");
    expect(loadSelectedModel(store).id).toBe("gpt-6.1-sol");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadSelectedModel(broken).id).toBe(DEFAULT_MODEL_ID);
    expect(() => saveSelectedModel(broken, "gpt-6.1-sol")).not.toThrow();
  });

  it("ключ OpenAI хранится обрезанным по краям", () => {
    const store = memoryStore();
    expect(loadOpenAiKey(store)).toBe("");
    saveOpenAiKey(store, "  sk-abc \n");
    expect(loadOpenAiKey(store)).toBe("sk-abc");
  });
});

describe("поведение моделей задаётся одним файлом", () => {
  it("системный промпт — один и тот же для Claude и ChatGPT, байт в байт", () => {
    const claude = agentStartArgs({ systemPrompt, provider: "claude", model: "claude-haiku-5-5" });
    const gpt = agentStartArgs({ systemPrompt, provider: "openai", model: "gpt-6.1-sol", apiKey: "sk-x" });
    expect(claude.systemPrompt).toBe(gpt.systemPrompt);
    expect(claude.provider).toBe("claude");
    expect(gpt.provider).toBe("openai");
  });

  it("ключ уходит только провайдеру openai", () => {
    expect(agentStartArgs({ systemPrompt: "p", provider: "claude", apiKey: "sk-x" }).apiKey).toBeNull();
    expect(agentStartArgs({ systemPrompt: "p", provider: "openai", apiKey: "" }).apiKey).toBeNull();
    expect(agentStartArgs({ systemPrompt: "p" }).provider).toBe("claude");
  });

  it("src/system-prompt.md описывает контракт ответа, который разбирает приложение", () => {
    expect(systemPrompt.length).toBeGreaterThan(500);
    for (const marker of ["SKIP", "`bash`", "`plan`", "`mermaid`", "[Контекст]", "никогда не выполняешь команды"]) {
      expect(systemPrompt).toContain(marker);
    }
  });
});
