// Проба при подключении (ТЗ, разд. "Подключения и пресеты"): скрытая POSIX-команда,
// обёрнутая маркерами, вывод которой пользователю не показывается. Даёт: по какому
// бинарнику определить шелл, имя хоста (им по умолчанию называется пресет) и ОС/версию
// (в контекст агенту — apt тут или opkg).
//
// ВАЖНО по тексту команды: `\033`/`\a` здесь — буквально 4-5 печатных ASCII-символов
// (backslash-0-3-3 и backslash-a), а НЕ настоящие управляющие байты. Реальный байт ESC
// печатает уже `printf` в момент выполнения — ровно та же причина, по которой пришлось
// переделывать src/shell-integration.ts: если встроить сюда настоящий байт ESC, эхо
// печатаемой строки (это ввод, не вывод) само попытается его интерпретировать.
export function buildProbeCommand(): string {
  return (
    "printf '\\033]1337;probe-start\\a'; readlink /proc/$$/exe; uname -n; " +
    "cat /etc/os-release 2>/dev/null; printf '\\033]1337;probe-end\\a'"
  );
}

const PROBE_START = "\x1b]1337;probe-start\x07";
const PROBE_END = "\x1b]1337;probe-end\x07";

export interface ProbeResult {
  shellPath: string | null;
  hostname: string | null;
  osId: string | null;
  osVersionId: string | null;
}

/** Копит сырые байты, пока не увидит маркер конца; вызывающий код решает сам, прятать
 * ли их от видимого терминала (см. main.ts — критично держать headless-копию в том же
 * решении, иначе разойдутся номера строк, на которых держится нарезка на блоки). */
export class ProbeCapture {
  private buffer = "";
  private decoder = new TextDecoder();
  done = false;

  /** true, пока чанк стоит прятать от пользователя. */
  feed(bytes: Uint8Array): boolean {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (this.buffer.includes(PROBE_END)) this.done = true;
    return true; // и чанк с самим маркером конца тоже прячем целиком — см. комментарий в main.ts
  }

  result(): ProbeResult | null {
    const startIdx = this.buffer.indexOf(PROBE_START);
    const endIdx = this.buffer.indexOf(PROBE_END);
    if (startIdx === -1 || endIdx === -1) return null;
    const inner = this.buffer.slice(startIdx + PROBE_START.length, endIdx);
    const lines = inner
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const shellPath = lines[0] ?? null;
    const hostname = lines[1] ?? null;
    let osId: string | null = null;
    let osVersionId: string | null = null;
    for (const line of lines.slice(2)) {
      const idMatch = /^ID=(.+)$/.exec(line);
      if (idMatch) osId = idMatch[1].replace(/^"|"$/g, "");
      const verMatch = /^VERSION_ID=(.+)$/.exec(line);
      if (verMatch) osVersionId = verMatch[1].replace(/^"|"$/g, "");
    }
    return { shellPath, hostname, osId, osVersionId };
  }
}

// Скрытая проба печатает команду в сессию и глушит весь вывод до маркера конца. Если в этот
// момент ssh ждёт ответа (первый вход: "Are you sure you want to continue connecting
// (yes/no)?", пароль, парольная фраза), проба уйдёт как ответ на вопрос, а сам вопрос и
// ответ пользователя пользователь не увидит. Поэтому пробу запускают, только когда
// последняя строка вывода НЕ похожа на запрос ввода.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

const INTERACTIVE_PROMPT_RES = [
  /\(yes\/no(?:\/\[fingerprint\])?\)\??\s*$/i, // Are you sure you want to continue connecting (yes/no/[fingerprint])?
  /continue connecting/i,
  /type 'yes'.*:\s*$/i, // Please type 'yes', 'no' or the fingerprint:
  /pass(?:word|phrase)[^\n]*:\s*$/i, // password: / user@host's password: / Enter passphrase for key '...':
  /verification code[^\n]*:\s*$/i,
  /(?:^|\s)(?:login|username|user name):\s*$/i,
  /\[y\/n\]\??\s*$/i,
];

export function looksLikeInteractivePrompt(recentOutput: string): boolean {
  const lines = recentOutput
    .replace(ANSI_RE, "")
    .split(/\r?\n|\r/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  return INTERACTIVE_PROMPT_RES.some((re) => re.test(last));
}
