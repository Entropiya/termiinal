// Разбор контракта ответа агента (ТЗ, разд. "Контракт ответа агента и рендеринг").
// Парсер терпим к отклонениям: если что-то не распозналось, просто не попадает в
// соответствующее поле — вызывающий код показывает `raw` как есть, приложение не падает.

export interface ParsedAgentResponse {
  /** Первая строка ответа — показывается в свёрнутом блоке. Пустая строка, если SKIP. */
  summary: string;
  /** Ответ был ровно "SKIP" — блок под командой создавать не нужно. */
  isSkip: boolean;
  /** Содержимое ```bash/```sh/```shell/``` (без языка) блоков — кандидаты на вставку. */
  bashBlocks: string[];
  /** Содержимое последнего ```plan блока (чек-лист `- [ ]`/`- [x]`), если был. */
  plan: string | null;
  /** Содержимое ```mermaid блоков. */
  mermaidBlocks: string[];
  /** Исходный текст целиком — для рендера как есть, когда остальное не пригодилось. */
  raw: string;
}

export interface PlanItem {
  text: string;
  done: boolean;
}

const FENCE_RE = /```([A-Za-z]*)\n([\s\S]*?)```/g;
const BASH_LANGS = new Set(["bash", "sh", "shell", ""]);

export function parseAgentResponse(text: string): ParsedAgentResponse {
  const trimmed = text.trim();
  if (trimmed === "SKIP") {
    return { summary: "", isSkip: true, bashBlocks: [], plan: null, mermaidBlocks: [], raw: text };
  }

  const bashBlocks: string[] = [];
  const mermaidBlocks: string[] = [];
  let plan: string | null = null;

  for (const m of text.matchAll(FENCE_RE)) {
    const lang = m[1].toLowerCase();
    const body = m[2].replace(/\n$/, "");
    if (BASH_LANGS.has(lang)) bashBlocks.push(body);
    else if (lang === "plan") plan = body;
    else if (lang === "mermaid") mermaidBlocks.push(body);
  }

  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";

  return {
    summary: firstLine,
    isSkip: false,
    bashBlocks,
    plan,
    mermaidBlocks,
    raw: text,
  };
}

const PLAN_ITEM_RE = /^\s*-\s*\[([ xX])\]\s*(.+)$/;

/** Разбирает чек-лист из ```plan блока (ТЗ: `- [ ]` / `- [x]`) в структурированный
 * список. Строки, не похожие на пункт чек-листа, пропускаются — терпимый парсер, как
 * и весь контракт ответа: агент может добавить вступление или сноску внутри блока. */
export function parsePlanChecklist(markdown: string): PlanItem[] {
  const items: PlanItem[] = [];
  for (const line of markdown.split("\n")) {
    const m = PLAN_ITEM_RE.exec(line);
    if (!m) continue;
    items.push({ text: m[2].trim(), done: m[1].toLowerCase() === "x" });
  }
  return items;
}
