// Browser end-to-end flow for workspace views: built-in views across projects, the spreadsheet default, Save as view, reopen, update, delete.
// Run with `bun e2e/workspace-views.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3119);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5219);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("11-workspace-views");
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

type View = { id: string; name: string; query: string; layout: string; groupBy: string; orderBy: string; orderDirection: string; properties: string[]; access: string };
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
  await page.getByLabel(translate("auth.name")).fill("Views Tester");
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
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const workspaceId = me.workspaces[0]!.id;
  const second = await call<{ id: string }>("create_project", { workspaceId, name: "Web", key: "WEB", visibility: "public" });
  const self = await (await context.request.get(`${api}/api/me`)).json() as { user: { id: string } };
  const mine = await call<{ id: string }>("create_work_item", { projectId: project!.id, title: "Alpha urgent", priority: "urgent", assigneeIds: [self.user.id] });
  await call("create_work_item", { projectId: second.id, title: "Bravo high", priority: "high" });
  await call("create_work_item", { projectId: second.id, title: "Charlie low", priority: "low" });
  check(!!mine.id, "work item not created");

  // The sidebar Views entry opens All work items: a spreadsheet with items of both projects.
  await page.getByRole("link", { name: translate("views.title"), exact: true }).first().click();
  await page.waitForURL(`**/${slug}/workspace-views/all-issues`);
  await page.getByRole("heading", { name: translate("workspaceViews.all") }).waitFor();
  await page.getByTestId("sheet-scroll").waitFor();
  for (const id of ["MOB-1", "WEB-1", "WEB-2"]) await page.getByTestId(`row-${id}`).waitFor();
  await page.getByRole("columnheader", { name: translate("workspaceViews.project") }).waitFor();
  await page.screenshot({ path: `${shots}/workspace-views-1440.png` });

  // Assigned shows only my item; Created shows all three (I made them); the switcher lists every built-in.
  await page.getByRole("button", { name: translate("workspaceViews.switch") }).click();
  for (const label of ["all", "assigned", "created", "subscribed"]) await page.getByRole("menuitemradio", { name: translate(`workspaceViews.${label}`) }).waitFor();
  await page.getByRole("menuitemradio", { name: translate("workspaceViews.assigned") }).click();
  await page.waitForURL(`**/workspace-views/assigned`);
  await page.getByTestId("row-WEB-1").waitFor({ state: "detached" });
  await page.getByTestId("row-MOB-1").waitFor();
  await page.goto(`${web}/${slug}/workspace-views/created`);
  for (const id of ["MOB-1", "WEB-1", "WEB-2"]) await page.getByTestId(`row-${id}`).waitFor();

  // Built-in views cannot be edited or deleted from the menu, and the API refuses too.
  await page.getByRole("button", { name: translate("views.menu") }).click();
  check(await page.getByRole("menuitem", { name: translate("views.delete") }).count() === 0, "a built-in view offers delete");
  await page.keyboard.press("Escape");
  const refused = await context.request.post(`${api}/actions/delete_view`, { data: { viewId: "builtin:assigned" } });
  check(refused.status() === 400, `deleting a built-in view answered ${refused.status()}`);

  // Filter by PQL, save as a workspace View, reopen it from its URL.
  await page.goto(`${web}/${slug}/workspace-views/all-issues`);
  await page.getByTestId("row-WEB-2").waitFor();
  await page.getByRole("button", { name: translate("layout.pql.toggle") }).click();
  await page.getByRole("textbox", { name: translate("layout.pql.label") }).fill("priority = urgent OR priority = high");
  await page.getByRole("button", { name: translate("layout.pql.apply") }).click();
  await page.getByTestId("row-WEB-2").waitFor({ state: "detached" });
  await page.getByTestId("row-MOB-1").waitFor();
  await page.getByRole("button", { name: translate("views.saveAs") }).click();
  await page.getByRole("dialog").getByLabel(translate("views.name")).fill("Hot everywhere");
  await page.getByRole("dialog").getByRole("button", { name: translate("views.create") }).click();
  await page.getByRole("heading", { name: "Hot everywhere" }).waitFor();
  const listed = await call<{ builtin: unknown[]; views: Array<{ id: string; name: string; scope: string; projectId: string | null; layout: string; query: string }> }>("list_workspace_views", { workspaceId });
  check(listed.builtin.length === 4 && listed.views.length === 1, "list_workspace_views wrong");
  const saved = listed.views[0]!;
  check(saved.scope === "workspace" && saved.projectId === null && saved.layout === "spreadsheet" && saved.query === "priority = urgent OR priority = high", "saved view stored wrong settings");
  await page.goto(`${web}/${slug}/workspace-views/${saved.id}`);
  await page.getByTestId("row-WEB-1").waitFor();
  check(await page.getByTestId("row-WEB-2").count() === 0, "reopened view lost its filter");

  // Change the order, update the view, and see it stored.
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.direction")).selectOption("desc");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: translate("views.update") }).click();
  await page.getByRole("status").filter({ hasText: translate("views.updated") }).waitFor();
  check(((await call<Array<{ orderDirection: string }>>("list_workspace_views", { workspaceId }).then((rows) => (rows as never as { views: Array<{ orderDirection: string }> }).views))[0]?.orderDirection) === "desc", "update did not store");

  // The switcher lists the saved view; delete it from its menu.
  await page.getByRole("button", { name: translate("workspaceViews.switch") }).click();
  await page.getByRole("menuitemradio", { name: "Hot everywhere" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: translate("views.menu") }).click();
  await page.getByRole("menuitem", { name: translate("views.delete") }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: translate("views.deleteAction") }).click();
  await page.waitForURL(`**/workspace-views/all-issues`);
  check((await call<{ views: unknown[] }>("list_workspace_views", { workspaceId })).views.length === 0, "delete did not remove the view");
  check((await call<unknown[]>("list_work_items", { projectId: project!.id })).length === 1, "deleting a view changed work items");
  await page.goto(`${web}/${slug}/workspace-views/${saved.id}`);
  await page.getByRole("alert").filter({ hasText: translate("views.notFound") }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/workspace-views/all-issues`);
  await page.getByTestId("row-MOB-1").waitFor();
  await page.screenshot({ path: `${shots}/workspace-views-390.png` });
  console.log("e2e workspace-views: ok");
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
