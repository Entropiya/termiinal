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
    // Дать bash дойти до промпта, затем внедрить OSC-хуки (кнопка лежит в закрытом
    // <details>, поэтому жмём программно).
    await browser.pause(3000);
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
});
