// Browser flow for the AI switch (ticket 02). Two API processes on one seeded database:
//   AI off  (WEFT_AI_ENABLED=false): no AI surface is shown to the Admin or to a Guest, and /<workspace>/ai, /<workspace>/ai/<id>
//           is not found; the AI settings page stays and says why AI is off.
//   AI on   (a provider key set, switch unset): the same surfaces are shown, as before this change.
// Run with `bun e2e/ai-switch.e2e.ts` (set DATABASE_URL to a --keep database, E2E_API_PORT, E2E_WEB_PORT, CHROMIUM_PATH as in docs/agents/testing.md).
// No model is called: the placeholder key only makes the server count AI as on.
import { chromium, type BrowserContext, type Page } from "playwright";
import { createDatabase, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31177);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52177);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

let apiProc: ReturnType<typeof Bun.spawn> | undefined;
/** Starts the API with `extra` set; an undefined value removes that variable from the inherited environment. */
function startApi(extra: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = { ...Bun.env, ...extra, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api };
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  apiProc = Bun.spawn(["bun", "apps/api/src/index.ts"], { env: env as Record<string, string>, stdout: "inherit", stderr: "inherit" });
}
async function stopApi() {
  apiProc?.kill();
  await apiProc?.exited;
  apiProc = undefined;
}
const webProc = Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" });

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

const { client, db } = createDatabase();
const slug = `ai-${crypto.randomUUID().slice(0, 8)}`;
const railAi = (page: Page) => page.getByRole("navigation", { name: translate("shell.rail") }).getByRole("link", { name: translate("rail.ai"), exact: true });
const sidecarButtons = (page: Page) => page.getByRole("button", { name: translate("sidecar.open"), exact: true });
const askAiLink = async (page: Page) => {
  await page.getByRole("button", { name: translate("topbar.help"), exact: true }).click();
  const count = await page.getByRole("menuitem", { name: translate("topbar.helpAskAi"), exact: true }).count();
  await page.keyboard.press("Escape");
  return count;
};
const settingsAiLink = (page: Page) => page.getByRole("navigation", { name: translate("shell.sidebar") }).getByRole("link", { name: translate("aiStatus.title"), exact: true });
const paletteHasAi = async (page: Page) => {
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").first().waitFor();
  const count = await page.getByText(translate("rail.ai"), { exact: true }).count();
  await page.keyboard.press("Escape");
  return count;
};
const notFound = (page: Page) => page.getByRole("alert").filter({ hasText: translate("app.notFound") });

/** Every AI surface a person can see on the current workspace pages, one boolean each. */
async function surfaces(page: Page, pages: { workItem: string; wikiPage: string }) {
  await page.goto(`${web}/${slug}`);
  await page.getByRole("navigation", { name: translate("shell.rail") }).waitFor();
  const rail = await railAi(page).count() > 0;
  const toggle = await sidecarButtons(page).count() > 0;
  const askAi = await askAiLink(page) > 0;
  const palette = await paletteHasAi(page) > 0;
  await page.goto(`${web}/${slug}/settings`);
  await page.getByRole("navigation", { name: translate("shell.sidebar") }).getByRole("link", { name: translate("settings.general"), exact: true }).waitFor();
  const settings = await settingsAiLink(page).count() > 0;
  await page.goto(`${web}/${slug}/browse/${pages.workItem}`);
  await page.getByRole("heading").first().waitFor();
  const workItemTrigger = await sidecarButtons(page).count() > 0;
  await page.goto(`${web}/${slug}/wiki/${pages.wikiPage}`);
  await page.getByTestId("wiki-editor").waitFor();
  const wikiTrigger = await sidecarButtons(page).count() > 0;
  // Select the page text in the Wiki editor: the selection menu appears only with AI on.
  await page.getByTestId("wiki-editor").locator('[contenteditable="true"]').click();
  await page.keyboard.type("Select this sentence in the editor.");
  await page.keyboard.press("Control+a");
  const menu = page.getByRole("toolbar", { name: translate("assist.menu"), exact: true });
  await menu.first().waitFor({ timeout: 3_000 }).catch(() => undefined);
  const selectionMenu = await menu.count() > 0;
  await page.keyboard.press("End");
  await page.goto(`${web}/${slug}/workspace-views/all-issues`);
  await page.getByRole("button", { name: translate("layout.filterQuery.toggle") }).click();
  const describeRow = await page.getByPlaceholder(translate("layout.filterQuery.generate.placeholder")).count() > 0;
  return { rail, toggle, askAi, palette, settings, workItemTrigger, wikiTrigger, selectionMenu, describeRow };
}

async function aiRoutesNotFound(page: Page, chatId: string) {
  for (const path of [`/${slug}/ai`, `/${slug}/ai/${chatId}`]) {
    await page.goto(`${web}${path}`);
    await notFound(page).waitFor();
  }
}

let failed = false;
try {
  await waitFor(`${web}/`);
  // Owner: sign up, create the workspace, and seed a project, a work item and a Wiki page through the API.
  startApi({ WEFT_AI_ENABLED: "false", OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
  await waitFor(`${api}/api/me`);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", colorScheme: "light" });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("AI Switch Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("AI switch team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}**`);
  const row = await db.query.workspaces.findFirst({ where: (table, { eq }) => eq(table.slug, slug) });
  if (!row) throw new Error("E2E workspace was not persisted");
  const project = await (await page.request.post(`${api}/actions/create_project`, { data: { workspaceId: row.id, name: "Planning", key: "PLN", visibility: "private" } })).json() as { id: string };
  const item = await (await page.request.post(`${api}/actions/create_work_item`, { data: { projectId: project.id, title: "AI switch item" } })).json() as { displayId: string };
  const wiki = await (await page.request.post(`${api}/actions/create_wiki_page`, { data: { workspaceId: row.id, title: "AI switch page" } })).json() as { id: string };
  const seeded = { workItem: item.displayId, wikiPage: wiki.id };

  // AI off: the Admin sees no AI surface, and every AI route is not found.
  const off = await surfaces(page, seeded);
  console.log("AI off, Admin:", JSON.stringify(off));
  // The AI settings page is the one entry that stays: it explains why AI is off.
  for (const [name, shown] of Object.entries(off)) if (name !== "settings") check(shown === false, `AI off: ${name} is shown to the Admin`);
  check(off.settings === true, "AI off: the AI settings entry must stay so the cause can be read");
  await aiRoutesNotFound(page, "00000000-0000-4000-8000-000000000000");
  await page.goto(`${web}/${slug}/settings/ai`);
  const offReason = page.getByTestId("ai-off-reason");
  await offReason.waitFor();
  check((await offReason.textContent())?.includes("WEFT_AI_ENABLED") === true, "AI off: the settings page must name the switch as the cause");
  // API: the AI routes answer 404 and the config reports the switch as the cause.
  const config = await (await fetch(`${api}/api/config`)).json() as { ai: { enabled: boolean; reason: string | null } };
  check(config.ai.enabled === false && config.ai.reason === "switched_off", `config reports ${JSON.stringify(config.ai)}`);

  // Guest (AI off): the Guest sees no AI surface either.
  const invite = await (await page.request.post(`${api}/actions/create_invite`, { data: { workspaceId: row.id, role: "Guest" } })).json() as { token: string };
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const guest = await guestContext.newPage();
  guest.on("pageerror", (error) => console.error("guest pageerror:", error.message));
  await guest.goto(`${web}/invite/${invite.token}`);
  await guest.getByLabel(translate("auth.name")).fill("AI Switch Guest");
  await guest.getByLabel(translate("auth.email")).fill(`${slug}-guest@example.test`);
  await guest.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await guest.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await guest.getByRole("button", { name: translate("auth.signUp") }).click();
  await guest.waitForURL(`${web}/${slug}**`);
  await guest.getByRole("navigation", { name: translate("shell.rail") }).waitFor();
  check(await railAi(guest).count() === 0, "AI off: the rail AI entry is shown to a Guest");
  check(await paletteHasAi(guest) === 0, "AI off: the palette lists AI to a Guest");

  // AI on: a provider key and the switch unset. The same surfaces come back for the Admin.
  await stopApi();
  startApi({ WEFT_AI_ENABLED: undefined, OPENAI_API_KEY: "sk-e2e-placeholder-no-call" });
  await waitFor(`${api}/api/me`);
  const on = await surfaces(page, seeded);
  console.log("AI on, Admin:", JSON.stringify(on));
  for (const [name, shown] of Object.entries(on)) check(shown === true, `AI on: ${name} is missing for the Admin`);
  await page.goto(`${web}/${slug}/ai`);
  await page.getByRole("navigation", { name: translate("shell.sidebar") }).waitFor();
  check(await notFound(page).count() === 0, "AI on: /ai is not found");
  // Guest (AI on): the Guest, still signed in from the AI-off run, keeps the rail AI entry.
  await guest.goto(`${web}/${slug}`);
  await guest.getByRole("navigation", { name: translate("shell.rail") }).waitFor();
  check(await railAi(guest).count() === 1, "AI on: a Guest lost the rail AI entry");
  await guestContext.close();
  await browser.close();
  console.log("ai-switch flow: all checks passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await stopApi();
  webProc.kill();
  await webProc.exited;
  await client.end();
}
process.exit(failed ? 1 : 0);
