// Запуск приложения → локальный Git Bash → ввод команды → в панели "Блоки" появляется
// блок с этой командой, кодом 0 и ожидаемым выводом.

const MARKER = "e2e-marker-42";

describe("termiinal", () => {
  it("показывает лаунчер при старте", async () => {
    await $("#btn-launcher-gitbash").waitForDisplayed({ timeout: 30_000 });
  });

  it("команда в Git Bash превращается в блок", async () => {
    await $("#btn-launcher-gitbash").click();

    // Кнопка ручной интеграции включается, когда сессия реально поднялась.
    await browser.waitUntil(async () => await $("#btn-integrate").isEnabled(), {
      timeout: 30_000,
      timeoutMsg: "сессия Git Bash не поднялась",
    });
    // Дождаться настоящего промпта bash (на холодном раннере Git Bash стартует долго, фиксированная
    // пауза была нестабильной), затем внедрить OSC-хуки (кнопка лежит в закрытом <details>,
    // поэтому жмём программно).
    await browser.waitUntil(
      async () =>
        browser.execute(() => /\$\s*$/m.test(document.querySelector(".xterm-rows")?.innerText ?? "")),
      { timeout: 90_000, timeoutMsg: "Git Bash не показал промпт" },
    );
    await browser.execute(() => document.querySelector("#btn-integrate").click());
    await browser.pause(2000);

    await browser.keys(`echo ${MARKER}`);
    await browser.keys("Enter");

    // Читаем DOM через execute: панель «Блоки» может быть свёрнута, а WebDriver getText()
    // у невидимых элементов отдаёт пустую строку, хотя блок в DOM есть.
    const block = await browser.waitUntil(
      async () =>
        browser.execute((marker) => {
          const el = [...document.querySelectorAll("#blocks .block")].find(
            (b) => b.querySelector(".cmd")?.textContent.trim() === `echo ${marker}`,
          );
          return el
            ? { meta: el.querySelector(".meta").textContent, output: el.querySelector("pre").textContent.trim() }
            : null;
        }, MARKER),
      { timeout: 30_000, timeoutMsg: "блок с командой не появился" },
    );

    expect(block.meta).toContain("exit=0");
    expect(block.output).toBe(MARKER);
  });

  it("локальный Windows PowerShell тоже нарезается на блоки (успех и ошибка)", async () => {
    // Завершаем сессию Git Bash из предыдущего теста, возвращаемся в лаунчер.
    await browser.execute(() => document.querySelector("#btn-ssh").click());
    await browser.waitUntil(
      async () => browser.execute(() => document.querySelector(".shell")?.dataset.session === "idle"),
      { timeout: 30_000, timeoutMsg: "сессия Git Bash не завершилась" },
    );
    await browser.execute(() => document.querySelector("#btn-launcher-powershell").click());

    await browser.waitUntil(
      async () =>
        browser.execute(() => /PS [A-Za-z]:\\[^\n]*>\s*$/m.test(document.querySelector(".xterm-rows")?.innerText ?? "")),
      { timeout: 90_000, timeoutMsg: "PowerShell не показал промпт" },
    );

    const findBlock = (cmd) =>
      browser.waitUntil(
        async () =>
          browser.execute((c) => {
            const el = [...document.querySelectorAll("#blocks .block")].find(
              (b) => b.querySelector(".cmd")?.textContent.trim() === c,
            );
            return el
              ? { meta: el.querySelector(".meta").textContent, output: el.querySelector("pre").textContent.trim() }
              : null;
          }, cmd),
        { timeout: 30_000, timeoutMsg: `нет блока «${cmd}»` },
      );

    await browser.keys("echo ps-e2e-42");
    await browser.keys("Enter");
    const ok = await findBlock("echo ps-e2e-42");
    expect(ok.meta).toContain("exit=0");
    expect(ok.output).toBe("ps-e2e-42");

    // Ошибка командлета: код возврата 1, текст ошибки попал в блок.
    await browser.keys("Get-Item C:\\net-takogo-puti-xyz");
    await browser.keys("Enter");
    const bad = await findBlock("Get-Item C:\\net-takogo-puti-xyz");
    expect(bad.meta).toContain("exit=1");
    expect(bad.output).toContain("net-takogo-puti-xyz");
  });

  it("ChatGPT без Codex CLI даёт понятную ошибку; настройки агента лежат в меню ⋯", async () => {
    // На раннере Codex нет (или нет входа) — Rust должен отказать до запуска, с понятным текстом.
    const result = await browser.execute(() => {
      const select = document.querySelector("#agent-model");
      const options = [...select.options].map((o) => o.value);
      const style = {
        options: [...document.querySelector("#agent-style").options].map((o) => o.value),
        value: document.querySelector("#agent-style").value,
      };
      const inMenu = ["#agent-model", "#agent-style", "#agent-policy"].every((id) =>
        document.querySelector(`#agent-menu ${id}`),
      );
      const toggle = document.querySelector("#btn-agent-toggle");
      const toggleBefore = toggle.textContent;
      select.value = "gpt-6.1-sol";
      select.dispatchEvent(new Event("change"));
      toggle.click(); // «Запустить» с выбранной моделью
      return { options, style, inMenu, toggleBefore, saved: localStorage.getItem("termiinal:agent-model") };
    });
    expect(result.inMenu).toBe(true);
    expect(result.toggleBefore).toBe("Запустить");
    expect(result.style.options).toEqual(["teach", "direct"]);
    expect(result.style.value).toBe("teach"); // по умолчанию — режим обучения
    expect(result.options).toContain("claude-haiku-5-5");
    expect(result.options).toContain("gpt-6.1-sol");
    expect(result.saved).toBe("gpt-6.1-sol");

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const t = document.querySelector("#chat-log")?.textContent ?? "";
          return t.includes("ChatGPT не запустился") && t.includes("Codex");
        }),
      { timeout: 20_000, timeoutMsg: "нет понятной ошибки про Codex" },
    );
  });
});
