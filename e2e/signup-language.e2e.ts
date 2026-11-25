// A person who signs up in Thai (browser language) must land inside the app in Thai, and the choice must be saved to the account.
// Runs with no DEFAULT_LANGUAGE, so an unsaved account language arrives from the server as English.
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3131);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5231);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const { DEFAULT_LANGUAGE: _unused, ...baseEnv } = Bun.env;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...baseEnv, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api, ALLOW_SIGNUP: "true", ALLOW_WORKSPACE_CREATION: "true" }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...baseEnv, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await Promise.all([waitFor(`${api}/api/config`), waitFor(web)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ locale: "th-TH", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(web);
  await page.getByLabel(translate("auth.email", "th")).waitFor();
  check((await page.getByRole("combobox", { name: translate("language.label", "th") }).textContent())?.includes(translate("language.th", "th")), "the signed-out screen must follow the Thai browser language");
  await page.getByRole("button", { name: translate("auth.signUp", "th"), exact: true }).click();
  await page.getByLabel(translate("auth.name", "th")).fill("Thai Person");
  await page.getByLabel(translate("auth.email", "th")).fill(`th-${crypto.randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel(translate("auth.password", "th"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword", "th"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp", "th") }).click();
  // Inside the app (past the auth form) the language must still be Thai.
  await page.getByLabel(translate("auth.email", "th")).waitFor({ state: "detached", timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.lang === "th");
  check((await page.getByRole("combobox", { name: translate("language.label", "th") }).textContent())?.includes(translate("language.th", "th")), "the signed-in language switch must still say Thai");
  // The choice was saved to the account, so another device sees Thai too.
  let saved = "";
  for (let attempt = 0; attempt < 25 && saved !== "th"; attempt += 1) {
    const me = await page.request.get(`${api}/api/me`).then((response) => response.json()) as { user: { locale: string; localeSaved: boolean } };
    saved = me.user.localeSaved ? me.user.locale : "";
    if (saved !== "th") await Bun.sleep(200);
  }
  check(saved === "th", "the Thai choice must be saved to the account after sign-up");
  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === "th");
  console.log("e2e signup-language: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
