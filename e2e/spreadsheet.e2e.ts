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
const localDay = (offset: number) => { const date = new Date(); date.setDate(date.getDate() + offset); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"); };

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
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  await call("create_label", { projectId: project!.id, name: "Bug" });
  await call("create_cycle", { projectId: project!.id, name: "Sprint 1", startDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), endDate: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10) });
  await call("create_module", { projectId: project!.id, name: "Auth" });
  const longLabelName = "Authentication architecture review and rollout planning";
  const longModuleName = "Identity and access management migration workstream";
  const longStateName = "Awaiting final platform-wide reliability verification";
  const longCycleName = "Authentication migration validation across all supported deployment regions";
  const longLabel = await call<{ id: string }>("create_label", { projectId: project!.id, name: longLabelName });
  const longModule = await call<{ id: string }>("create_module", { projectId: project!.id, name: longModuleName });
  const longState = await call<{ id: string }>("create_state", { projectId: project!.id, name: longStateName, group: "started" });
  const wideGlyphStateName = "WWWWWWWWWWWWWW";
  const wideGlyphState = await call<{ id: string }>("create_state", { projectId: project!.id, name: wideGlyphStateName, group: "started" });
  const longCycle = await call<{ id: string }>("create_cycle", { projectId: project!.id, name: longCycleName, startDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), endDate: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10) });
  for (const title of ["Alpha", "Bravo"]) await call("create_work_item", { projectId: project!.id, title });
  const longTitle = "Coordinate the authentication migration with teams in every supported region";
  const longItem = await call<{ id: string; displayId: string }>("create_work_item", { projectId: project!.id, title: longTitle, dueDate: localDay(-2) });
  const wideGlyphItem = await call<{ id: string; displayId: string }>("create_work_item", { projectId: project!.id, title: "Wide glyph state" });
  await call("update_work_item", { workItemId: wideGlyphItem.id, stateId: wideGlyphState.id });
  await call("update_work_item", { workItemId: longItem.id, stateId: longState.id, labelIds: [longLabel.id] });
  await call("add_module_items", { moduleId: longModule.id, workItemIds: [longItem.id] });
  await call("add_cycle_items", { cycleId: longCycle.id, workItemIds: [longItem.id] });

  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("link", { name: "Alpha" }).waitFor();
  const projectUrl = page.url();

  // Switch to the spreadsheet: one row per work item, one column per property.
  await page.getByRole("button", { name: translate("layout.spreadsheet") }).click();
  check(page.url().includes("layout=spreadsheet"), "layout missing from URL");
  await page.getByRole("table", { name: translate("layout.spreadsheet") }).waitFor();
  const headers = await page.getByRole("columnheader").allInnerTexts();
  for (const key of ["state", "priority", "assignee", "labels", "dates", "cycle", "modules"]) check(headers.includes(translate(`layout.property.${key}` as never)), `column ${key} missing: ${headers}`);
  check(await page.getByRole("row").count() === 5, "expected header + 4 rows");
  const scroll = page.getByTestId("sheet-scroll");
  const workItemColumn = await page.getByRole("columnheader", { name: translate("layout.sheet.workItem") }).boundingBox();
  check(!!workItemColumn && workItemColumn.width >= 350 && workItemColumn.width <= 450, `Work item column should stay within its readable width bounds: ${workItemColumn?.width}`);
  for (const [property, minimum] of [["state", 112], ["priority", 112], ["assignee", 112], ["labels", 128], ["dates", 128], ["cycle", 112], ["modules", 128]] as const) {
    const width = await page.getByRole("columnheader", { name: translate(`layout.property.${property}`) }).evaluate((element) => element.getBoundingClientRect().width);
    check(width >= minimum && width <= 200, `${property} column should stay within ${minimum}–200px bounds, found ${width}`);
  }
  const longRow = page.getByTestId(`row-${longItem.displayId}`);
  const longTitleLink = longRow.getByRole("link", { name: longTitle, exact: true });
  await longTitleLink.waitFor();
  const longTitleBox = await longTitleLink.boundingBox();
  check(!!longTitleBox && longTitleBox.width > 200 && longTitleBox.height <= 24, `long Work item title should stay on one visible line in the wider column: ${JSON.stringify(longTitleBox)}`);
  check(await longTitleLink.getAttribute("title") === longTitle, "clamped title should expose the full text as a tooltip");
  const rowHeights = await page.getByTestId(/^row-/).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  check(rowHeights.length === 4 && rowHeights.every((height) => Math.abs(height - 48) <= 1), `spreadsheet rows must be equal 48px rows: ${rowHeights.join(", ")}`);
  const titleGlyphs = await longTitleLink.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const glyphRects = [...range.getClientRects()];
    return { lineCount: new Set(glyphRects.map((rect) => Math.round(rect.top))).size, glyphHeight: range.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight), clippedHorizontally: element.scrollWidth > element.clientWidth };
  });
  check(titleGlyphs.lineCount === 1 && titleGlyphs.glyphHeight <= titleGlyphs.lineHeight && titleGlyphs.clippedHorizontally, `long title should render one unclipped glyph line with ellipsis in its bounded cell: ${JSON.stringify(titleGlyphs)}`);
  const blankAssigneeCell = longRow.getByRole("cell").nth(2);
  check(await blankAssigneeCell.getAttribute("data-empty-property") === "true" && await blankAssigneeCell.locator("span").first().evaluate((el) => getComputedStyle(el).opacity === "0"), "empty spreadsheet property cells should stay visually blank until row hover or focus");
  await blankAssigneeCell.hover();
  check(await blankAssigneeCell.locator("span").first().evaluate((el) => getComputedStyle(el).opacity === "1"), "empty spreadsheet property controls should appear on row hover");
  const longLabelButton = longRow.getByRole("button", { name: `${translate("workItems.labels")}: ${longLabelName}` });
  const longModuleButton = longRow.getByRole("button", { name: `${translate("workItems.modules")}: ${longModuleName}` });
  const longStateButton = longRow.getByRole("button", { name: `${translate("workItems.state")}: ${longStateName}` });
  check(await longStateButton.evaluate((element) => getComputedStyle(element).borderTopWidth === "0px"), "spreadsheet State cell should use a quiet borderless value");
  for (const [index, property] of ["state", "priority", "assignee", "labels", "dates", "cycle", "modules"].entries()) {
    const header = page.getByRole("columnheader", { name: translate(`layout.property.${property}`) });
    const cell = longRow.getByRole("cell").nth(index);
    const [headerX, cellX] = await Promise.all([header.evaluate((element) => element.getBoundingClientRect().x), cell.evaluate((element) => element.getBoundingClientRect().x)]);
    check(Math.abs(headerX - cellX) <= 1, `spreadsheet ${property} header aligns with its cells (Spreadsheet${property}HeaderAligned): ${headerX} / ${cellX}`);
  }
  const longCycleButton = longRow.getByRole("button", { name: `${translate("workItems.cycle")}: ${longCycleName}` });
  const overdueDate = longRow.getByTitle(translate("datePicker.overdue"), { exact: true });
  check(await overdueDate.count() === 1, "overdue DatesMenu should keep the Overdue hover tooltip");
  await overdueDate.hover();
  check(await overdueDate.getAttribute("title") === translate("datePicker.overdue"), "hovering DatesMenu's overdue date should still say Overdue");
  for (const [button, name] of [[longLabelButton, longLabelName], [longModuleButton, longModuleName]] as const) {
    const value = button.locator(`span[title="${name}"]`);
    check(await value.getAttribute("title") === name, `truncated ${name} should retain its full text on hover`);
    check(await value.evaluate((element) => element.scrollWidth > element.clientWidth), `${name} should be visibly bounded instead of widening its table column`);
  }
  for (const [button, role, name] of [
    [longStateButton, "menuitemradio", longStateName], [longCycleButton, "menuitemradio", longCycleName],
    [longLabelButton, "menuitemcheckbox", longLabelName], [longModuleButton, "menuitemcheckbox", longModuleName],
  ] as const) {
    await button.focus();
    await page.keyboard.press("Enter");
    const option = page.getByRole(role, { name, exact: true });
    await option.waitFor();
    const optionBox = await option.boundingBox();
    check(!!optionBox && optionBox.height > 28, `${name} option should wrap visibly in the picker for keyboard users`);
    await page.keyboard.press("Escape");
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
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
  await page.getByRole("checkbox", { name: translate("layout.property.labels") }).click();
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
  check(await scroll.getAttribute("role") === "region" && await scroll.getAttribute("tabindex") === "0", "spreadsheet scroll region should be named and keyboard focusable");
  check(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth), "no horizontal scroll at 390px");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page itself scrolls sideways at 390px");
  const phoneWorkItemColumn = await page.getByRole("rowheader").first().boundingBox();
  check(!!phoneWorkItemColumn && phoneWorkItemColumn.width >= 190 && phoneWorkItemColumn.width <= 220, `phone Work item column should leave room for other cells: ${phoneWorkItemColumn?.width}`);
  await page.screenshot({ path: `${shots}/sheet-390-left-light.png` });
  await scroll.focus();
  const beforeKeyboardScroll = await scroll.evaluate((el) => el.scrollLeft);
  await page.keyboard.press("ArrowRight");
  check(await scroll.evaluate((el, before) => el.scrollLeft > before, beforeKeyboardScroll), "keyboard focus on the spreadsheet did not scroll its columns");
  const before = await page.getByRole("rowheader").first().boundingBox();
  await scroll.evaluate((el) => { el.scrollLeft = 300; });
  const sticky = await page.getByRole("rowheader").first().boundingBox();
  check(Math.abs(before!.x - sticky!.x) < 1, `first column moved: ${before!.x} -> ${sticky!.x}`);
  await page.screenshot({ path: `${shots}/sheet-390-light.png` });

  // The list layout still renders at the plain project URL.
  await page.goto(projectUrl);
  await page.getByRole("region", { name: "In Progress" }).getByRole("link", { name: "Alpha" }).waitFor();
  const listLongRow = page.getByTestId(`row-${longItem.displayId}`);
  for (const [property, name] of [["labels", longLabelName], ["modules", longModuleName]] as const) {
    const button = listLongRow.getByRole("button", { name: `${translate(`workItems.${property}`)}: ${name}` });
    const value = button.locator(`span[title="${name}"]`);
    check(await value.evaluate((element) => element.clientWidth <= 112 && element.scrollWidth > element.clientWidth), `long ${property} should stay bounded in a list row`);
  }

  const touchContext = await browser.newContext({ storageState: await context.storageState(), hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const touchPage = await touchContext.newPage();
  const sheetUrl = new URL(projectUrl); sheetUrl.searchParams.set("layout", "spreadsheet");
  await touchPage.goto(sheetUrl.toString());
  const touchRow = touchPage.getByTestId(`row-${longItem.displayId}`);
  const touchWorkItemColumn = await touchRow.getByRole("rowheader").boundingBox();
  check(!!touchWorkItemColumn && touchWorkItemColumn.width <= 220, `touch Work item column leaves too little room for properties: ${touchWorkItemColumn?.width}`);
  const touchScroll = touchPage.getByTestId("sheet-scroll");
  for (const [label, role, name] of [
    [translate("workItems.state"), "menuitemradio", longStateName], [translate("workItems.cycle"), "menuitemradio", longCycleName],
    [translate("workItems.labels"), "menuitemcheckbox", longLabelName], [translate("workItems.modules"), "menuitemcheckbox", longModuleName],
  ] as const) {
    const trigger = touchRow.getByRole("button", { name: `${label}: ${name}` });
    await trigger.scrollIntoViewIfNeeded();
    let triggerBox = await trigger.boundingBox();
    const workItemBox = await touchRow.getByRole("rowheader").boundingBox();
    check(!!triggerBox && !!workItemBox, `${label} control or sticky Work item column is missing on touch`);
    const offsetToClearSticky = Math.max(0, workItemBox.x + workItemBox.width + 8 - triggerBox.x);
    if (offsetToClearSticky > 0) {
      await touchScroll.evaluate((element, offset) => { element.scrollLeft = Math.max(0, element.scrollLeft - offset); }, offsetToClearSticky);
      triggerBox = await trigger.boundingBox();
    }
    const scrollBox = await touchScroll.boundingBox();
    const workItemAfterScroll = await touchRow.getByRole("rowheader").boundingBox();
    const center = triggerBox!.x + triggerBox!.width / 2;
    check(!!scrollBox && !!workItemAfterScroll && center >= workItemAfterScroll.x + workItemAfterScroll.width && center <= scrollBox.x + scrollBox.width, `${label} control is covered by the sticky Work item column on touch`);
    await trigger.tap();
    const option = touchPage.getByRole(role, { name, exact: true });
    await option.waitFor();
    const optionBox = await option.boundingBox();
    check(!!optionBox && optionBox.height > 28, `${name} option should wrap visibly in the picker on touch`);
    await touchPage.keyboard.press("Escape");
  }
  // A mocked Guest role exercises read-only property chips without granting the test user any additional permissions.
  await touchPage.route("**/actions/get_project", async (route) => {
    const response = await route.fetch();
    const projectData = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...projectData, role: "Guest" } });
  });
  await touchPage.goto(sheetUrl.toString());
  const guestLongRow = touchPage.getByTestId(`row-${longItem.displayId}`);
  const fullPriorityName = `${translate("workItems.priority")}: ${translate("workItems.priority.none")}`;
  const guestPriority = guestLongRow.getByRole("button", { name: fullPriorityName });
  await guestPriority.waitFor();
  const priorityValue = guestPriority.locator("span[title]");
  const prioritySizing = await priorityValue.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  check(prioritySizing.scrollWidth <= prioritySizing.clientWidth, `short priority value should fit without truncation: ${JSON.stringify(prioritySizing)}`);
  await guestPriority.tap();
  await touchPage.getByRole("dialog", { name: fullPriorityName }).getByText(fullPriorityName, { exact: true }).waitFor();
  await touchPage.keyboard.press("Escape");
  const guestWideRow = touchPage.getByTestId(`row-${wideGlyphItem.displayId}`);
  const fullWideGlyphName = `${translate("workItems.state")}: ${wideGlyphStateName}`;
  const guestWideGlyph = guestWideRow.getByRole("button", { name: fullWideGlyphName });
  const wideGlyphValue = guestWideGlyph.locator("span[title]");
  const wideSizing = await wideGlyphValue.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  check(wideSizing.scrollWidth > wideSizing.clientWidth, `short wide-glyph state should actually truncate: ${JSON.stringify(wideSizing)}`);
  console.log(`read-only reveal sizing: wide state ${wideSizing.scrollWidth}/${wideSizing.clientWidth}px; priority ${prioritySizing.scrollWidth}/${prioritySizing.clientWidth}px`);
  await guestWideGlyph.scrollIntoViewIfNeeded();
  await guestWideGlyph.tap();
  await touchPage.getByRole("dialog", { name: fullWideGlyphName }).getByText(fullWideGlyphName, { exact: true }).waitFor();
  await touchPage.keyboard.press("Escape");
  await guestWideGlyph.focus();
  await touchPage.keyboard.press("Enter");
  await touchPage.getByRole("dialog", { name: fullWideGlyphName }).getByText(fullWideGlyphName, { exact: true }).waitFor();
  await touchPage.keyboard.press("Escape");
  for (const [label, name] of [["state", longStateName], ["cycle", longCycleName], ["labels", longLabelName], ["modules", longModuleName]] as const) {
    const fullLabel = `${translate(`workItems.${label}`)}: ${name}`;
    const trigger = guestLongRow.getByRole("button", { name: fullLabel });
    await trigger.scrollIntoViewIfNeeded();
    const triggerBox = await trigger.boundingBox();
    const workItemBox = await guestLongRow.getByRole("rowheader").boundingBox();
    check(!!triggerBox && !!workItemBox, `read-only ${label} reveal trigger is missing`);
    const offsetToClearSticky = Math.max(0, workItemBox.x + workItemBox.width + 8 - triggerBox.x);
    if (offsetToClearSticky > 0) await touchScroll.evaluate((element, offset) => { element.scrollLeft = Math.max(0, element.scrollLeft - offset); }, offsetToClearSticky);
    await trigger.tap();
    await touchPage.getByRole("dialog", { name: fullLabel }).getByText(fullLabel, { exact: true }).waitFor();
    await touchPage.keyboard.press("Escape");
  }
  const guestKeyboardState = guestLongRow.getByRole("button", { name: `${translate("workItems.state")}: ${longStateName}` });
  await guestKeyboardState.focus();
  await touchPage.keyboard.press("Enter");
  await touchPage.getByRole("dialog", { name: `${translate("workItems.state")}: ${longStateName}` }).getByText(`${translate("workItems.state")}: ${longStateName}`, { exact: true }).waitFor();
  await touchPage.keyboard.press("Escape");
  // Named acceptance check: a Guest list reserves the same ID/title columns as an editable list despite having no checkbox.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(projectUrl);
  const writableRow = page.getByTestId(`row-${longItem.displayId}`);
  await writableRow.waitFor();
  const writableColumns = await writableRow.evaluate((row, displayId) => [row.querySelector(`span[title="${displayId}"]`)!.getBoundingClientRect().x, row.querySelector("a")!.getBoundingClientRect().x], longItem.displayId);
  await touchPage.setViewportSize({ width: 1440, height: 900 });
  await touchPage.goto(projectUrl);
  const readOnlyRow = touchPage.getByTestId(`row-${longItem.displayId}`);
  await readOnlyRow.waitFor();
  const readOnlyColumns = await readOnlyRow.evaluate((row, displayId) => [row.querySelector(`span[title="${displayId}"]`)!.getBoundingClientRect().x, row.querySelector("a")!.getBoundingClientRect().x], longItem.displayId);
  check(writableColumns.every((x, index) => Math.abs(x - readOnlyColumns[index]!) < 1), `read-only list columns shifted: ${writableColumns} vs ${readOnlyColumns}`);
  await touchContext.close();
  console.log("spreadsheet e2e passed");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
