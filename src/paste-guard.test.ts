import { describe, expect, it } from "vitest";
import { classifyPaste } from "./paste-guard";

function labels(text: string): string[] {
  return classifyPaste(text).map((m) => m.label);
}

describe("classifyPaste — удаление и порча данных", () => {
  it("rm -rf — ловит обычную форму", () => {
    expect(labels("rm -rf /var/log/old")).toContain("rm -rf");
  });

  it("rm -rf — ловит раздельные флаги и --long", () => {
    expect(labels("rm -r -f /tmp/x")).toContain("rm -rf");
    expect(labels("rm --recursive --force /tmp/x")).toContain("rm -rf");
    expect(labels("rm -fr /tmp/x")).toContain("rm -rf");
  });

  it("просто rm без -f не считается опасным по этому правилу", () => {
    expect(labels("rm -r /tmp/x")).not.toContain("rm -rf");
    expect(labels("rm file.txt")).toHaveLength(0);
  });

  it("dd, mkfs и запись в /dev/sd* ловятся", () => {
    expect(labels("dd if=/dev/zero of=/dev/sda bs=1M")).toContain("dd");
    expect(labels("mkfs.ext4 /dev/sdb1")).toContain("mkfs");
    expect(labels("cat image.img > /dev/sdb")).toContain("> /dev/sd*");
  });

  it("chmod -R 777 ловится, просто chmod 777 (без -R) — нет", () => {
    expect(labels("chmod -R 777 /")).toContain("chmod -R 777");
    expect(labels("chmod 777 file.sh")).not.toContain("chmod -R 777");
  });
});

describe("classifyPaste — выполнение чужого кода", () => {
  it("curl … | sh и wget … | bash", () => {
    expect(labels("curl -sSL https://example.com/install.sh | sh")).toContain("curl … | sh");
    expect(labels("wget -qO- https://example.com/i.sh | bash")).toContain("wget … | bash");
  });

  it("curl без пайпа в шелл — не опасно по этому правилу", () => {
    expect(labels("curl -sSL https://example.com/install.sh -o install.sh")).toHaveLength(0);
  });
});

describe("classifyPaste — потеря доступа к машине", () => {
  it("iptables, ufw, ip link down, sshd, reboot/shutdown", () => {
    expect(labels("iptables -P INPUT DROP")).toContain("iptables -P INPUT DROP");
    expect(labels("sudo ufw enable")).toContain("ufw enable");
    expect(labels("ip link set eth0 down")).toContain("ip link set … down");
    expect(labels("systemctl restart sshd")).toContain("остановка/перезапуск sshd");
    expect(labels("vim /etc/ssh/sshd_config")).toContain("правка sshd_config");
    expect(labels("reboot")).toContain("reboot");
    expect(labels("sudo shutdown -h now")).toContain("shutdown");
  });
});

describe("classifyPaste — системные файлы", () => {
  it("запись в /etc/ через редирект или tee", () => {
    expect(labels("echo foo > /etc/hosts")).toContain("запись в /etc/");
    expect(labels("echo foo | sudo tee /etc/hosts")).toContain("запись в /etc/");
  });
});

describe("classifyPaste — безобидный текст и многострочная вставка", () => {
  it("обычные команды не матчатся ни на что", () => {
    expect(classifyPaste("ls -la\ncd /tmp\ngit status\napt update")).toHaveLength(0);
  });

  it("проверяет построчно: опасная строка в середине безобидного блока находится", () => {
    const text = "cd /tmp\nrm -rf ./build\necho done";
    const matches = classifyPaste(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ label: "rm -rf", line: "rm -rf ./build" });
  });

  it("пустой текст и пустые строки не ломают разбор", () => {
    expect(classifyPaste("")).toHaveLength(0);
    expect(classifyPaste("\n\n   \n")).toHaveLength(0);
  });
});
