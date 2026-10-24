import { describe, expect, it } from "vitest";
import { looksLikeInteractivePrompt, ProbeCapture } from "./host-probe";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("ProbeCapture", () => {
  it("разбирает shellPath/hostname/os-release из одного чанка", () => {
    const cap = new ProbeCapture();
    const chunk =
      "echo-of-typed-command\r\n" + // эхо набранной строки — не должно мешать разбору
      "\x1b]1337;probe-start\x07\r\n" +
      "/usr/bin/bash\r\n" +
      "debian-01\r\n" +
      'ID=debian\r\nVERSION_ID="12"\r\n' +
      "\x1b]1337;probe-end\x07\r\n";
    cap.feed(enc(chunk));
    expect(cap.done).toBe(true);
    expect(cap.result()).toEqual({
      shellPath: "/usr/bin/bash",
      hostname: "debian-01",
      osId: "debian",
      osVersionId: "12",
    });
  });

  it("работает по кускам (чанки пересекают маркеры)", () => {
    const cap = new ProbeCapture();
    const full =
      "\x1b]1337;probe-start\x07/usr/bin/bash\nmyhost\nID=debian\n\x1b]1337;probe-end\x07";
    // Разбиваем байты ровно по середине, не заботясь о границах UTF-8/маркеров.
    const bytes = enc(full);
    const mid = Math.floor(bytes.length / 2);
    expect(cap.feed(bytes.slice(0, mid))).toBe(true);
    expect(cap.done).toBe(false);
    expect(cap.feed(bytes.slice(mid))).toBe(true);
    expect(cap.done).toBe(true);
    expect(cap.result()?.hostname).toBe("myhost");
  });

  it("result() вернёт null, пока маркеры не закрылись", () => {
    const cap = new ProbeCapture();
    cap.feed(enc("\x1b]1337;probe-start\x07/usr/bin/bash\nhost\n"));
    expect(cap.done).toBe(false);
    expect(cap.result()).toBeNull();
  });
});

describe("looksLikeInteractivePrompt", () => {
  it("первый вход по ssh: вопрос про отпечаток хоста", () => {
    expect(
      looksLikeInteractivePrompt(
        "The authenticity of host 'h (1.2.3.4)' can't be established.\r\nED25519 key fingerprint is SHA256:abc.\r\n" +
          "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
      ),
    ).toBe(true);
    expect(looksLikeInteractivePrompt("Please type 'yes', 'no' or the fingerprint: ")).toBe(true);
  });

  it("пароль, парольная фраза, код подтверждения, логин", () => {
    expect(looksLikeInteractivePrompt("user@host's password: ")).toBe(true);
    expect(looksLikeInteractivePrompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': ")).toBe(true);
    expect(looksLikeInteractivePrompt("Verification code: ")).toBe(true);
    expect(looksLikeInteractivePrompt("host login: ")).toBe(true);
  });

  it("цветные последовательности не мешают", () => {
    expect(looksLikeInteractivePrompt("\x1b[1m\x1b[33mPassword:\x1b[0m ")).toBe(true);
  });

  it("обычный промпт шелла и баннер — не запрос ввода", () => {
    expect(looksLikeInteractivePrompt("Linux debian 6.1\r\nuser@debian:~$ ")).toBe(false);
    expect(looksLikeInteractivePrompt("")).toBe(false);
    expect(looksLikeInteractivePrompt("Warning: Permanently added 'h' (ED25519) to the list of known hosts.\r\n")).toBe(false);
  });

  it("смотрит только на последнюю строку: после ответа старый вопрос не мешает", () => {
    expect(looksLikeInteractivePrompt("continue connecting (yes/no)? yes\r\nuser@host:~$ ")).toBe(false);
  });
});
