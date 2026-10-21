// Защита от опасных команд при вставке (ТЗ, разд. "Вставка команд"): "Перед вставкой
// команда проверяется на опасные шаблоны. Совпадения подсвечиваются красным и требуют
// второго нажатия." Это защита от промпт-инъекции — агент читает чужие логи и файлы и
// может предложить вставить то, что в них подсунули.
//
// Эвристика, а не песочница: ловит типичную форму команды (как и затирание секретов в
// redact.ts), не гарантирует перехват любого обфусцированного варианта.

export interface DangerMatch {
  group: string;
  label: string;
  /** Строка из вставки, в которой нашли совпадение (обрезанная по краям пробелов). */
  line: string;
}

interface Rule {
  group: string;
  label: string;
  test: (line: string) => boolean;
}

function firstWord(line: string): string {
  return line.trim().split(/\s+/, 1)[0] ?? "";
}

// sudo/doas-префикс не должен прятать команду от проверки базового слова.
function stripSudo(line: string): string {
  return line.trim().replace(/^(sudo|doas)\s+/, "");
}

function isBaseCommand(line: string, names: string[]): boolean {
  return names.includes(firstWord(stripSudo(line)));
}

/** `rm` опасен именно сочетанием "рекурсивно" + "без подтверждения", а не одним из
 * двух флагов по отдельности — ловит `-rf`, `-fr`, `-r -f`, `--recursive --force`
 * в любом порядке. */
function rmIsRecursiveForce(line: string): boolean {
  const stripped = stripSudo(line);
  if (firstWord(stripped) !== "rm") return false;
  const tokens = stripped.split(/\s+/).slice(1);
  let r = false;
  let f = false;
  for (const t of tokens) {
    if (t === "--recursive") r = true;
    else if (t === "--force") f = true;
    else if (/^-[a-zA-Z]+$/.test(t)) {
      if (t.includes("r")) r = true;
      if (t.includes("f")) f = true;
    } else if (!t.startsWith("-")) break; // первый не-флаговый токен — опции кончились
  }
  return r && f;
}

function chmodRecursive777(line: string): boolean {
  const stripped = stripSudo(line);
  if (firstWord(stripped) !== "chmod") return false;
  const tokens = stripped.split(/\s+/).slice(1);
  let recursive = false;
  let has777 = false;
  for (const t of tokens) {
    if (t === "--recursive" || (/^-[a-zA-Z]+$/.test(t) && t.includes("R"))) recursive = true;
    if (t === "777") has777 = true;
  }
  return recursive && has777;
}

const RULES: Rule[] = [
  { group: "Удаление и порча данных", label: "rm -rf", test: rmIsRecursiveForce },
  { group: "Удаление и порча данных", label: "dd", test: (l) => isBaseCommand(l, ["dd"]) },
  { group: "Удаление и порча данных", label: "mkfs", test: (l) => /^mkfs(\.\w+)?$/.test(firstWord(stripSudo(l))) },
  {
    group: "Удаление и порча данных",
    label: "> /dev/sd*",
    // ТЗ даёт /dev/sd* как пример — расширяем до других блочных устройств (hd/vd/nvme),
    // смысл тот же: запись прямо в устройство, а не в файл.
    test: (l) => /[>]{1,2}\s*\/dev\/(sd|hd|vd|nvme)[a-z0-9]*/i.test(l),
  },
  { group: "Удаление и порча данных", label: "chmod -R 777", test: chmodRecursive777 },
  {
    group: "Выполнение чужого кода",
    label: "curl … | sh",
    test: (l) => /\bcurl\b[^|;\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ash)\b/i.test(l),
  },
  {
    group: "Выполнение чужого кода",
    label: "wget … | bash",
    test: (l) => /\bwget\b[^|;\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ash)\b/i.test(l),
  },
  {
    group: "Потеря доступа к машине",
    label: "iptables -P INPUT DROP",
    test: (l) => /\biptables\b.*-P\s+INPUT\s+DROP/i.test(l),
  },
  { group: "Потеря доступа к машине", label: "ufw enable", test: (l) => /\bufw\s+enable\b/i.test(l) },
  {
    group: "Потеря доступа к машине",
    label: "ip link set … down",
    test: (l) => /\bip\s+link\s+set\b[^\n]*\bdown\b/i.test(l),
  },
  {
    group: "Потеря доступа к машине",
    label: "остановка/перезапуск sshd",
    test: (l) => /\b(systemctl|service)\s+(stop|restart)\s+sshd\b/i.test(l) || /\bkillall\s+-?\w*\s*sshd\b/i.test(l),
  },
  { group: "Потеря доступа к машине", label: "правка sshd_config", test: (l) => /sshd_config/i.test(l) },
  {
    group: "Потеря доступа к машине",
    label: "reboot",
    test: (l) => isBaseCommand(l, ["reboot"]) || /\bsystemctl\s+reboot\b/i.test(l),
  },
  {
    group: "Потеря доступа к машине",
    label: "shutdown",
    test: (l) => isBaseCommand(l, ["shutdown", "halt", "poweroff"]) || /\bsystemctl\s+(poweroff|halt)\b/i.test(l),
  },
  {
    group: "Системные файлы",
    label: "запись в /etc/",
    test: (l) => /[>]{1,2}\s*\/etc\//.test(l) || /\btee\b[^\n]*\/etc\//i.test(l),
  },
];

/** Разбирает текст (как он придёт из буфера обмена при вставке) построчно и возвращает
 * все найденные совпадения. Пустой массив — вставлять можно сразу, без подтверждения. */
export function classifyPaste(text: string): DangerMatch[] {
  const matches: DangerMatch[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const rule of RULES) {
      if (rule.test(line)) matches.push({ group: rule.group, label: rule.label, line });
    }
  }
  return matches;
}
