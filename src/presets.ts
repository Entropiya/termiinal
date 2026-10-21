// Пресеты подключений (ТЗ, разд. "Подключения и пресеты"): хост, порт, пользователь,
// путь к ключу, имя. Пароли/парольные фразы намеренно не храним — их по-прежнему
// вводят в терминале, ssh спрашивает сам, как и требует ТЗ.
//
// Хранилище — localStorage. Для пары-тройки пресетов этого достаточно; полноценное
// структурированное хранение сессий (план, лог блоков) — отдельная фича стадии 3
// ("Хранение сессий и экспорт"), пресеты подключений с ней не связаны.

export interface ConnectionPreset {
  id: string;
  name: string;
  host: string;
  port?: number;
  user: string;
  keyPath?: string;
}

const STORAGE_KEY = "termiinal:presets";

export function loadPresets(): ConnectionPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // битые/чужие данные в localStorage — не падать, просто считать что пусто
  }
}

function savePresets(list: ConnectionPreset[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function upsertPreset(preset: ConnectionPreset) {
  const list = loadPresets();
  const i = list.findIndex((p) => p.id === preset.id);
  if (i === -1) list.push(preset);
  else list[i] = preset;
  savePresets(list);
}

export function removePreset(id: string) {
  savePresets(loadPresets().filter((p) => p.id !== id));
}

/** `user@host` или `user@host:port` -> составные части (для разбора поля ввода). */
export function parseTarget(target: string): { user: string; host: string; port?: number } | null {
  const m = /^([^@\s]+)@([^:\s]+)(?::(\d+))?$/.exec(target.trim());
  if (!m) return null;
  return { user: m[1], host: m[2], port: m[3] ? Number(m[3]) : undefined };
}

export function formatTarget(user: string, host: string, port?: number): string {
  return port ? `${user}@${host}:${port}` : `${user}@${host}`;
}
