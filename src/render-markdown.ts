// Рендер ответа агента (ТЗ, разд. "Контракт ответа агента и рендеринг"): markdown-it +
// DOMPurify. Подсветка кода через shiki и схемы через mermaid.js — отдельный, более
// тяжёлый шаг, пока не подключены; код-блоки рендерятся как обычный <pre><code>.
//
// DOMPurify обязателен: текст агента в итоге происходит из вывода чужого шелла (блоки),
// а значит потенциально содержит промпт-инъекцию — если бы рендерили как есть, вредный
// лог через агента мог бы исполнить JS внутри приложения, у которого есть доступ к PTY.

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({
  html: false, // сырой HTML в markdown агента отключён, см. ТЗ "Рендер без исполнения"
  linkify: true,
  breaks: true,
});

export function renderAgentMarkdown(text: string): string {
  const html = md.render(text);
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i });
}
