// Browser end-to-end flow for saved Views: save from the filter and display bars, reopen exactly, update, create and delete.
// Run with `bun e2e/views.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3109);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5209);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("10-saved-views-project");
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
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Views Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  for (const [title, priority] of [["Alpha urgent", "urgent"], ["Bravo high", "high"], ["Charlie low", "low"]]) await call("create_work_item", { projectId: project!.id, title, priority });

  // Empty Views page first.
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("navigation", { name: `${translate("projectNav.label")} MOB` }).getByRole("link", { name: translate("projectNav.views") }).click();
  await page.getByRole("status").filter({ hasText: translate("views.empty") }).waitFor();

  // Shape the work item list with the filter and display bars, then save it.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: "Charlie low" }).waitFor();
  await page.getByRole("button", { name: translate("layout.pql.toggle") }).click();
  await page.getByRole("textbox", { name: translate("layout.pql.label") }).fill("priority IN (urgent, high)");
  await page.getByRole("button", { name: translate("layout.pql.apply") }).click();
  await page.getByRole("link", { name: "Charlie low" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("priority");
  await page.getByLabel(translate("layout.sort")).selectOption("title");
  await page.getByLabel(translate("layout.direction")).selectOption("desc");
  await page.getByLabel(translate("layout.property.labels"), { exact: true }).uncheck();
  await page.keyboard.press("Escape");
  const shaped = new URL(page.url()).search;
  await page.getByRole("button", { name: translate("views.saveAs") }).click();
  await page.getByRole("dialog", { name: translate("views.form.saveTitle") }).getByLabel(translate("views.name")).fill("Hot items");
  await page.getByRole("dialog").getByLabel(translate("views.description")).fill("Urgent and high");
  await page.getByRole("dialog").getByRole("button", { name: translate("views.create") }).click();
  await page.waitForURL(/\/views\/[0-9a-f-]{36}/);

  // Stored exactly: PQL, layout, group by, order by, visible properties.
  const [saved] = await call<View[]>("list_views", { projectId: project!.id });
  check(saved?.name === "Hot items" && saved.query === "priority IN (urgent, high)" && saved.layout === "list" && saved.groupBy === "priority" && saved.orderBy === "title" && saved.orderDirection === "desc"
    && !saved.properties.includes("labels") && saved.properties.includes("state") && saved.access === "public", `stored view was ${JSON.stringify(saved)}`);
  // It reopens exactly: same URL settings, same rows, same grouping, via link, bare URL and reload.
  const settingsOf = () => new URL(page.url()).search;
  await page.getByRole("region", { name: translate("workItems.priority.urgent") }).getByRole("link", { name: "Alpha urgent" }).waitFor();
  check(settingsOf() === shaped, `opened with ${settingsOf()}, saved from ${shaped}`);
  check(await page.getByRole("link", { name: "Charlie low" }).count() === 0, "filter not applied");
  const reopen = async (how: string) => {
    await page.getByRole("region", { name: translate("workItems.priority.high") }).getByRole("link", { name: "Bravo high" }).waitFor();
    check(settingsOf() === shaped, `${how}: settings ${settingsOf()} != ${shaped}`);
    check(await page.getByTestId("row-MOB-1").getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }).count() === 0, `${how}: labels property shown`);
    check(await page.getByRole("button", { name: translate("views.update") }).count() === 0, `${how}: Update view shown for an unchanged view`);
  };
  await reopen("after save");
  const viewPath = new URL(page.url()).pathname;
  await page.goto(`${web}${viewPath}`); await reopen("bare URL");
  await page.reload(); await reopen("reload");
  await page.goto(`${web}/${slug}/projects/MOB/views`);
  await page.getByTestId("view-row-Hot items").getByRole("link", { name: "Hot items" }).click(); await reopen("from the Views page");

  // Update view: change the grouping, the button appears, saving stores it.
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("state");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: translate("views.update") }).click();
  await page.getByRole("status").filter({ hasText: translate("views.updated") }).waitFor();
  await page.getByRole("button", { name: translate("views.update") }).waitFor({ state: "detached" });
  check((await call<View>("get_view", { viewId: saved!.id })).groupBy === "state", "Update view did not store the grouping");
  await page.screenshot({ path: `${shots}/view-detail-1440.png` });

  // Views page: row details, edit to private, create and delete.
  await page.goto(`${web}/${slug}/projects/MOB/views`);
  const row = page.getByTestId("view-row-Hot items");
  await row.getByText("Urgent and high").waitFor();
  await row.getByRole("button", { name: translate("views.menu") }).click();
  await page.getByRole("menuitem", { name: translate("views.edit") }).click();
  await page.getByRole("dialog").getByLabel(translate("views.access")).selectOption("private");
  await page.getByRole("dialog").getByRole("button", { name: translate("views.save") }).click();
  await row.getByLabel(translate("views.access.private")).waitFor();
  check((await call<View>("get_view", { viewId: saved!.id })).access === "private", "edit did not store private");
  await page.getByRole("button", { name: translate("views.add") }).click();
  await page.getByRole("dialog", { name: translate("views.form.createTitle") }).getByLabel(translate("views.name")).fill("Scratch");
  await page.getByRole("dialog").getByRole("button", { name: translate("views.create") }).click();
  const scratch = page.getByTestId("view-row-Scratch");
  await scratch.waitFor();
  check((await call<View[]>("list_views", { projectId: project!.id })).length === 2, "create did not store");
  await page.screenshot({ path: `${shots}/views-1440.png` });
  await scratch.getByRole("button", { name: translate("views.menu") }).click();
  await page.getByRole("menuitem", { name: translate("views.delete") }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: translate("views.deleteAction") }).click();
  await scratch.waitFor({ state: "detached" });
  check((await call<View[]>("list_views", { projectId: project!.id })).map((view) => view.name).join() === "Hot items", "delete did not remove the view");
  check(await call<unknown[]>("list_work_items", { projectId: project!.id }).then((items) => items.length) === 3, "deleting a view changed work items");

  // A deleted View is gone for good: its URL says not found.
  await page.goto(`${web}${viewPath.replace(saved!.id, crypto.randomUUID())}`);
  await page.getByRole("alert").filter({ hasText: translate("views.notFound") }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/projects/MOB/views`);
  await page.getByTestId("view-row-Hot items").waitFor();
  await page.screenshot({ path: `${shots}/views-390.png` });
  await page.goto(`${web}${viewPath}`);
  await page.getByRole("link", { name: "Bravo high" }).waitFor();
  await page.screenshot({ path: `${shots}/view-detail-390.png` });
  console.log("e2e views: ok");
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
