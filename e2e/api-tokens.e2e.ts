// Browser end-to-end flow: API tokens inside the app shell. The screen has the settings navigation and links to Connect AI,
// presets fill the name and the 30-day expiry, a new token is shown once with a copy button and a warning, and it is gone after closing.
// Run with `bun e2e/api-tokens.e2e.ts` (set DATABASE_URL, E2E_API_PORT, E2E_WEB_PORT, CHROMIUM_PATH as in docs/agents/testing.md).
// Screenshots go to the review folder for this ticket (reviewShots("api-tokens")).
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31080);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52080);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("api-tokens");

const apiProc = Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" });
const webProc = Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" });

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

/** The expiry a preset fills in: 30 days from today, as YYYY-MM-DD in local time. */
function thirtyDaysOut() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", colorScheme: "light" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: web });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Token Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Token team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}**`);

  // The old account URL opens the screen inside the workspace shell, with the settings navigation.
  await page.goto(`${web}/account/api-tokens`);
  await page.waitForURL(`${web}/${slug}/settings/api-tokens`);
  await page.getByRole("heading", { name: translate("tokens.title"), exact: true }).waitFor();
  check(await sidebar.getByRole("link", { name: translate("tokens.title"), exact: true }).getAttribute("aria-current") === "page", "API tokens is not the current sidebar item");
  check(await page.getByRole("link", { name: translate("tokens.connectAiLink") }).getAttribute("href") === `/${slug}/settings/connect-ai`, "Connect AI link is missing or wrong");
  console.log("api-tokens ok: shell navigation and Connect AI link");

  // Going back: the sidebar leads to Connect AI and back again.
  await sidebar.getByRole("link", { name: translate("settings.connectAi"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings/connect-ai`);
  await sidebar.getByRole("link", { name: translate("tokens.title"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings/api-tokens`);
  console.log("api-tokens ok: way back via navigation");

  await page.screenshot({ path: `${shots}/list-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: `${shots}/list-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Empty lists keep their messages.
  await page.getByText(translate("apps.empty")).waitFor();

  // Presets: MCP is the default and fills the name and a 30-day expiry; CLI fills its own name; Custom keeps the typed values.
  await page.getByRole("button", { name: translate("tokens.add"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  const preset = dialog.getByLabel(translate("tokens.presetLabel"));
  const name = dialog.getByLabel(translate("tokens.name"));
  const expiry = dialog.getByLabel(translate("tokens.customDate"));
  check(await preset.inputValue() === "mcp", "default preset is not MCP");
  check(await name.inputValue() === "MCP", `MCP preset did not fill the name: ${await name.inputValue()}`);
  check(await expiry.inputValue() === thirtyDaysOut(), `default expiry is ${await expiry.inputValue()}, not 30 days out`);
  await preset.selectOption("cli");
  check(await name.inputValue() === "CLI", "CLI preset did not fill the name");
  check(await expiry.inputValue() === thirtyDaysOut(), "CLI preset changed the 30-day expiry");
  await preset.selectOption("custom");
  check(await name.inputValue() === "CLI", "Custom preset cleared the typed name");
  await name.fill("Laptop");
  await expiry.fill("2031-06-15");
  await preset.selectOption("mcp");
  check(await name.inputValue() === "MCP" && await expiry.inputValue() === thirtyDaysOut(), "MCP preset did not refill name and expiry");
  await page.screenshot({ path: `${shots}/create-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: `${shots}/create-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("api-tokens ok: presets fill name and 30-day expiry");

  // Create: the token is shown once, with a large copy button and a warning.
  await dialog.getByRole("button", { name: translate("tokens.create"), exact: true }).click();
  const secretInput = dialog.getByLabel(translate("tokens.secret"));
  await secretInput.waitFor();
  const secret = await secretInput.inputValue();
  check(secret.length > 0, "no token shown after create");
  await dialog.getByText(translate("tokens.secretWarning")).waitFor();
  const copy = dialog.getByRole("button", { name: translate("tokens.copy"), exact: true });
  const box = await copy.boundingBox();
  check(box !== null && box.height >= 44, `copy button is not large: ${box?.height}px`);
  await copy.click();
  await page.getByRole("status").getByText(translate("tokens.copied")).last().waitFor();
  check(await page.evaluate(() => navigator.clipboard.readText()) === secret, "copy did not put the token on the clipboard");
  await page.screenshot({ path: `${shots}/secret-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: `${shots}/secret-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("api-tokens ok: token shown once with copy button and warning");

  // Closing the dialog hides the token for good: it is not in the dialog again, nor on the page.
  await dialog.getByRole("button", { name: translate("settings.cancel"), exact: true }).last().click();
  await dialog.waitFor({ state: "detached" });
  check(await page.getByText(secret).count() === 0, "token text is still on the page after closing");
  await page.getByRole("button", { name: translate("tokens.add"), exact: true }).click();
  check(await dialog.getByLabel(translate("tokens.secret")).count() === 0, "token shown again after reopening");
  check(await dialog.getByLabel(translate("tokens.name")).inputValue() === "MCP", "reopened form kept old values");
  await dialog.getByRole("button", { name: translate("settings.cancel"), exact: true }).first().click();
  await dialog.waitFor({ state: "detached" });
  console.log("api-tokens ok: token not shown again after closing");

  // Existing behaviour: the new token is listed by name and prefix, and can be revoked.
  await page.getByRole("listitem").filter({ hasText: "MCP" }).getByText(translate("tokens.status.active")).waitFor();
  page.once("dialog", (confirm) => void confirm.accept());
  await page.getByRole("listitem").filter({ hasText: "MCP" }).getByRole("button", { name: translate("tokens.revoke"), exact: true }).click();
  await page.getByRole("listitem").filter({ hasText: "MCP" }).getByText(translate("tokens.status.revoked")).waitFor();
  await page.screenshot({ path: `${shots}/revoked-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: `${shots}/revoked-390.png` });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "side scroll at 390px");
  await browser.close();
  console.log("api-tokens flow ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  apiProc.kill();
  webProc.kill();
  await Promise.allSettled([apiProc.exited, webProc.exited]);
}
process.exit(failed ? 1 : 0);
