// Browser end-to-end flow for the filter bar: click-to-pick filters compile to filter query, filter query edits update the chips, invalid filter query keeps the last result, filters survive reload.
// Run with `bun e2e/work-items-list.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
// AI is on only with a provider key: a placeholder keeps the AI surfaces shown here, and no model is called.
Bun.env.OPENAI_API_KEY ??= "sk-e2e-placeholder-no-call";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("08-filter-builder-pql");
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
  await page.getByLabel(translate("auth.name")).fill("Filters Tester");
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
  const me = await (await context.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await call("create_work_item", { projectId: project!.id, title: "Alpha", priority: "high", dueDate: day(2) });
  await call("create_work_item", { projectId: project!.id, title: "Bravo", priority: "low" });
  await call("create_work_item", { projectId: project!.id, title: "Charlie", priority: "urgent", dueDate: day(20) });

  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  const titles = async () => (await page.getByTestId(/^row-/).locator("a").allTextContents()).sort().join();
  const waitTitles = async (expected: string) => { for (let i = 0; i < 50; i += 1) { if (await titles() === expected) return; await page.waitForTimeout(100); } check(false, `list shows ${await titles()}, expected ${expected}`); };
  await waitTitles("Alpha,Bravo,Charlie");

  // 1. Picking a filter updates the list, the chip and the filter query text.
  await page.getByRole("button", { name: translate("layout.filters") }).click();
  const dialog = page.getByRole("dialog", { name: translate("layout.filters") });
  const filterSearch = dialog.getByRole("searchbox", { name: translate("layout.filter.search") });
  await filterSearch.fill(translate("layout.filter.priority"));
  const priorityGroup = dialog.getByRole("button", { name: translate("layout.filter.priority") });
  await priorityGroup.waitFor();
  await dialog.getByRole("group", { name: translate("layout.filter.priority") }).getByLabel(translate("workItems.priority.high")).waitFor();
  await filterSearch.fill("no-such-filter");
  await dialog.getByRole("status").getByText(translate("layout.filter.noMatches")).waitFor();
  await filterSearch.fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = dialog;
  const panelBox = await panel.boundingBox();
  check(panelBox !== null && panelBox.x >= 0 && panelBox.x + panelBox.width <= 390, "filter picker overflows the mobile viewport");
  await page.screenshot({ path: `${shots}/filter-picker-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole("button", { name: translate("layout.filter.priority") }).click();
  await dialog.getByRole("group", { name: translate("layout.filter.priority") }).getByLabel(translate("workItems.priority.high")).check();
  await waitTitles("Alpha");
  await page.getByTestId("chip-priority").waitFor();
  await page.screenshot({ path: `${shots}/filter-picker-1440.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: translate("layout.filterQuery.toggle") }).click();
  const filter = page.getByRole("textbox", { name: translate("layout.filterQuery.label") });
  check(await filter.inputValue() === "priority = high", `filter query text was ${await filter.inputValue()}`);
  check(new URL(page.url()).searchParams.get("q") === "priority = high", "the query is not in the URL");

  // 2. Editing the filter query updates the chips when it can be represented.
  await filter.fill("priority IN (high, low)");
  await page.getByRole("button", { name: translate("layout.filterQuery.apply") }).click();
  await waitTitles("Alpha,Bravo");
  check((await page.getByTestId("chip-priority").textContent())?.includes(translate("workItems.priority.low")) === true, "chip did not follow the filter query");

  // 3. Invalid filter query shows the parser error and keeps the last result and the last good query.
  await filter.fill("priority = banana AND");
  await page.getByRole("button", { name: translate("layout.filterQuery.apply") }).click();
  await page.getByTestId("filter-query-error").waitFor();
  check((await page.getByTestId("filter-query-error").textContent())?.startsWith("Invalid query at position") === true, "the parser error is not shown as is");
  check(await titles() === "Alpha,Bravo", "invalid filter query lost the last result");
  check(new URL(page.url()).searchParams.get("q") === "priority IN (high, low)", "invalid filter query replaced the applied query");
  await page.screenshot({ path: `${shots}/filter-query-error-1440.png` });

  // 4. A filter query the chips cannot show is kept as a custom query and still filters.
  await filter.fill("priority = high OR priority = urgent");
  await page.getByRole("button", { name: translate("layout.filterQuery.apply") }).click();
  await waitTitles("Alpha,Charlie");
  await page.getByTestId("chip-custom").waitFor();
  await page.getByTestId("filter-query-error").waitFor({ state: "detached" });

  // 5. Date filter plus a second filter, then a reload keeps both.
  await page.getByRole("button", { name: translate("layout.clearAll") }).click();
  await waitTitles("Alpha,Bravo,Charlie");
  await page.getByRole("button", { name: translate("layout.filters") }).click();
  await dialog.getByRole("button", { name: translate("layout.filter.dueDate") }).click();
  await dialog.getByRole("group", { name: translate("layout.filter.dueDate") }).getByLabel(translate("layout.filter.from")).fill(day(10));
  await waitTitles("Charlie");
  await dialog.getByRole("button", { name: translate("layout.filter.createdBy") }).click();
  await dialog.getByRole("group", { name: translate("layout.filter.createdBy") }).getByLabel("Filters Tester").check();
  await waitTitles("Charlie");
  await page.keyboard.press("Escape");
  const url = page.url();
  await page.reload();
  await waitTitles("Charlie");
  check(page.url() === url, "the URL changed on reload");
  await page.getByTestId("chip-dueDate").waitFor();
  await page.getByTestId("chip-createdBy").waitFor();
  // Removing one chip keeps the other.
  await page.getByRole("button", { name: new RegExp(translate("layout.filter.remove").replace("{filter}", `${translate("layout.filter.dueDate")}.*`)) }).click();
  await waitTitles("Alpha,Bravo,Charlie");
  await page.getByTestId("chip-createdBy").waitFor();
  await page.screenshot({ path: `${shots}/chips-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/chips-390.png` });

  console.log("e2e filter-query: ok");
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
