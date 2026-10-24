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

    await browser.waitUntil(
      async () => {
        const cmds = await $$("#blocks .block .cmd").map((e) => e.getText());
        return cmds.includes(`echo ${MARKER}`);
      },
      { timeout: 30_000, timeoutMsg: "блок с командой не появился" },
    );

    const block = await $(`#blocks .block*=${MARKER}`);
    expect(await block.$(".meta").getText()).toContain("exit=0");
    expect((await block.$("pre").getText()).trim()).toBe(MARKER);
  });
});
