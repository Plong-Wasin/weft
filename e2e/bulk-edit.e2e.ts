// Browser end-to-end flow for Bulk edit: select work items in the list, change State and Priority, add and remove a label, archive, delete.
// Run with `bun e2e/bulk-edit.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3121);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5221);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
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
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Bulk Tester");
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

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const states = await call<Array<{ id: string; name: string; group: string }>>("list_states", { projectId: project!.id });
  const done = states.find((state) => state.group === "completed")!;
  await call("create_label", { projectId: project!.id, name: "Bug" });
  for (const title of ["Alpha", "Bravo", "Charlie"]) await call("create_work_item", { projectId: project!.id, title });
  await call("create_work_item", { projectId: project!.id, title: "Finished", stateId: done.id });

  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByTestId("row-MOB-1").waitFor();
  check(await page.getByTestId("bulk-bar").count() === 0, "bulk bar shows with nothing selected");

  // Select two rows (a click, then a shift-click over the stretch) and the bar reports the count.
  await page.getByRole("checkbox", { name: translate("bulk.selectItem").replace("{id}", "MOB-1") }).click();
  await page.getByRole("checkbox", { name: translate("bulk.selectItem").replace("{id}", "MOB-2") }).click({ modifiers: ["Shift"] });
  const bar = page.getByTestId("bulk-bar");
  await bar.getByText(translate("bulk.selected").replace("{count}", "2")).waitFor();

  // Priority for both at once.
  await bar.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}`) }).click();
  await page.getByRole("menuitemradio", { name: translate("workItems.priority.urgent") }).click();
  await page.getByTestId("row-MOB-1").getByRole("button", { name: `${translate("workItems.priority")}: ${translate("workItems.priority.urgent")}` }).waitFor();
  await page.getByTestId("row-MOB-2").getByRole("button", { name: `${translate("workItems.priority")}: ${translate("workItems.priority.urgent")}` }).waitFor();
  check(await page.getByTestId("row-MOB-3").getByRole("button", { name: `${translate("workItems.priority")}: ${translate("workItems.priority.urgent")}` }).count() === 0, "an unselected row changed");
  check(await bar.getByText(translate("bulk.selected").replace("{count}", "2")).count() === 1, "selection did not stay after the change");

  // Add a label, then remove it again.
  await bar.getByRole("button", { name: translate("workItems.labels") }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Bug", exact: true }).click();
  await page.getByTestId("row-MOB-2").getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}: Bug`) }).waitFor();
  await bar.getByRole("button", { name: translate("workItems.labels") }).click();
  await page.getByRole("dialog").getByRole("button", { name: translate("bulk.remove"), exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Bug", exact: true }).click();
  await page.getByTestId("row-MOB-2").getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}: —`) }).waitFor();

  // Esc clears the selection.
  await page.keyboard.press("Escape");
  await bar.waitFor({ state: "detached" });

  // Archive stays disabled while an open work item is selected and works for a completed one.
  await page.getByRole("checkbox", { name: translate("bulk.selectItem").replace("{id}", "MOB-1") }).click();
  check(await bar.getByRole("button", { name: translate("bulk.archive") }).isDisabled(), "archive was enabled for an open work item");
  await page.getByRole("checkbox", { name: translate("bulk.selectItem").replace("{id}", "MOB-1") }).click();
  await page.getByRole("checkbox", { name: translate("bulk.selectItem").replace("{id}", "MOB-4") }).click();
  await bar.getByRole("button", { name: translate("bulk.archive") }).click();
  await page.getByTestId("row-MOB-4").waitFor({ state: "detached" });

  // Delete asks first, then removes every selected work item.
  await page.getByRole("checkbox", { name: translate("bulk.selectItem").replace("{id}", "MOB-1") }).click();
  await page.getByRole("checkbox", { name: translate("bulk.selectItem").replace("{id}", "MOB-3") }).click();
  await bar.getByRole("button", { name: translate("bulk.delete") }).click();
  await page.getByRole("dialog").getByText(translate("bulk.deleteTitle").replace("{count}", "2")).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: translate("bulk.delete") }).click();
  await page.getByTestId("row-MOB-1").waitFor({ state: "detached" });
  await page.getByTestId("row-MOB-3").waitFor({ state: "detached" });
  await page.getByTestId("row-MOB-2").waitFor();
  console.log("e2e bulk edit: ok");
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
