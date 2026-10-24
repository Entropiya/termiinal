// e2e через tauri-driver (WebDriver поверх WebView2). Только Windows: на Linux
// приложение с ConPTY/Git Bash не запускается, там это не проверяется.
//
// Переменные окружения:
//   E2E_APP         путь к собранному termiinal.exe (по умолчанию debug-сборка);
//   TAURI_DRIVER    путь к tauri-driver (по умолчанию — из PATH);
//   MSEDGEDRIVER    путь к msedgedriver.exe, если его нет в PATH.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACTS = path.join(here, "artifacts");
const application =
  process.env.E2E_APP ?? path.resolve(here, "..", "src-tauri", "target", "debug", "termiinal.exe");

let tauriDriver;
let driverLog;

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: [path.join(here, "specs", "**", "*.e2e.mjs")],
  maxInstances: 1,
  capabilities: [{ maxInstances: 1, "tauri:options": { application } }],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 90_000 },
  logLevel: "info",
  connectionRetryCount: 0, // не висеть минутами, если сессия не создаётся
  outputDir: ARTIFACTS,

  onPrepare() {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    if (!fs.existsSync(application)) throw new Error(`нет собранного приложения: ${application}`);
  },

  beforeSession() {
    driverLog = fs.createWriteStream(path.join(ARTIFACTS, "tauri-driver.log"));
    const args = process.env.MSEDGEDRIVER ? ["--native-driver", process.env.MSEDGEDRIVER] : [];
    tauriDriver = spawn(process.env.TAURI_DRIVER ?? path.join(os.homedir(), ".cargo", "bin", "tauri-driver"), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    tauriDriver.stdout.pipe(driverLog);
    tauriDriver.stderr.pipe(driverLog);
    tauriDriver.on("error", (e) => {
      console.error("tauri-driver:", e);
      process.exit(1);
    });
    // tauri-driver слушает 4444 не мгновенно.
    return new Promise((resolve) => setTimeout(resolve, 2000));
  },

  afterSession() {
    tauriDriver?.kill();
    driverLog?.end();
  },

  // При падении — скриншот и дамп того, что видит тест: блоки и текст терминала.
  async afterTest(test, _ctx, { passed }) {
    if (passed) return;
    const name = test.title.replace(/[^\p{L}\p{N}]+/gu, "_");
    await browser.saveScreenshot(path.join(ARTIFACTS, `${name}.png`)).catch(() => {});
    const dump = await browser
      .execute(() => ({
        status: document.querySelector("#status")?.textContent,
        blocks: document.querySelector("#blocks")?.innerText,
        terminal: document.querySelector(".xterm-rows")?.innerText,
      }))
      .catch((e) => ({ error: String(e) }));
    fs.writeFileSync(path.join(ARTIFACTS, `${name}.dom.json`), JSON.stringify(dump, null, 2));
  },
};
