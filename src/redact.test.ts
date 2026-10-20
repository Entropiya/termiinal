import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets — имена ключей", () => {
  it("ловит DB_PASSWORD (env-стиль, без кавычек)", () => {
    const out = redactSecrets("DB_PASSWORD=supersecret1234");
    expect(out).toBe("DB_PASSWORD=<скрыто: 15 симв., без кавычек>");
  });

  it("ловит apiKey через camelCase-границу", () => {
    const out = redactSecrets("apiKey=abc123");
    expect(out).toContain("apiKey=<скрыто:");
  });

  it("НЕ ловит KEYBOARD (подстрока, не целое слово)", () => {
    const out = redactSecrets("KEYBOARD=qwerty");
    expect(out).toBe("KEYBOARD=qwerty");
  });

  it("НЕ ловит PASSED", () => {
    const out = redactSecrets("PASSED=true");
    expect(out).toBe("PASSED=true");
  });

  it("НЕ ловит bypass", () => {
    const out = redactSecrets("bypass=1");
    expect(out).toBe("bypass=1");
  });

  it("сохраняет кавычки и помечает 'в кавычках'", () => {
    const out = redactSecrets('TOKEN="abc"');
    expect(out).toBe('TOKEN="<скрыто: 3 симв., в кавычках>"');
  });

  it("пустое значение не трогает", () => {
    const out = redactSecrets("FOO_SECRET=");
    expect(out).toBe("FOO_SECRET=");
  });
});

describe("redactSecrets — форматы", () => {
  it("YAML key: value", () => {
    const out = redactSecrets("password: hunter2");
    expect(out).toMatch(/^password: <скрыто: 7 симв\., без кавычек>$/);
  });

  it("JSON \"key\": \"value\"", () => {
    const out = redactSecrets('{"password": "hunter2", "name": "bob"}');
    expect(out).toContain('"password": "<скрыто: 7 симв., в кавычках>"');
    expect(out).toContain('"name": "bob"'); // неспецифичный ключ не тронут
  });

  it("--password value (через пробел)", () => {
    const out = redactSecrets("mycli --password hunter2 --verbose");
    expect(out).toContain("--password <скрыто: 7 симв., без кавычек>");
    expect(out).toContain("--verbose");
  });

  it("--token=value", () => {
    const out = redactSecrets("curl --token=abcDEF123");
    expect(out).toContain("--token=<скрыто: 9 симв., без кавычек>");
  });

  it("mysql -pSECRET (приклеено без пробела)", () => {
    const out = redactSecrets("mysql -phunter2 -u root db");
    expect(out).toContain("-p<скрыто: 7 симв., без кавычек>");
  });

  it("без упоминания mysql/mysqldump -p не трогаем (слишком общий флаг)", () => {
    const out = redactSecrets("sometool -phunter2");
    expect(out).toBe("sometool -phunter2");
  });

  it("Authorization: Bearer", () => {
    const out = redactSecrets("Authorization: Bearer abcdef123456");
    expect(out).toContain("Authorization: Bearer <скрыто: 12 симв., без кавычек>");
  });

  it("пароль в URL, логин и хост остаются видны", () => {
    const out = redactSecrets("https://admin:hunter2@example.com/path");
    expect(out).toContain("https://admin:<скрыто: 7 симв., без кавычек>@example.com/path");
  });

  it("GitHub-токен по префиксу ловится без привязки к имени ключа", () => {
    const out = redactSecrets("token value is ghp_abcdefghij1234567890ABCD");
    expect(out).toMatch(/<скрыто: формат ghp_, \d+ симв\.>/);
  });

  it("AWS access key id по префиксу AKIA", () => {
    const out = redactSecrets("AKIAABCDEFGHIJKLMNOP");
    expect(out).toContain("<скрыто: формат AKIA,");
  });

  it("JWT по структуре трёх base64url-частей", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_signature-part";
    const out = redactSecrets(`auth=${jwt}`);
    expect(out).toContain("<скрыто: формат JWT,");
  });

  it("PEM приватный ключ целиком", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(pem);
    expect(out).toMatch(/^<скрыто: приватный ключ, \d+ симв\.>$/);
  });
});

describe("redactSecrets — не трогает невинное", () => {
  it("обычный текст и команды без секретов проходят без изменений", () => {
    const text = "apt update && apt install -y docker.io\ncd /var/log\nls -la";
    expect(redactSecrets(text)).toBe(text);
  });
});
