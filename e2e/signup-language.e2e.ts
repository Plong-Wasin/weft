// A person who signs up in Thai (browser language) must land inside the app in Thai, and the choice must be saved to the account.
// Runs with no DEFAULT_LANGUAGE, so an unsaved account language arrives from the server as English.
import { check, launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3131);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5231);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const { DEFAULT_LANGUAGE: _unused, ...baseEnv } = Bun.env;
const servers = [
  startApi(apiPort, web, { env: { ...baseEnv, ALLOW_SIGNUP: "true", ALLOW_WORKSPACE_CREATION: "true" } }),
  startWeb(webPort, { api, env: { ...baseEnv } }),
];

let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
try {
  await Promise.all([waitFor(`${api}/api/config`), waitFor(web)]);
  browser = await launchBrowser();
  const context = await newContext(browser, { locale: "th-TH", viewport: { width: 1440, height: 900 } });
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
