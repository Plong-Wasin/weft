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
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Lists Tester");
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
  await page.getByText(translate("projects.shapeFull"), { exact: true }).click(); // a new project starts Simple; this flow needs Cycles, Modules and Intake
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
  const selectAll = page.getByRole("checkbox", { name: translate("bulk.selectAll") });
  check(await selectAll.evaluate((input, label) => input.closest("label")?.getAttribute("title") === label, translate("bulk.selectAll")), "select-all checkbox is missing its explanatory tooltip");
  for (const layout of ["list", "board", "spreadsheet", "calendar", "gantt"] as const) {
    const switchButton = page.getByRole("button", { name: translate(`layout.${layout}`) });
    check(await switchButton.getAttribute("title") === translate(`layout.${layout}`), `${layout} layout icon is missing its tooltip`);
  }
  // An empty project shows one empty state instead of the status groups, so its Add work item button creates the first item (in the modal, Backlog by default).
  await page.getByRole("status").filter({ hasText: translate("workItems.emptyHint") }).getByRole("button", { name: translate("workItems.addNew"), exact: true }).click();
  const modal = page.getByRole("dialog", { name: translate("workItems.modal.title") });
  await modal.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Alpha");
  await modal.getByRole("button", { name: translate("workItems.modal.submit"), exact: true }).click();
  await page.getByRole("link", { name: "Alpha" }).waitFor();
  // Quick create: a group's "+" creates in that state (the Backlog group holds new work items by default).
  await page.getByRole("button", { name: translate("layout.addToGroup").replace("{group}", "Backlog") }).click();
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Bravo");
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).press("Enter");
  await page.getByRole("link", { name: "Bravo" }).waitFor();
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
  // A collapsed empty group (Done holds nothing) expands through its toggle and collapses again.
  const done = page.getByRole("button", { name: `${translate("layout.toggleGroup")}: Done` });
  check(await done.getAttribute("aria-expanded") === "false", "an empty group should start collapsed");
  await done.click();
  check(await done.getAttribute("aria-expanded") === "true", "an empty group did not expand through its toggle");
  await done.click();
  check(await done.getAttribute("aria-expanded") === "false", "an empty group did not collapse again");
  await page.screenshot({ path: `${shots}/list-1440-light.png` });

  // Each inline dropdown changes the work item without a reload (a marker on window survives only without navigation).
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
  const row = page.getByTestId("row-MOB-1");
  const emptyCycleTrigger = row.getByRole("button", { name: `${translate("workItems.cycle")}: ${translate("workItems.noCycle")}` });
  const cycleBeforeReveal = await emptyCycleTrigger.boundingBox();
  await row.screenshot({ path: "/tmp/popover-scroll-row-before.png" });
  await row.hover();
  const cycleAfterHover = await emptyCycleTrigger.boundingBox();
  check(Boolean(cycleBeforeReveal && cycleAfterHover) && Math.abs(cycleBeforeReveal!.x - cycleAfterHover!.x) < 1 && Math.abs(cycleBeforeReveal!.y - cycleAfterHover!.y) < 1, `hovering a row should reveal its Cycle control without moving it: ${JSON.stringify({ before: cycleBeforeReveal, after: cycleAfterHover })}`);
  await row.screenshot({ path: "/tmp/popover-scroll-row-after-hover.png" });
  await page.mouse.move(0, 0);
  await row.getByRole("link", { name: "Alpha" }).focus();
  await page.keyboard.press("Tab");
  check(await row.getByRole("button", { name: new RegExp(`^${translate("workItems.state")}:`) }).evaluate((element) => document.activeElement === element), "keyboard focus should remain on the next row control");
  const cycleAfterKeyboardFocus = await emptyCycleTrigger.boundingBox();
  check(Boolean(cycleAfterHover && cycleAfterKeyboardFocus) && Math.abs(cycleAfterHover!.x - cycleAfterKeyboardFocus!.x) < 1 && Math.abs(cycleAfterHover!.y - cycleAfterKeyboardFocus!.y) < 1, "keyboard focus should reveal row controls in stable positions");
  check(await emptyCycleTrigger.evaluate((element) => getComputedStyle(element.parentElement!).opacity === "1"), "keyboard focus should reveal the row's empty property controls");
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.state")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "In Progress" }).click();
  await page.getByRole("region", { name: "In Progress" }).getByRole("link", { name: "Alpha" }).waitFor();

  await row.hover(); // empty property chips stay out of sight until the row is hovered or focused
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).click();
  await page.getByRole("menuitemradio", { name: translate("workItems.priority.urgent") }).click();
  await row.getByRole("button", { name: `${translate("workItems.priority")}: ${translate("workItems.priority.urgent")}` }).waitFor();

  await row.hover(); // empty property chips stay out of sight until the row is hovered or focused
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Lists Tester" }).click();
  await row.getByRole("button", { name: `${translate("workItems.assignees")}: Lists Tester` }).waitFor();
  await page.keyboard.press("Escape");

  await row.hover(); // empty property chips stay out of sight until the row is hovered or focused
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Bug" }).click();
  await row.getByRole("button", { name: `${translate("workItems.labels")}: Bug` }).waitFor();
  await page.keyboard.press("Escape");

  await row.hover(); // empty property chips stay out of sight until the row is hovered or focused
  await row.getByRole("button", { name: new RegExp(`^${translate("layout.property.dates")}:`) }).click();
  const calendar = page.locator("[data-popover-panel]");
  await calendar.getByRole("button", { name: new RegExp(`^${translate("workItems.dueDate")}`) }).click();
  for (let turn = 0; turn < 3 && await calendar.locator(`[data-date="${day(3)}"]`).count() === 0; turn += 1) await calendar.getByRole("button", { name: translate("datePicker.nextMonth") }).click();
  await calendar.locator(`[data-date="${day(3)}"]`).click();
  const shortDue = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day(3)}T00:00:00Z`));
  await row.getByRole("button", { name: `${translate("layout.property.dates")}: ${shortDue}` }).waitFor();
  await page.keyboard.press("Escape");

  await row.hover(); // empty property chips stay out of sight until the row is hovered or focused
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.cycle")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "Sprint 1" }).click();
  await row.getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 1` }).waitFor();

  await row.hover(); // empty property chips stay out of sight until the row is hovered or focused
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.modules")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Auth" }).click();
  await row.getByRole("button", { name: `${translate("workItems.modules")}: Auth` }).waitFor();
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true), "the page reloaded");

  // Enough rows and Cycle options to exercise both the list's scroll container and the picker's own scroll area.
  for (let index = 0; index < 16; index += 1) {
    await call("create_work_item", { projectId: project!.id, title: `Scroll row ${index + 1}` });
    if (index > 0) await call("create_cycle", { projectId: project!.id, name: `Sprint ${index + 2}`, startDate: day(-1), endDate: day(6) });
  }
  await page.reload();
  const main = page.locator("#main-content");
  await main.evaluate((element) => { element.scrollTop = 0; });
  await page.getByTestId("row-MOB-1").waitFor();
  const cycleTrigger = page.getByTestId("row-MOB-1").getByRole("button", { name: new RegExp(`^${translate("workItems.cycle")}:`) });
  await cycleTrigger.click();
  const cycleMenu = page.locator("[data-popover-panel]");
  await cycleMenu.waitFor();
  await cycleMenu.getByRole("menuitemradio", { name: "Sprint 17" }).waitFor();
  const cycleMenuMetrics = await cycleMenu.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, optionCount: element.querySelectorAll("[role=menuitemradio]").length, maxHeight: getComputedStyle(element).maxHeight }));
  await cycleMenu.evaluate((element) => { element.scrollTop = 160; });
  check(await cycleMenu.evaluate((element) => element.scrollTop > 0), `Cycle options should scroll inside the menu: ${JSON.stringify(cycleMenuMetrics)}`);
  await page.screenshot({ path: "/tmp/popover-scroll-desktop-open.png" });
  await main.evaluate((element) => { element.scrollTop += 40; });
  await page.waitForFunction(() => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="row-MOB-1"] button[aria-label^="Cycle:"]');
    const menu = document.querySelector<HTMLElement>("[data-popover-panel]");
    if (!trigger || !menu) return false;
    const anchor = trigger.getBoundingClientRect();
    const panel = menu.getBoundingClientRect();
    const overlapsHorizontally = panel.left < anchor.right && panel.right > anchor.left;
    return overlapsHorizontally && (Math.abs(panel.top - anchor.bottom - 4) < 1 || Math.abs(anchor.top - panel.bottom - 4) < 1);
  });
  check(await cycleMenu.isVisible(), "Cycle picker should remain open while its trigger is visible");
  await page.keyboard.press("Escape");
  await cycleMenu.waitFor({ state: "detached" });
  check(await cycleTrigger.evaluate((element) => document.activeElement === element), "Escape should return focus to the Cycle trigger");

  await cycleTrigger.click();
  await cycleMenu.getByRole("menuitemradio", { name: "Sprint 17" }).waitFor();
  await cycleMenu.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await cycleMenu.getByRole("menuitemradio", { name: "Sprint 17" }).click();
  await row.getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 17` }).waitFor();
  check(await cycleTrigger.getAttribute("aria-label") === `${translate("workItems.cycle")}: Sprint 17`, "selection should work after scrolling the long Cycle menu");
  await cycleTrigger.click();
  await cycleMenu.waitFor();
  await main.evaluate((element) => { element.scrollTop = 0; });
  await cycleMenu.waitFor({ state: "detached" });
  check(await main.evaluate((element) => element.scrollTop === 0), "dismissing an offscreen picker should not scroll its trigger back into view");
  await main.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: `${shots}/list-1440-edited.png` });

  // The edits are real: the Actions stored them (reload and read back through the API).
  await page.reload();
  const stored = await call<{ priority: string; assigneeIds: string[]; labelIds: string[]; dueDate: string | null; stateId: string }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: "MOB-1" });
  check(stored.priority === "urgent" && stored.assigneeIds.length === 1 && stored.labelIds.length === 1 && stored.dueDate === day(3), "an inline edit was not stored");
  const selectedCycle = (await call<Array<{ id: string; name: string }>>("list_cycles", { projectId: project!.id })).find((cycle) => cycle.name === "Sprint 17");
  const inCycle = await call<Array<{ displayId: string }>>("list_work_items", { projectId: project!.id, cycleId: selectedCycle!.id });
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
  await page.getByRole("button", { name: translate("layout.display") }).click();
  const labelsProperty = page.getByLabel(translate("layout.property.labels"), { exact: true });
  if (!(await labelsProperty.isChecked())) await labelsProperty.check();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileListUrl = page.url();
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(mobileListUrl);
  const mobileCycleTrigger = mobilePage.getByTestId("row-MOB-1").getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 17` });
  await mobileCycleTrigger.click();
  const mobileCycleMenu = mobilePage.locator("[data-popover-panel]");
  await mobileCycleMenu.getByRole("menuitemradio", { name: "Sprint 17" }).waitFor();
  const mobileMenuBounds = await mobileCycleMenu.boundingBox();
  check(Boolean(mobileMenuBounds && mobileMenuBounds.x >= 0 && mobileMenuBounds.x + mobileMenuBounds.width <= 390), "Cycle picker should stay within the phone viewport");
  await mobilePage.screenshot({ path: "/tmp/popover-scroll-mobile-open.png" });
  const mobileMain = mobilePage.locator("#main-content");
  await mobileMain.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await mobileCycleMenu.waitFor({ state: "detached" });
  check(await mobileMain.evaluate((element) => element.scrollTop > 0), "phone scrolling should dismiss the picker without restoring its offscreen trigger");
  await mobileContext.close();
  await page.screenshot({ path: `${shots}/list-390-light.png` });
  for (const layout of ["list", "board", "spreadsheet", "calendar", "gantt"] as const) {
    check(await page.getByRole("button", { name: translate(`layout.${layout}`) }).getByText(translate(`layout.${layout}`)).isVisible(), `${layout} is icon-only on a phone`);
  }
  check(await page.getByText(translate("bulk.selectShown"), { exact: true }).isVisible(), "select-all has no visible phone label");
  const titleBox = await page.getByRole("heading", { name: /MOB · Mobile/ }).boundingBox();
  const settingsBox = await page.getByRole("link", { name: translate("projects.settings") }).boundingBox();
  check(Boolean(titleBox && settingsBox) && Math.abs(titleBox!.y - settingsBox!.y) < 3, "project title and Settings wrap onto separate phone rows");
  await page.getByRole("button", { name: translate("layout.board") }).click();
  const phoneCard = page.getByTestId("card-MOB-2");
  await phoneCard.getByText(translate("workItems.noAssignee"), { exact: true }).waitFor();
  await phoneCard.getByText(translate("layout.noLabel"), { exact: true }).waitFor();
  await phoneCard.getByText(translate("workItems.noModules"), { exact: true }).waitFor();
  await phoneCard.getByText(translate("workItems.noCycle"), { exact: true }).waitFor();
  await phoneCard.getByText(translate("workItems.noDates"), { exact: true }).waitFor();
  await page.screenshot({ path: `${shots}/board-390-light.png` });
  await page.getByRole("button", { name: translate("layout.addToGroup").replace("{group}", translate("workItems.priority.none")) }).getByText(translate("layout.addShort")).waitFor();
  await page.getByRole("button", { name: translate("layout.gantt") }).click();
  await page.getByTestId("gantt-layout").waitFor();
  await page.getByText(translate("layout.gantt.scrollHint"), { exact: true }).waitFor();
  await page.getByTestId("gantt-bar-MOB-1").waitFor();
  check(await page.getByTestId("row-MOB-1").count() === 0, "phone Gantt silently falls back to the grouped list");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "phone Gantt scrolls the whole page sideways instead of its timeline");
  const dueEdge = page.getByRole("button", { name: `${translate("layout.gantt.resizeDue")} MOB-1` });
  await dueEdge.focus();
  const keyboardResize = page.waitForResponse((response) => response.url().includes("update_work_item") && response.ok() && (response.request().postData() ?? "").includes("dueDate"));
  await page.keyboard.press("ArrowRight");
  await keyboardResize;
  const resizedItem = await call<{ dueDate: string | null }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: "MOB-1" });
  check(resizedItem.dueDate === day(4), "keyboard resizing the Gantt due date did not save one day later");
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
