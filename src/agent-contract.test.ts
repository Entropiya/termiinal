import { describe, expect, it } from "vitest";
import { parseAgentResponse } from "./agent-contract";

describe("parseAgentResponse", () => {
  it("SKIP распознаётся ровно", () => {
    const r = parseAgentResponse("SKIP");
    expect(r.isSkip).toBe(true);
  });

  it("SKIP с лишними пробелами вокруг всё ещё распознаётся (терпимость парсера)", () => {
    const r = parseAgentResponse("  SKIP\n");
    expect(r.isSkip).toBe(true);
  });

  it("текст 'SKIP' внутри обычного ответа не триггерит isSkip", () => {
    const r = parseAgentResponse("Команда ещё выполняется, SKIP тут не при чём.");
    expect(r.isSkip).toBe(false);
  });

  it("первая строка — summary", () => {
    const r = parseAgentResponse("Всё ок, сеть поднялась\n\nПодробности: ...");
    expect(r.summary).toBe("Всё ок, сеть поднялась");
  });

  it("достаёт ```bash блок", () => {
    const r = parseAgentResponse("Попробуй:\n```bash\napt update\n```\n");
    expect(r.bashBlocks).toEqual(["apt update"]);
  });

  it("терпим к sh/shell/без языка", () => {
    const r = parseAgentResponse("```sh\nls\n```\n```shell\npwd\n```\n```\nwhoami\n```");
    expect(r.bashBlocks).toEqual(["ls", "pwd", "whoami"]);
  });

  it("несколько ```bash блоков — все достаются", () => {
    const r = parseAgentResponse("```bash\ncmd1\n```\nещё\n```bash\ncmd2\n```");
    expect(r.bashBlocks).toEqual(["cmd1", "cmd2"]);
  });

  it("```plan блок с чек-листом", () => {
    const r = parseAgentResponse("```plan\n- [x] шаг1\n- [ ] шаг2\n```");
    expect(r.plan).toBe("- [x] шаг1\n- [ ] шаг2");
  });

  it("```mermaid блок", () => {
    const r = parseAgentResponse("```mermaid\nflowchart TD\nA-->B\n```");
    expect(r.mermaidBlocks).toEqual(["flowchart TD\nA-->B"]);
  });

  it("не распознанная структура — raw доступен как есть, не падает", () => {
    const text = "просто текст без разметки";
    const r = parseAgentResponse(text);
    expect(r.raw).toBe(text);
    expect(r.bashBlocks).toEqual([]);
    expect(r.plan).toBeNull();
  });
});
