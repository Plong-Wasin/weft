// Browser end-to-end flow for the work items list layout: groups, inline property dropdowns, display options, quick create.
// Run with `bun e2e/work-items-list.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("05-work-items-list-layout");
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
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };
  await page.goto(web);
  await page.getByLabel(translate("auth.name")).fill("Lists Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();

  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  // Seed what the dropdowns offer: a label, a Cycle, a Module (through the same Actions the UI uses).
  const me = await (await context.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await call("create_label", { projectId: project!.id, name: "Bug" });
  await call("create_cycle", { projectId: project!.id, name: "Sprint 1", startDate: day(-1), endDate: day(6) });
  await call("create_module", { projectId: project!.id, name: "Auth" });

  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  // Quick create: the group "+" creates in that state; the bottom button creates in the default one.
  await page.getByRole("button", { name: translate("workItems.new"), exact: true }).click();
  for (const title of ["Alpha", "Bravo"]) {
    await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill(title);
    await page.getByRole("textbox", { name: translate("workItems.titleField") }).press("Enter");
    await page.getByRole("link", { name: title }).waitFor();
  }
  const backlog = page.getByRole("region", { name: "Backlog" });
  check(await backlog.getByRole("link").count() === 2, "quick create did not land in Backlog");
  await page.getByRole("button", { name: translate("layout.addToGroup").replace("{group}", "Todo") }).click();
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Charlie");
  await page.getByRole("button", { name: translate("workItems.create"), exact: true }).click();
  await page.getByRole("region", { name: "Todo" }).getByRole("link", { name: "Charlie" }).waitFor();

  // Group headers collapse and expand.
  const header = page.getByRole("button", { name: `${translate("layout.toggleGroup")}: Backlog` });
  await header.click();
  check(await backlog.getByRole("link").count() === 0 && await header.getAttribute("aria-expanded") === "false", "group did not collapse");
  await header.click();
  await backlog.getByRole("link", { name: "Alpha" }).waitFor();
  await page.screenshot({ path: `${shots}/list-1440-light.png` });

  // Each inline dropdown changes the work item without a reload (a marker on window survives only without navigation).
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
  const row = page.getByTestId("row-MOB-1");
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.state")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "In Progress" }).click();
  await page.getByRole("region", { name: "In Progress" }).getByRole("link", { name: "Alpha" }).waitFor();

  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).click();
  await page.getByRole("menuitemradio", { name: translate("workItems.priority.urgent") }).click();
  await row.getByRole("button", { name: `${translate("workItems.priority")}: ${translate("workItems.priority.urgent")}` }).waitFor();

  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Lists Tester" }).click();
  await row.getByRole("button", { name: `${translate("workItems.assignees")}: Lists Tester` }).waitFor();
  await page.keyboard.press("Escape");

  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Bug" }).click();
  await row.getByRole("button", { name: `${translate("workItems.labels")}: Bug` }).waitFor();
  await page.keyboard.press("Escape");

  await row.getByRole("button", { name: new RegExp(`^${translate("layout.property.dates")}:`) }).click();
  await page.getByLabel(translate("workItems.dueDate")).fill(day(3));
  await row.getByRole("button", { name: new RegExp(`^${translate("layout.property.dates")}: .*20`) }).waitFor();
  await page.keyboard.press("Escape");

  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.cycle")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "Sprint 1" }).click();
  await row.getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 1` }).waitFor();

  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.modules")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Auth" }).click();
  await row.getByRole("button", { name: `${translate("workItems.modules")}: Auth` }).waitFor();
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true), "the page reloaded");
  await page.screenshot({ path: `${shots}/list-1440-edited.png` });

  // The edits are real: the Actions stored them (reload and read back through the API).
  await page.reload();
  const stored = await call<{ priority: string; assigneeIds: string[]; labelIds: string[]; dueDate: string | null; stateId: string }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: "MOB-1" });
  check(stored.priority === "urgent" && stored.assigneeIds.length === 1 && stored.labelIds.length === 1 && stored.dueDate === day(3), "an inline edit was not stored");
  const inCycle = await call<Array<{ displayId: string }>>("list_work_items", { projectId: project!.id, cycleId: (await call<Array<{ id: string }>>("list_cycles", { projectId: project!.id }))[0]!.id });
  check(inCycle.map((item) => item.displayId).join() === "MOB-1", "the Cycle dropdown did not store");
  await page.getByTestId("row-MOB-1").getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 1` }).waitFor();

  // Display options: hiding a property removes it from the rows and persists in the URL.
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.property.labels"), { exact: true }).uncheck();
  await page.keyboard.press("Escape");
  check(page.url().includes("props="), "visible properties are not in the URL");
  check(await page.getByTestId("row-MOB-1").getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }).count() === 0, "hidden property still shown");
  await page.reload();
  await page.getByTestId("row-MOB-1").waitFor();
  check(await page.getByTestId("row-MOB-1").getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }).count() === 0, "visible properties did not survive reload");

  // Group by priority and the URL.
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("priority");
  await page.keyboard.press("Escape");
  await page.getByRole("region", { name: translate("workItems.priority.urgent") }).getByRole("link", { name: "Alpha" }).waitFor();
  check(page.url().includes("group=priority"), "group is not in the URL");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/list-390-light.png` });
  console.log("e2e work items list: ok");
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
