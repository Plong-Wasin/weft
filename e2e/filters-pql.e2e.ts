// Browser end-to-end flow for the filter bar: click-to-pick filters compile to PQL, PQL edits update the chips, invalid PQL keeps the last result, filters survive reload.
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
  if (await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).count()) await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
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

  // 1. Picking a filter updates the list, the chip and the PQL text.
  await page.getByRole("button", { name: translate("layout.filters") }).click();
  const dialog = page.getByRole("dialog", { name: translate("layout.filters") });
  await dialog.getByRole("button", { name: translate("layout.filter.priority") }).click();
  await dialog.getByRole("group", { name: translate("layout.filter.priority") }).getByLabel(translate("workItems.priority.high")).check();
  await waitTitles("Alpha");
  await page.getByTestId("chip-priority").waitFor();
  await page.screenshot({ path: `${shots}/filter-picker-1440.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: translate("layout.pql.toggle") }).click();
  const pql = page.getByRole("textbox", { name: translate("layout.pql.label") });
  check(await pql.inputValue() === "priority = high", `PQL text was ${await pql.inputValue()}`);
  check(new URL(page.url()).searchParams.get("q") === "priority = high", "the query is not in the URL");

  // 2. Editing the PQL updates the chips when it can be represented.
  await pql.fill("priority IN (high, low)");
  await page.getByRole("button", { name: translate("layout.pql.apply") }).click();
  await waitTitles("Alpha,Bravo");
  check((await page.getByTestId("chip-priority").textContent())?.includes(translate("workItems.priority.low")) === true, "chip did not follow the PQL");

  // 3. Invalid PQL shows the parser error and keeps the last result and the last good query.
  await pql.fill("priority = banana AND");
  await page.getByRole("button", { name: translate("layout.pql.apply") }).click();
  await page.getByTestId("pql-error").waitFor();
  check((await page.getByTestId("pql-error").textContent())?.startsWith("Invalid query at position") === true, "the parser error is not shown as is");
  check(await titles() === "Alpha,Bravo", "invalid PQL lost the last result");
  check(new URL(page.url()).searchParams.get("q") === "priority IN (high, low)", "invalid PQL replaced the applied query");
  await page.screenshot({ path: `${shots}/pql-error-1440.png` });

  // 4. PQL the chips cannot show is kept as a custom query and still filters.
  await pql.fill("priority = high OR priority = urgent");
  await page.getByRole("button", { name: translate("layout.pql.apply") }).click();
  await waitTitles("Alpha,Charlie");
  await page.getByTestId("chip-custom").waitFor();
  await page.getByTestId("pql-error").waitFor({ state: "detached" });

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

  console.log("e2e filters-pql: ok");
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
