// Browser end-to-end flow: Settings > Connect AI. The MCP card shows commands with the real public address and a working copy button,
// and the guide prompt holds the address, no token, and points to the API tokens page. With no public address the MCP card says MCP is not ready.
// Run with `bun e2e/connect-ai.e2e.ts` (set DATABASE_URL, E2E_API_PORT, E2E_WEB_PORT, CHROMIUM_PATH as in docs/agents/testing.md).
// Screenshots go to the review folder for this ticket (reviewShots("connect-ai")).
import { chromium, type Page } from "playwright";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31167);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52167);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const publicUrl = "http://weft-public.example.test";
const shots = reviewShots("connect-ai");

// The public address comes from WEFT_PUBLIC_URL at API start, so the not-ready and configured states run against two API processes.
let apiProc: ReturnType<typeof Bun.spawn> | undefined;
function startApi(env: Record<string, string | undefined>) {
  apiProc = Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, ...env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" });
}
async function stopApi() {
  apiProc?.kill();
  await apiProc?.exited;
  apiProc = undefined;
}

const web_ = Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" });

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

let failed = false;
try {
  startApi({ WEFT_PUBLIC_URL: undefined });
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
  await page.getByLabel(translate("auth.name")).fill("Connect Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Connect team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}**`);

  // Settings navigation lists Connect AI and the screen opens.
  await page.getByRole("navigation", { name: translate("shell.rail") }).getByRole("link", { name: translate("nav.settings") }).click();
  await page.waitForURL(`${web}/${slug}/settings`);
  await sidebar.getByRole("link", { name: translate("settings.connectAi"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings/connect-ai`);
  await page.getByRole("heading", { name: translate("connectAi.title") }).waitFor();

  // Not ready: no public address, so the MCP card says so and shows no commands.
  await page.getByText(translate("connectAi.notReady")).first().waitFor();
  check(await page.getByRole("tablist").count() === 0, "commands shown without a public address");
  check(await page.getByRole("button", { name: translate("connectAi.copyGuide") }).isDisabled(), "guide copy enabled without a public address");
  await page.screenshot({ path: `${shots}/not-ready-1440.png` });
  console.log("connect-ai ok: navigation and not-ready state");

  // Configured: restart the API with a public address and reload.
  await stopApi();
  startApi({ WEFT_PUBLIC_URL: publicUrl });
  await waitFor(`${api}/api/mcp/address`);
  await page.reload();
  await page.getByRole("tablist", { name: translate("connectAi.clientsLabel") }).waitFor();
  const claudeCommand = `claude mcp add --transport http weft ${publicUrl}/mcp`;
  await page.locator("pre").filter({ hasText: claudeCommand }).waitFor();
  check(await page.locator("pre").filter({ hasText: claudeCommand }).count() === 1, "Claude Code command lacks the real address");
  await page.getByRole("tab", { name: "Claude Code" }).click();
  await page.getByRole("button", { name: translate("connectAi.copy"), exact: true }).first().click();
  await page.getByRole("status").getByText(translate("connectAi.copied")).last().waitFor();
  check(await clipboard(page) === claudeCommand, `copied command was ${await clipboard(page)}`);

  for (const [tab, expected] of [["Cursor", `"url": "${publicUrl}/mcp"`], ["Codex", `codex mcp add weft --url ${publicUrl}/mcp`]] as const) {
    await page.getByRole("tab", { name: tab }).click();
    await page.getByRole("tabpanel").locator("pre").filter({ hasText: expected }).waitFor();
  }
  await page.getByRole("tab", { name: "Claude Desktop" }).click();
  await page.getByRole("tabpanel").locator("pre").filter({ hasText: `"mcp-remote"`, }).filter({ hasText: `"${publicUrl}/mcp"` }).waitFor();
  console.log("connect-ai ok: client tabs show the real address");

  // Advanced holds stdio and token setup; the token block carries a placeholder, never a real token.
  await page.getByText(translate("connectAi.advanced")).click();
  await page.locator("pre").filter({ hasText: "<your-token>" }).first().waitFor();
  console.log("connect-ai ok: advanced setup");

  // Guide prompt: copy, then check the clipboard holds the address and the tokens page, and no token string.
  const token = await (await page.request.post(`${api}/actions/create_api_token`, { data: { name: "connect-ai flow", description: "" } })).json() as { token?: string };
  check(typeof token.token === "string" && token.token.length > 0, "could not create a token for the leak check");
  await page.getByRole("button", { name: translate("connectAi.copyGuide") }).click();
  await page.getByRole("status").getByText(translate("connectAi.copied")).last().waitFor();
  const prompt = await clipboard(page);
  check(prompt.includes(publicUrl), "guide prompt lacks the server address");
  check(prompt.includes(`${publicUrl}/account/api-tokens`), "guide prompt does not name the API tokens page");
  check(!prompt.includes(token.token!), "guide prompt contains the token");
  check(!/weft_[A-Za-z0-9_]/.test(prompt), "guide prompt contains a token-shaped string");
  console.log("connect-ai ok: guide prompt copy contents");

  // The app shell scrolls its own pane, so capture the viewport after scrolling each card into view.
  const shoot = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("tablist").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/mcp-${width}.png` });
    await page.getByRole("button", { name: translate("connectAi.copyGuide") }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/guide-${width}.png` });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `side scroll at ${width}px`);
  };
  await shoot(1440);
  await shoot(390);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "side scroll at 390px");
  await browser.close();
  console.log("connect-ai flow ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await stopApi();
  web_.kill();
}
process.exit(failed ? 1 : 0);
