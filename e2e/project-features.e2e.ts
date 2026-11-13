// Browser end-to-end flow: a new project starts Simple or Full, the Features page explains each switch, and turning Pages off asks first.
// Run with `bun e2e/project-features.e2e.ts` (set DATABASE_URL, E2E_API_PORT, E2E_WEB_PORT and CHROMIUM_PATH as for the other flows). Screenshots go to the review folder for ticket 41.
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31168);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52168);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("41-project-features");
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

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", colorScheme: "light" });
  const page: Page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("console:", message.text().slice(0, 400)); });
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Features Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E features");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();

  // The create form offers Simple (preselected) and Full, each with a plain explanation.
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  const simpleRadio = page.getByRole("radio", { name: new RegExp(translate("projects.shapeSimple")) });
  check(await simpleRadio.isChecked(), "Simple is not preselected");
  check(await page.getByText(translate("projects.shapeSimpleDesc")).isVisible(), "Simple explanation missing");
  check(await page.getByText(translate("projects.shapeFullDesc")).isVisible(), "Full explanation missing");
  await page.screenshot({ path: `${shots}/create-project-1440.png` });
  await page.getByLabel(translate("projects.name")).fill("Simple app");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("SIMP");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /SIMP · Simple app/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const simple = (await call<Array<{ key: string; id: string; features: Record<string, boolean> }>>("list_projects", { workspaceId })).find((row) => row.key === "SIMP")!;
  check(JSON.stringify(simple.features) === JSON.stringify({ cycles: false, modules: false, intake: false, pages: true, views: true }), `Simple features wrong: ${JSON.stringify(simple.features)}`);

  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByRole("radio", { name: new RegExp(translate("projects.shapeFull")) }).check();
  await page.getByLabel(translate("projects.name")).fill("Full app");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("FULL");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /FULL · Full app/ }).waitFor();
  const full = (await call<Array<{ key: string; features: Record<string, boolean> }>>("list_projects", { workspaceId })).find((row) => row.key === "FULL")!;
  check(Object.values(full.features).every(Boolean), `Full project not fully on: ${JSON.stringify(full.features)}`);
  console.log("features ok: create offers Simple and Full, Simple leaves Cycles, Modules and Intake off");

  // A page in the Simple project, so turning Pages off has something to hide.
  await call("create_wiki_page", { workspaceId, title: "Launch plan", projectId: simple.id });

  // Features page: every switch has its explanation and who it suits; switching Cycles on shows its menu item.
  await page.goto(`${web}/${slug}/settings/projects/SIMP/features`);
  await page.getByRole("switch", { name: translate("features.pages") }).waitFor();
  for (const feature of ["cycles", "modules", "intake", "pages", "views"] as const) {
    check(await page.getByText(translate(`features.${feature}Desc`)).isVisible(), `${feature} explanation missing`);
    check(await page.getByText(translate(`features.${feature}Suits`)).isVisible(), `${feature} suits line missing`);
  }
  await page.getByRole("switch", { name: translate("features.cycles") }).click();
  await page.getByRole("link", { name: /SIMP · Simple app/ }).click();
  await sidebar.getByRole("navigation", { name: new RegExp(translate("projectNav.label")) }).getByRole("link", { name: translate("cycles.title") }).waitFor();
  await page.screenshot({ path: `${shots}/features-1440.png` });
  console.log("features ok: the Features page explains each switch and turning Cycles on shows its menu item");

  // Pages off with a page in use: a confirmation names the page first; Keep on changes nothing.
  await page.goto(`${web}/${slug}/settings/projects/SIMP/features`);
  await page.getByRole("switch", { name: translate("features.pages") }).click();
  const confirm = page.getByRole("group", { name: translate("features.confirmOffHeading") });
  await confirm.waitFor();
  check(await confirm.getByText("Launch plan").isVisible(), "confirmation does not name the page in use");
  await page.screenshot({ path: `${shots}/pages-confirm-1440.png` });
  await confirm.getByRole("button", { name: translate("features.confirmKeep") }).click();
  check(await page.getByRole("switch", { name: translate("features.pages") }).isChecked(), "Keep on still turned Pages off");
  await page.getByRole("switch", { name: translate("features.pages") }).click();
  await confirm.getByRole("button", { name: translate("features.confirmTurnOff") }).click();
  for (let attempt = 0; attempt < 30 && await page.getByRole("switch", { name: translate("features.pages") }).isChecked(); attempt += 1) await Bun.sleep(100);
  check(!(await page.getByRole("switch", { name: translate("features.pages") }).isChecked()), "Pages did not turn off");
  const projectMenu = sidebar.getByRole("navigation", { name: new RegExp(translate("projectNav.label")) });
  await page.getByRole("link", { name: /SIMP · Simple app/ }).click();
  await projectMenu.getByRole("link", { name: translate("projectNav.views") }).waitFor();
  check(await projectMenu.getByRole("link", { name: translate("projectNav.pages") }).count() === 0, "Pages menu still shown with the switch off");
  await page.goto(`${web}/${slug}/settings/projects/SIMP/features`);
  await page.getByRole("switch", { name: translate("features.pages") }).click();
  await page.getByRole("link", { name: /SIMP · Simple app/ }).click();
  await projectMenu.getByRole("link", { name: translate("projectNav.pages") }).waitFor();
  const pagesAfter = await call<Array<{ title: string }>>("list_project_wiki_pages", { projectId: simple.id });
  check(pagesAfter.some((row) => row.title === "Launch plan"), "the Page was not kept while Pages was off");
  console.log("features ok: Pages off asks first, hides the menu, keeps the page, and turning it on brings it back");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/settings/projects/SIMP/features`);
  await page.getByRole("switch", { name: translate("features.views") }).waitFor();
  await page.screenshot({ path: `${shots}/features-390.png` });

  console.log("e2e project-features: ok");
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
