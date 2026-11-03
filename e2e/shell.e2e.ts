// Browser end-to-end flow: the app shell (rail, sidebar, top bar), workspace switcher, search, notifications, theme, feature toggles, phone drawer.
// Run with `bun e2e/shell.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database). Screenshots go to .local/visual/review/03-app-shell.
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31037);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52037);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("03-app-shell");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Shell Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  await call("create_work_item", { projectId: project.id, title: "Alpha shell item" });
  await call("create_wiki_page", { workspaceId, title: "Alpha handbook" });

  // Rail, sidebar, and top bar are all there at 1440px, light theme.
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  const rail = page.getByRole("navigation", { name: translate("shell.rail") });
  for (const label of [translate("rail.work"), translate("wiki.title"), translate("rail.ai"), translate("nav.settings")]) await rail.getByRole("link", { name: label }).waitFor();
  const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });
  await sidebar.getByRole("navigation", { name: new RegExp(translate("projectNav.label")) }).waitFor();
  await sidebar.getByRole("link", { name: translate("cycles.title"), exact: true }).waitFor();
  for (const label of [translate("workspace.switch"), translate("topbar.help"), translate("profile.menu")]) await page.getByRole("button", { name: label }).waitFor();
  await page.getByRole("link", { name: translate("topbar.notifications") }).waitFor();
  const searchBox = await page.getByRole("searchbox", { name: translate("search.label") }).boundingBox();
  check(Boolean(searchBox) && Math.abs(searchBox!.x + searchBox!.width / 2 - 720) < 60, `search not centered: ${JSON.stringify(searchBox)}`);
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.light") }).click();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/shell-1440-light.png` });
  console.log("shell ok: rail, sidebar, top bar");

  // Project menus follow the feature toggles (the sidebar updates without a reload).
  await call("set_project_features", { projectId: project.id, features: { cycles: false, modules: false, intake: false } });
  await page.reload();
  await sidebar.getByRole("navigation", { name: `${translate("projectNav.label")} MOB` }).getByRole("link", { name: translate("projectNav.views") }).waitFor();
  check(await sidebar.getByRole("link", { name: translate("cycles.title"), exact: true }).count() === 0, "Cycles menu still shown with the feature off");
  check(await sidebar.getByRole("link", { name: translate("modules.title") }).count() === 0, "Modules menu still shown with the feature off");
  check(await sidebar.getByRole("link", { name: translate("intake.title") }).count() === 0, "Intake menu still shown with the feature off");
  await call("set_project_features", { projectId: project.id, features: { cycles: true, modules: true, intake: true } });
  await page.reload();
  await sidebar.getByRole("link", { name: translate("intake.title") }).waitFor();
  console.log("shell ok: feature toggles");

  // Workspace switcher: lists workspaces, creates a new one.
  const second = `${slug}-b`;
  await page.getByRole("button", { name: translate("workspace.switch") }).click();
  await page.getByRole("menuitemradio", { name: "E2E team" }).waitFor();
  await page.getByRole("menuitem", { name: translate("workspace.new") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Second team");
  await page.getByLabel(translate("workspace.slug")).fill(second);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${second}`);
  await page.getByRole("button", { name: translate("workspace.switch") }).click();
  await page.getByRole("menuitemradio", { name: "Second team" }).waitFor();
  await page.getByRole("menuitemradio", { name: "E2E team" }).click();
  await page.waitForURL(`${web}/${slug}`);
  console.log("shell ok: workspace switcher");

  // Search opens the work item and wiki results.
  const searchInput = page.getByRole("searchbox", { name: translate("search.label") });
  await searchInput.fill("Alpha");
  const results = page.getByRole("list", { name: translate("search.results") });
  await results.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  await results.getByRole("link", { name: /Alpha handbook/ }).waitFor();
  await results.getByRole("link", { name: /Alpha handbook/ }).click();
  await page.waitForURL(new RegExp(`/${slug}/wiki/`));
  await searchInput.fill("Alpha");
  await results.getByRole("link", { name: /Alpha shell item/ }).click();
  await page.waitForURL(`${web}/${slug}/browse/MOB-1`);
  console.log("shell ok: search");

  // Notifications icon opens the inbox.
  await page.getByRole("link", { name: translate("topbar.notifications") }).click();
  await page.waitForURL(`${web}/${slug}/notifications`);
  await page.getByRole("heading", { name: new RegExp(translate("inbox.title")) }).waitFor();
  console.log("shell ok: notifications");

  // Theme persists across reload; dark theme screenshot.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark") }).click();
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "dark theme not applied");
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  check(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "theme did not persist");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark"), checked: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/shell-1440-dark.png` });
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.system") }).click();
  await page.keyboard.press("Escape");
  console.log("shell ok: theme");

  // 390px: rail and sidebar collapse into a drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  check(await sidebar.count() === 0, "sidebar visible at 390px without opening the drawer");
  await page.screenshot({ path: `${shots}/shell-390-closed.png` });
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  await page.getByRole("dialog", { name: translate("shell.sidebar") }).waitFor();
  await page.getByRole("navigation", { name: `${translate("projectNav.label")} MOB` }).getByRole("link", { name: translate("projectNav.views") }).waitFor();
  await page.screenshot({ path: `${shots}/shell-390-drawer.png` });
  await page.getByRole("navigation", { name: `${translate("projectNav.label")} MOB` }).getByRole("link", { name: translate("projectNav.views") }).click();
  await page.waitForURL(`${web}/${slug}/projects/MOB/views`);
  await page.getByRole("dialog", { name: translate("shell.sidebar") }).waitFor({ state: "detached" });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal page scroll at 390px");
  console.log("shell ok: drawer at 390px");

  // The skip link moves focus to the main content.
  await page.getByRole("link", { name: translate("shell.skipToMain") }).focus();
  await page.keyboard.press("Enter");
  check(await page.evaluate(() => document.activeElement?.id === "main-content"), "the skip link did not move focus to main");
  console.log("shell ok: skip link focuses main");

  console.log("e2e shell: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
