// Browser flow for ticket 03: the per-person switch for the floating AI menu on text selection.
// Account preferences hold the switch (default on, follows the account). With it on, selecting text in the Wiki, a description
// and a comment shows the AI assist menu. With it off, the menu does not appear in any of the three, while the slash command
// "AI assist" and the keyboard shortcut Ctrl/⌘+Shift+J still open the assist task picker. The choice survives a reload.
// The model is mocked (no provider is called); a placeholder key only makes the server count AI as on.
// Run with `bun e2e/ai-selection-menu.e2e.ts` (set DATABASE_URL to a --keep database, E2E_API_PORT, E2E_WEB_PORT, CHROMIUM_PATH as in docs/agents/testing.md).
import { chromium, type Locator, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
Bun.env.OPENAI_API_KEY ??= "sk-e2e-placeholder-no-call";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31191);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52191);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31192);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "ignore", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

let failed = false;
let offApi: ReturnType<typeof Bun.spawn> | undefined;
/** The API environment with AI switched off: the switch is "false" and no provider key is set. */
function offEnv() {
  const env: Record<string, string | undefined> = { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api, WEFT_AI_ENABLED: "false", OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env as Record<string, string>;
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  // A configured key: the status is mocked so the menu has a task picker to show, and assist calls answer locally.
  await context.route("**/api/ai/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ provider: "openai", model: "mock", key: "present", configured: true, canAssist: true }) }));
  await context.route("**/api/ai/assist", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "Mocked rewrite" }) }));

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Selection Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Selection team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  await call("create_work_item", { projectId: project.id, title: "Selection target" });
  const wikiPage = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Selection notes" });

  const assistToolbar = (host: Page | Locator) => host.getByRole("toolbar", { name: translate("assist.menu"), exact: true });
  const preferenceCheckbox = () => page.getByRole("checkbox", { name: translate("accountPrefs.aiMenu"), exact: true });
  /** Types a line, selects it with the keyboard, and waits for the editor to settle. */
  async function typeAndSelect(editor: Locator, text: string) {
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(text);
    await page.keyboard.press("Shift+Home");
  }
  /** Sets the account switch on the preferences page and waits until the server has saved it. */
  async function setPreference(on: boolean) {
    await page.goto(`${web}/account/preferences`);
    const box = preferenceCheckbox();
    await box.waitFor();
    if ((await box.isChecked()) !== on) {
      const saved = page.waitForResponse((response) => response.url().endsWith("/actions/set_my_ai_preferences") && response.ok());
      await box.click();
      await saved;
    }
    check((await preferenceCheckbox().isChecked()) === on, `preference did not switch ${on ? "on" : "off"}`);
  }

  // A failed preference load offers an in-page retry, then the default switch loads successfully.
  let failPreferenceLoad = true;
  await page.route("**/actions/get_my_ai_preferences", async (route) => {
    if (failPreferenceLoad) {
      failPreferenceLoad = false;
      await route.fulfill({ status: 500, body: "temporary failure" });
    } else await route.continue();
  });
  await page.goto(`${web}/account/preferences`);
  await page.getByRole("alert").filter({ hasText: translate("accountPrefs.loadFailed") }).waitFor();
  await page.getByRole("button", { name: translate("account.retry"), exact: true }).click();
  await preferenceCheckbox().waitFor();
  await page.unroute("**/actions/get_my_ai_preferences");
  console.log("ai-selection-menu ok: failed preference load can be retried in place");

  // The switch is on by default and the menu shows when text is selected in the Wiki.
  await page.goto(`${web}/account/preferences`);
  await preferenceCheckbox().waitFor();
  check(await preferenceCheckbox().isChecked(), "the AI selection menu switch is not on by default");
  console.log("ai-selection-menu ok: on by default");

  await page.goto(`${web}/${slug}/wiki/${wikiPage.id}`);
  const wiki = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await wiki.waitFor();
  await typeAndSelect(wiki, "Wiki selected text");
  await assistToolbar(page).waitFor();
  console.log("ai-selection-menu ok: menu shows on selection when on");

  // Off, then reload: the Wiki menu is gone, the slash command and the shortcut still open assist.
  await setPreference(false);
  await page.goto(`${web}/${slug}/wiki/${wikiPage.id}`);
  await wiki.waitFor();
  await typeAndSelect(wiki, "Wiki off text");
  await page.getByTestId("wiki-bubble-menu").waitFor();
  check(await assistToolbar(page).count() === 0, "AI selection menu is shown in the Wiki while the switch is off");
  console.log("ai-selection-menu ok: Wiki menu hidden after reload when off");

  // Slash command: the slash text goes, the current block's text is selected and the assist picker opens.
  // The slash command starts a new line, so AI assist works on the block above it.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/ai");
  const slashMenu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await slashMenu.getByRole("option", { name: translate("assist.menu"), exact: true }).waitFor();
  await page.keyboard.press("Enter");
  await assistToolbar(page).waitFor();
  check(await wiki.evaluate((node) => !node.textContent?.includes("/ai")), "the slash command text was not removed");
  console.log("ai-selection-menu ok: slash command opens assist while the menu is off");
  await page.keyboard.press("Escape");
  await assistToolbar(page).waitFor({ state: "detached" });

  // Keyboard shortcut: select the line and press Ctrl/⌘+Shift+J.
  await typeAndSelect(wiki, "Shortcut text");
  await page.keyboard.press("Control+Shift+KeyJ");
  await assistToolbar(page).waitFor();
  console.log("ai-selection-menu ok: shortcut opens assist while the menu is off");
  await page.keyboard.press("Escape");
  await assistToolbar(page).waitFor({ state: "detached" });

  // Description and comment: the menu is hidden there too while the switch is off.
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const description = page.getByTestId("description-editor").locator(".ProseMirror");
  await description.waitFor();
  await typeAndSelect(description, "Description off text");
  await page.getByTestId("wiki-bubble-menu").first().waitFor();
  check(await assistToolbar(page).count() === 0, "AI selection menu is shown in the description while the switch is off");
  const commentEditor = page.getByTestId("comment-editor").last().locator(".ProseMirror");
  await typeAndSelect(commentEditor, "Comment off text");
  check(await assistToolbar(page).count() === 0, "AI selection menu is shown in a comment while the switch is off");
  console.log("ai-selection-menu ok: description and comment hidden while off");
  await page.keyboard.press("End");

  // On again, then reload: the Wiki menu comes back on selection.
  await setPreference(true);
  await page.goto(`${web}/${slug}/wiki/${wikiPage.id}`);
  await wiki.waitFor();
  await typeAndSelect(wiki, "Wiki back on text");
  await assistToolbar(page).waitFor();
  console.log("ai-selection-menu ok: menu back after reload when on");

  // AI off (switch set to "false", no key): the preference page is not found, its profile menu item is gone, and the slash
  // command is not listed. The API restarts with the switch off; the web app reads the config again on reload.
  servers[0].kill();
  await servers[0].exited;
  offApi = Bun.spawn(["bun", "apps/api/src/index.ts"], { env: offEnv(), stdout: "ignore", stderr: "inherit" });
  await waitFor(`${api}/api/me`);
  await page.goto(`${web}/account/preferences`);
  await page.getByRole("alert").filter({ hasText: translate("app.notFound") }).waitFor();
  check(await page.getByRole("checkbox", { name: translate("accountPrefs.aiMenu"), exact: true }).count() === 0, "AI off: the preference is shown");
  await page.goto(`${web}/${slug}`);
  await page.getByRole("button", { name: translate("profile.menu"), exact: true }).click();
  await page.getByRole("menuitem", { name: translate("email.menu"), exact: true }).waitFor();
  check(await page.getByRole("menuitem", { name: translate("accountPrefs.menu"), exact: true }).count() === 0, "AI off: the preferences item is in the profile menu");
  await page.keyboard.press("Escape");
  await page.goto(`${web}/${slug}/wiki/${wikiPage.id}`);
  await wiki.waitFor();
  await wiki.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option").first().waitFor();
  check(await page.getByRole("option", { name: translate("assist.menu"), exact: true }).count() === 0, "AI off: the AI assist slash command is listed");
  console.log("ai-selection-menu ok: AI off hides the preference, its menu item and the slash command");

  console.log("e2e ai-selection-menu: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  offApi?.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
