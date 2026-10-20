// Затирание секретов (ТЗ, разд. "Безопасность и приватность"). Затирается ЗНАЧЕНИЕ,
// а не вся строка — агент по-прежнему видит форму: пустые значения, лишние кавычки,
// пробелы вокруг `=`. Это поведение по умолчанию, а не гарантия: пароль в переменной
// с невинным именем (например `FOO=hunter2`) пролетит, как и прямо сказано в ТЗ.
//
// Применяется ко ВСЕМУ, что уходит агенту: вывод блока, текст команды, сообщения в
// чат. Что видит сам пользователь в терминале — не трогаем, редактируем только копию,
// которая идёт в сторону Claude.

/** Слова, по которым ловим имя ключа — обязательно целым словом-сегментом, не подстрокой. */
const SECRET_WORDS = new Set(["PASS", "PASSWORD", "SECRET", "TOKEN", "KEY", "CREDENTIAL"]);

/** Разбивает идентификатор на слова-сегменты по `_`/`-`/`.` и границам camelCase/PascalCase. */
function splitIdentifierWords(ident: string): string[] {
  const bySep = ident.split(/[_.-]+/).filter(Boolean);
  const words: string[] = [];
  const camelRe = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;
  for (const part of bySep) {
    const matches = part.match(camelRe);
    if (matches) words.push(...matches);
    else words.push(part);
  }
  return words;
}

function isSecretKeyName(ident: string): boolean {
  return splitIdentifierWords(ident).some((w) => SECRET_WORDS.has(w.toUpperCase()));
}

function redactionMarker(value: string, quoted: boolean): string {
  return `<скрыто: ${value.length} симв., ${quoted ? "в кавычках" : "без кавычек"}>`;
}

/** Несколько проходов идут по одному и тому же тексту последовательно (см. redactSecrets),
 * поэтому более общий проход (особенно env-стиль `identifier=значение`) может случайно
 * выхватить маркер, который уже поставил предыдущий проход — например, из `--token=<скрыто:
 * ...>` после прохода CLI-аргументов получился бы повторно "отредактированный" огрызок
 * `<скрыто:`, оставив хвост маркера висеть текстом рядом. Эта проверка — универсальный
 * стоп-кран от такого двойного затирания, независимо от порядка проходов. */
function looksAlreadyRedacted(value: string): boolean {
  // Намеренно проверяем только по началу, а не по всей форме маркера: более узкий
  // "голый" проход (env-стиль) может выхватить только ОБРЕЗОК маркера до первого
  // пробела внутри него (сам маркер содержит пробелы — "N симв., без кавычек") и не
  // дотянуть до конца строки с цифрой/запятой, так что полный `/.../` здесь не подойдёт.
  return value.startsWith("<скрыто:");
}

/** `ИМЯ=значение` — shell/env-стиль, с учётом необязательных кавычек и пробелов вокруг `=`. */
function redactEnvStyle(text: string): string {
  // ключ -- пробелы? = пробелы? -- (кавычка значение той же кавычки | без кавычек до пробела/конца)
  return text.replace(
    /\b([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*=[ \t]*)(?:(["'])([^\n]*?)\3|([^\s"'][^\s]*)?)/g,
    (full, key: string, eq: string, quote: string | undefined, quotedVal: string | undefined, bareVal: string | undefined) => {
      if (!isSecretKeyName(key)) return full;
      const value = quote ? quotedVal ?? "" : bareVal ?? "";
      if (value === "" && !quote) return full; // "FOO=" без значения — нечего прятать
      if (looksAlreadyRedacted(value)) return full;
      const marker = redactionMarker(value, !!quote);
      return quote ? `${key}${eq}${quote}${marker}${quote}` : `${key}${eq}${marker}`;
    },
  );
}

/** `key: value` — YAML-стиль (по одной паре на строку). */
function redactYamlStyle(text: string): string {
  return text.replace(
    /^(\s*)(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*:\s*)(.+)$/gm,
    (full, indent: string, _q: string, key: string, sep: string, value: string) => {
      if (!isSecretKeyName(key)) return full;
      const trimmed = value.trim();
      if (trimmed === "") return full;
      const quoted = /^(["']).*\1$/.test(trimmed);
      const inner = quoted ? trimmed.slice(1, -1) : trimmed;
      if (looksAlreadyRedacted(inner)) return full;
      const marker = redactionMarker(inner, quoted);
      return `${indent}${key}${sep}${marker}`;
    },
  );
}

/** `"key": "value"` — JSON-стиль. */
function redactJsonStyle(text: string): string {
  return text.replace(
    /"([A-Za-z_][A-Za-z0-9_.-]*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
    (full, key: string, sep: string, value: string) => {
      if (!isSecretKeyName(key)) return full;
      if (value === "" || looksAlreadyRedacted(value)) return full;
      return `"${key}"${sep}"${redactionMarker(value, true)}"`;
    },
  );
}

/** `--password x`, `--password=x`, `--token=x` — аргументы командной строки. */
function redactCliArgs(text: string): string {
  let out = text.replace(
    /(--[A-Za-z][A-Za-z0-9-]*)(=)([^\s]+)/g,
    (full, flag: string, eq: string, value: string) => {
      if (!isSecretKeyName(flag.slice(2)) || looksAlreadyRedacted(value)) return full;
      return `${flag}${eq}${redactionMarker(value, false)}`;
    },
  );
  out = out.replace(
    /(--[A-Za-z][A-Za-z0-9-]*)( +)([^\s-][^\s]*)/g,
    (full, flag: string, sp: string, value: string) => {
      if (!isSecretKeyName(flag.slice(2)) || looksAlreadyRedacted(value)) return full;
      return `${flag}${sp}${redactionMarker(value, false)}`;
    },
  );
  return out;
}

/** `mysql -pSECRET` — пароль, приклеенный прямо к `-p` без пробела, специфично для mysql-клиентов. */
function redactMysqlDashP(text: string): string {
  if (!/\b(mysql|mysqldump)\b/i.test(text)) return text;
  return text.replace(/(^|\s)(-p)(\S+)/g, (full, pre: string, flag: string, value: string) => {
    if (looksAlreadyRedacted(value)) return full;
    return `${pre}${flag}${redactionMarker(value, false)}`;
  });
}

/** `Authorization: Bearer <token>`. */
function redactAuthHeader(text: string): string {
  return text.replace(
    /(Authorization:\s*Bearer\s+)(\S+)/gi,
    (full, pre: string, token: string) => (looksAlreadyRedacted(token) ? full : `${pre}${redactionMarker(token, false)}`),
  );
}

/** Пароль в URL: `scheme://user:pass@host`. */
function redactUrlPassword(text: string): string {
  return text.replace(
    /(:\/\/[^\s:/@]+:)([^\s@]+)(@)/g,
    (full, pre: string, pass: string, at: string) =>
      looksAlreadyRedacted(pass) ? full : `${pre}${redactionMarker(pass, false)}${at}`,
  );
}

/** Префиксы и форматы значений, независимо от имени ключа рядом. */
function redactKnownFormats(text: string): string {
  let out = text;
  const formats: Array<[RegExp, string]> = [
    [/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_"],
    [/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-"],
    [/\bAKIA[A-Z0-9]{16}\b/g, "AKIA"],
    [/\bxox[bp]-[A-Za-z0-9-]{10,}\b/g, "xox[bp]-"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "JWT"],
  ];
  for (const [re, label] of formats) {
    out = out.replace(re, (m) => `<скрыто: формат ${label}, ${m.length} симв.>`);
  }
  out = out.replace(
    /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    (m) => `<скрыто: приватный ключ, ${m.length} симв.>`,
  );
  return out;
}

/** Главная точка входа — всё, что уходит агенту (вывод блока, текст команды, чат), идёт через неё. */
export function redactSecrets(text: string): string {
  let out = text;
  out = redactKnownFormats(out);
  out = redactAuthHeader(out);
  out = redactUrlPassword(out);
  out = redactMysqlDashP(out);
  out = redactCliArgs(out);
  out = redactJsonStyle(out);
  out = redactYamlStyle(out);
  out = redactEnvStyle(out);
  return out;
}
