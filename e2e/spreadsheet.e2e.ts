// Browser end-to-end flow for the spreadsheet layout: columns, inline edits, column chooser and order in the URL, sticky first column, sideways scroll.
// Run with `bun e2e/spreadsheet.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("09-spreadsheet-layout");
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
  await page.getByLabel(translate("auth.name")).fill("Sheet Tester");
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
  await call("create_label", { projectId: project!.id, name: "Bug" });
  await call("create_cycle", { projectId: project!.id, name: "Sprint 1", startDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), endDate: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10) });
  await call("create_module", { projectId: project!.id, name: "Auth" });
  for (const title of ["Alpha", "Bravo"]) await call("create_work_item", { projectId: project!.id, title });

  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("link", { name: "Alpha" }).waitFor();
  const projectUrl = page.url();

  // Switch to the spreadsheet: one row per work item, one column per property.
  await page.getByRole("tab", { name: translate("layout.spreadsheet") }).click();
  check(page.url().includes("layout=spreadsheet"), "layout missing from URL");
  await page.getByRole("table").waitFor();
  const headers = await page.getByRole("columnheader").allInnerTexts();
  for (const key of ["state", "priority", "assignee", "labels", "dates", "cycle", "modules"]) check(headers.includes(translate(`layout.property.${key}` as never)), `column ${key} missing: ${headers}`);
  check(await page.getByRole("row").count() === 3, "expected header + 2 rows");
  await page.screenshot({ path: `${shots}/sheet-1440-light.png` });

  // Inline edits go through the Actions: state and priority persist after reload.
  const row = page.getByTestId("row-MOB-1");
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.state")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "In Progress" }).click();
  await row.getByRole("button", { name: `${translate("workItems.state")}: In Progress` }).waitFor();
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).click();
  await page.getByRole("menuitemradio", { name: translate("workItems.priority.urgent") }).click();
  await row.getByRole("button", { name: `${translate("workItems.priority")}: ${translate("workItems.priority.urgent")}` }).waitFor();
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Bug" }).click();
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: `${translate("workItems.labels")}: Bug` }).waitFor();
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.cycle")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "Sprint 1" }).click();
  await row.getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 1` }).waitFor();
  const stored = await call<Array<{ displayId: string; priority: string; labelIds: string[] }>>("list_work_items", { projectId: project!.id });
  const alpha = stored.find((item) => item.displayId === "MOB-1")!;
  check(alpha.priority === "urgent" && alpha.labelIds.length === 1, "edits not stored through the Actions");
  await page.reload();
  await page.getByTestId("row-MOB-1").getByRole("button", { name: `${translate("workItems.priority")}: ${translate("workItems.priority.urgent")}` }).waitFor();

  // Column chooser: hide Labels, move Dates earlier; both live in the URL and survive reload.
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByRole("checkbox", { name: translate("layout.property.labels") }).uncheck();
  await page.getByRole("button", { name: `${translate("layout.column.earlier")}: ${translate("layout.property.dates")}` }).click();
  await page.keyboard.press("Escape");
  const props = new URL(page.url()).searchParams.get("props")!.split(",");
  check(!props.includes("labels"), "labels still in URL props");
  check(props.indexOf("dates") === props.indexOf("assignee") - 1 || props.indexOf("dates") < props.indexOf("assignee"), `dates not moved: ${props}`);
  await page.reload();
  await page.getByRole("columnheader").first().waitFor();
  const after = await page.getByRole("columnheader").allInnerTexts();
  check(!after.includes(translate("layout.property.labels")), "labels column back after reload");
  check(after.indexOf(translate("layout.property.dates")) < after.indexOf(translate("layout.property.assignee")), `order lost after reload: ${after}`);

  // Narrow viewport: the table scrolls sideways and the first column stays put.
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = page.getByTestId("sheet-scroll");
  check(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth), "no horizontal scroll at 390px");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page itself scrolls sideways at 390px");
  const before = await page.getByRole("rowheader").first().boundingBox();
  await scroll.evaluate((el) => { el.scrollLeft = 300; });
  const sticky = await page.getByRole("rowheader").first().boundingBox();
  check(Math.abs(before!.x - sticky!.x) < 1, `first column moved: ${before!.x} -> ${sticky!.x}`);
  await page.screenshot({ path: `${shots}/sheet-390-light.png` });

  // The list layout still renders at the plain project URL.
  await page.goto(projectUrl);
  await page.getByRole("region", { name: "In Progress" }).getByRole("link", { name: "Alpha" }).waitFor();
  console.log("spreadsheet e2e passed");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
