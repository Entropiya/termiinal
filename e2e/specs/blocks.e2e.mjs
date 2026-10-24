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

  it("выбор ChatGPT без ключа даёт понятную ошибку (сеть и OpenAI не нужны)", async () => {
    // В CI нет OPENAI_API_KEY и ключа в настройках — Rust должен отказать до всякой сети.
    const result = await browser.execute(() => {
      const select = document.querySelector("#agent-model");
      const options = [...select.options].map((o) => o.value);
      select.value = "gpt-5";
      select.dispatchEvent(new Event("change"));
      document.querySelector("#agent-status").click(); // запуск агента с выбранной моделью
      return { options, saved: localStorage.getItem("termiinal:agent-model") };
    });
    expect(result.options).toContain("claude-haiku-5-5");
    expect(result.options).toContain("gpt-5");
    expect(result.saved).toBe("gpt-5");

    await browser.waitUntil(
      async () =>
        browser.execute(() => document.querySelector("#chat-log")?.textContent.includes("нет ключа OpenAI")),
      { timeout: 20_000, timeoutMsg: "нет сообщения об отсутствии ключа OpenAI" },
    );
  });
});
