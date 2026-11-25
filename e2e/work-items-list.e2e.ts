// Browser end-to-end flow for the work items list layout: groups, inline property dropdowns, display options, quick create.
// Run with `bun e2e/work-items-list.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Locator } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("05-work-items-list-layout");
const screenshotPhase = Bun.env.E2E_SCREENSHOT_PHASE === "before" ? "before" : "after";
const evidenceShots = Bun.env.E2E_SCREENSHOT_DIR ?? join(import.meta.dir, `../.local/shots/shadcn-06/${screenshotPhase}`);
const screenshotViewports = [
  { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 820, height: 1180 },
  { width: 768, height: 1024 }, { width: 844, height: 390 }, { width: 667, height: 375 }, { width: 390, height: 844 },
] as const;
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
  const assertStableBounds = async (control: Locator, name: string) => {
    const measure = async () => {
      const bounds = await control.boundingBox();
      if (!bounds) throw new Error(`${name} is not visible for its stability check`);
      return bounds;
    };
    const before = await measure();
    await control.hover();
    const hovered = await measure();
    await control.focus();
    const focused = await measure();
    const stable = (next: typeof before) => (["x", "y", "width", "height"] as const).every((key) => Math.abs(before[key] - next[key]) < 0.01);
    check(stable(hovered) && stable(focused), `${name} bounding box stays fixed on hover and focus (Stable${name}Bounds): ${JSON.stringify({ before, hovered, focused })}`);
  };
  const checkBoardSurface = async () => {
    const lane = page.locator('[data-testid^="column-"]').first();
    const colors = await lane.evaluate((element) => {
      const probe = document.createElement("div");
      probe.className = "bg-surface-1";
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const heading = element.querySelector<HTMLElement>("h4")!;
      const context = document.createElement("canvas").getContext("2d")!;
      const rgb = (value: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((channel) => { const v = channel / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); };
      const luminance = (value: string) => { const [r, g, b] = rgb(value); return .2126 * r! + .7152 * g! + .0722 * b!; };
      const background = getComputedStyle(element).backgroundColor;
      const foreground = getComputedStyle(heading).color;
      const [light, dark] = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
      return { background, expected, foreground, contrast: (light! + .05) / (dark! + .05), theme: document.documentElement.getAttribute("data-theme"), token: getComputedStyle(document.documentElement).getPropertyValue("--bg-surface-1"), classes: element.className };
    });
    check(colors.background === colors.expected, `board lane uses the active surface token: ${JSON.stringify(colors)}`);
    check(colors.contrast >= 4.5, `board lane title is readable against its surface: ${JSON.stringify(colors)}`);
  };
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
  await call("create_estimate", { projectId: project!.id, type: "points", values: ["1", "2"] });

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

  await assertStableBounds(page.getByRole("button", { name: translate("workItems.addNew"), exact: true }), "Button");
  await assertStableBounds(page.getByRole("searchbox", { name: translate("search.label") }), "Input");
  await assertStableBounds(page.getByTestId("row-MOB-1").getByRole("checkbox"), "Checkbox");
  await assertStableBounds(page.getByRole("button", { name: translate("layout.list") }), "Tabs");

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

  // Named acceptance checks for airy shadcn rows and their quiet property slots.
  const firstRow = page.getByTestId("row-MOB-1");
  const desktopRowMetrics = await page.locator('[data-testid^="row-"]').evaluateAll((rows) => rows.map((row) => {
    const rect = row.getBoundingClientRect();
    return { id: row.getAttribute("data-testid"), height: rect.height };
  }));
  check(desktopRowMetrics.length > 0 && desktopRowMetrics.every((row) => row.height <= 44), `1440px list rows stay within the 44px shadcn control size (TableRowsAtMost44px): ${JSON.stringify(desktopRowMetrics)}`);
  check(await page.getByTestId("list-column-header").count() === 0, "Linear Issues list has no header row (ListHasNoHeader)");
  for (const [property, label] of [["Estimate", translate("workItems.estimate")], ["Labels", translate("workItems.labels")], ["Cycle", translate("workItems.cycle")], ["Modules", translate("workItems.modules")], ["Dates", translate("layout.property.dates")], ["Assignees", translate("workItems.assignees")]] as const) {
    const trigger = firstRow.getByRole("button", { name: new RegExp(`^${label}:`) });
    if (await trigger.count() === 0) continue;
    const rightEdges = await Promise.all(["MOB-1", "MOB-2", "MOB-3"].map((id) => page.getByTestId(`row-${id}`).getByRole("button", { name: new RegExp(`^${label}:`) }).evaluate((element) => element.getBoundingClientRect().right)));
    check(Math.max(...rightEdges) - Math.min(...rightEdges) <= 1, `${property} chips share a right-aligned slot (List${property}RightAligned): ${rightEdges.join(", ")}`);
  }
  for (const property of ["state", "priority"] as const) {
    const control = firstRow.getByRole("button", { name: new RegExp(`^${translate(`workItems.${property}`)}:`) });
    check(await control.locator("svg").count() > 0, `${property} remains icon-only in the list (List${property}IconOnly)`);
    check(await control.evaluate((element) => getComputedStyle(element).borderTopWidth === "0px"), `${property} remains a quiet borderless list control`);
  }
  const emptyAssignee = firstRow.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) });
  check(await emptyAssignee.isVisible() && await emptyAssignee.locator("svg").count() > 0, "empty list properties keep an icon control in their reserved slot (ListEmptyPropertiesKeepSlot)");

  // Each inline dropdown changes the work item without a reload (a marker on window survives only without navigation).
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("cycle");
  await page.keyboard.press("Escape");
  const row = page.getByTestId("row-MOB-1");
  const emptyCycleTrigger = row.locator('button[aria-label^="Cycle:"]');
  await page.mouse.move(0, 0);
  check(await emptyCycleTrigger.isVisible(), "empty Cycle remains visible without hover (TableEmptyCellAlwaysVisible)");
  const cycleBeforeReveal = await emptyCycleTrigger.boundingBox();
  await row.screenshot({ path: `${shots}/popover-scroll-row-before.png` });
  await row.hover();
  const cycleAfterHover = await emptyCycleTrigger.boundingBox();
  check(Boolean(cycleBeforeReveal && cycleAfterHover) && Math.abs(cycleBeforeReveal!.x - cycleAfterHover!.x) < 1 && Math.abs(cycleBeforeReveal!.y - cycleAfterHover!.y) < 1, `hovering a row does not move its always-visible Cycle control (QuietRowHoverMovesNothing): ${JSON.stringify({ before: cycleBeforeReveal, after: cycleAfterHover })}`);
  await row.screenshot({ path: `${shots}/popover-scroll-row-after-hover.png` });
  await page.mouse.move(0, 0);
  await row.getByRole("link", { name: "Alpha" }).focus();
  await page.keyboard.press("Tab");
  check(await row.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).evaluate((element) => document.activeElement === element), "keyboard focus should move from the title to the next visible row control, Priority");
  const cycleAfterKeyboardFocus = await emptyCycleTrigger.boundingBox();
  check(Boolean(cycleAfterHover && cycleAfterKeyboardFocus) && Math.abs(cycleAfterHover!.x - cycleAfterKeyboardFocus!.x) < 1 && Math.abs(cycleAfterHover!.y - cycleAfterKeyboardFocus!.y) < 1, "keyboard focus keeps row controls in stable positions");
  await emptyCycleTrigger.focus();
  await page.keyboard.press("Enter");
  const keyboardCycleMenu = page.locator("[data-popover-panel]");
  await keyboardCycleMenu.waitFor();
  await page.waitForFunction(() => {
    const panel = document.querySelector<HTMLElement>("[data-popover-panel]");
    return Boolean(panel?.contains(document.activeElement));
  });
  await page.mouse.move(0, 0);
  check(await emptyCycleTrigger.getAttribute("aria-expanded") === "true", "keyboard should open the empty Cycle picker");
  await page.screenshot({ path: `${shots}/popover-scroll-keyboard-open.png` });
  await page.keyboard.press("Escape");
  await keyboardCycleMenu.waitFor({ state: "detached" });
  check(await emptyCycleTrigger.evaluate((element) => document.activeElement === element), "Escape should return focus to the keyboard-open Cycle trigger");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("state");
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.state")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "In Progress" }).click();
  await page.getByRole("region", { name: "In Progress" }).getByRole("link", { name: "Alpha" }).waitFor();

  await row.hover();
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).click();
  await page.getByRole("menuitemradio", { name: translate("workItems.priority.urgent") }).click();
  await row.getByRole("button", { name: `${translate("workItems.priority")}: ${translate("workItems.priority.urgent")}` }).waitFor();

  await row.hover();
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Lists Tester" }).click();
  await row.getByRole("button", { name: `${translate("workItems.assignees")}: Lists Tester` }).waitFor();
  await page.keyboard.press("Escape");

  await row.hover();
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Bug" }).click();
  await row.getByRole("button", { name: `${translate("workItems.labels")}: Bug` }).waitFor();
  await page.keyboard.press("Escape");

  await row.hover();
  await row.getByRole("button", { name: new RegExp(`^${translate("layout.property.dates")}:`) }).click();
  const calendar = page.locator("[data-popover-panel]");
  await calendar.getByRole("button", { name: new RegExp(`^${translate("workItems.dueDate")}`) }).click();
  for (let turn = 0; turn < 3 && await calendar.locator(`[data-date="${day(3)}"]`).count() === 0; turn += 1) await calendar.getByRole("button", { name: translate("datePicker.nextMonth") }).click();
  await calendar.locator(`[data-date="${day(3)}"]`).click();
  const shortDue = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day(3)}T00:00:00Z`));
  await row.getByRole("button", { name: `${translate("layout.property.dates")}: ${shortDue}` }).waitFor();
  await page.keyboard.press("Escape");

  await row.hover();
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.cycle")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "Sprint 1" }).click();
  await row.getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 1` }).waitFor();

  await row.hover();
  await row.getByRole("button", { name: new RegExp(`^${translate("workItems.modules")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Auth" }).click();
  await row.getByRole("button", { name: `${translate("workItems.modules")}: Auth` }).waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);

  // A wider seed exercises responsive rows with varied values and enough data to expose ragged heights.
  for (const name of ["Security", "Docs", "Frontend"]) await call("create_label", { projectId: project!.id, name });
  for (const name of ["API", "UI", "Core"]) await call("create_module", { projectId: project!.id, name });
  const labels = await call<Array<{ id: string; name: string }>>("list_labels", { projectId: project!.id });
  const cycles = await call<Array<{ id: string; name: string }>>("list_cycles", { projectId: project!.id });
  const modules = await call<Array<{ id: string; name: string }>>("list_modules", { projectId: project!.id });
  const states = await call<Array<{ id: string; name: string }>>("list_states", { projectId: project!.id });
  const variedIds: string[] = [];
  for (let index = 0; index < 28; index += 1) {
    const longTitle = `A deliberately long work item title that exceeds eighty characters to exercise narrow responsive rows number ${index + 1}`;
    const item = await call<{ id: string }>("create_work_item", {
      projectId: project!.id, title: longTitle,
      stateId: states[index % states.length]!.id,
      priority: (["urgent", "high", "medium", "low", "none"] as const)[index % 5],
      assigneeIds: index % 3 === 0 ? [me.user.id] : [],
      labelIds: index % 7 === 0 ? labels.map((label) => label.id) : index % 2 === 0 ? [labels[index % labels.length]!.id] : [],
      ...(index % 4 === 0 ? { startDate: day(-5), dueDate: day(-1) } : index % 4 === 1 ? { dueDate: day(4) } : {}),
    });
    variedIds.push(item.id);
  }
  const sprintOne = cycles.find((cycle) => cycle.name === "Sprint 1")!;
  await call("add_cycle_items", { cycleId: sprintOne.id, workItemIds: variedIds.slice(0, 14) });
  for (const [index, module] of modules.entries()) await call("add_module_items", { moduleId: module.id, workItemIds: variedIds.slice(index * 6, index * 6 + 8) });
  check(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true), "the page reloaded before seeding responsive rows");
  await page.reload();
  const todoState = states.find((state) => state.name === "Todo")!;
  const longThaiTitle = "ทดสอบชื่อรายการภาษาไทยที่ยาวพอเพื่อยืนยันว่าข้อความไม่ล้น ไม่ตัดคำ และไม่ทำให้ปุ่มหรือแถวเปลี่ยนตำแหน่ง";
  await call("create_work_item", { projectId: project!.id, stateId: todoState.id, title: longThaiTitle, priority: "none" });
  await page.reload();
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
  await page.getByTestId("row-MOB-1").waitFor();
  await page.mouse.move(0, 0);
  await mkdir(evidenceShots, { recursive: true });
  for (const { width, height } of screenshotViewports) {
    await page.setViewportSize({ width, height });
    const columnHeader = page.getByTestId("list-column-header");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px list has no horizontal page scroll (ListNoHorizontalScrollAt${width})`);
    check(await columnHeader.count() === 0, `${width}px Linear Issues list has no header row (ListNoHeaderAt${width})`);
    if (width >= 768) {
      const heights = await page.locator('[data-testid^="row-"]').evaluateAll((rows) => rows.map((item) => item.getBoundingClientRect().height));
      check(heights.length > 0 && heights.every((height) => height <= 44), `${width}px list rows stay within the 44px shadcn control size (ListRowsAtMost44pxAt${width}): ${JSON.stringify(heights)}`);
      check(Math.max(...heights) - Math.min(...heights) <= 1, `${width}px list rows have equal heights (ListRowsEqualHeightAt${width}): ${JSON.stringify(heights)}`);
      check(await page.getByTestId("list-property-wrap").count() === 0, `${width}px keeps the property block on the title row (ListNoPropertyWrapAt${width})`);
    }
    if (width === 390) {
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "390px list has no horizontal page scroll (ListNoHorizontalScroll390)");
      const phoneHeights = await page.locator('[data-testid^="row-"]').evaluateAll((rows) => rows.map((item) => item.getBoundingClientRect().height));
      check(phoneHeights.length > 0 && phoneHeights.every((height) => height < 100), `390px list keeps rows below 100px (ListPhoneRowsBelow100px): ${JSON.stringify(phoneHeights)}`);
      const titleWidth = await firstRow.getByRole("link", { name: "Alpha" }).evaluate((element) => element.getBoundingClientRect().width);
      check(titleWidth >= 140, `390px list title gets at least 140px (ListPhoneTitleWidth140): ${titleWidth}`);
      check(await firstRow.locator("[data-testid=list-property-wrap]").count() === 0, "390px list omits the empty property row (ListNoEmptySecondLine)");
      const denseRowMetadata = page.getByTestId("row-MOB-4").locator(":scope > div > div").nth(1);
      check(await denseRowMetadata.evaluate((element) => element.scrollWidth > element.clientWidth), "390px list keeps the populated property chips in one horizontally scrollable metadata line (ListPhonePropertiesSingleLine)");
      for (const property of ["priority", "state"] as const) {
        const control = firstRow.getByRole("button", { name: new RegExp(`^${translate(`workItems.${property}`)}:`) });
        const visibleLabel = await control.evaluate((element) => element.innerText.trim() !== "");
        check(!visibleLabel, `390px list ${property} control shows only its icon (ListPhone${property}IconOnly)`);
      }
    }
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await mkdir(evidenceShots, { recursive: true });
      await page.screenshot({ path: `${evidenceShots}/work-items-list-${width}-${theme}.png`, fullPage: true });
    }
  }
  for (const group of ["state", "priority", "assignee", "none"] as const) {
    await page.getByRole("button", { name: translate("layout.display") }).click();
    await page.getByLabel(translate("layout.group")).selectOption(group);
    await page.keyboard.press("Escape");
    await page.getByTestId("row-MOB-1").waitFor();
    for (const [width, height] of [[1920, 900], [1440, 900], [1100, 900], [768, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        const metrics = await page.locator('[data-testid^="row-"]').evaluateAll((rows) => rows.map((element) => {
          const row = element.getBoundingClientRect();
          return { height: row.height, titleWidth: element.querySelector("a")?.getBoundingClientRect().width ?? 0 };
        }));
        if (width >= 768) check(metrics.length > 0 && metrics.every((row) => row.height <= 44) && Math.max(...metrics.map((row) => row.height)) - Math.min(...metrics.map((row) => row.height)) <= 1, `${group} grouping keeps equal rows at ${width}px within the 44px shadcn control size: ${JSON.stringify(metrics)}`);
        if (width === 390) check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) && (metrics[0]?.titleWidth ?? 0) >= 140, `${group} grouping keeps a readable 390px title without horizontal page scroll: ${JSON.stringify(metrics[0])}`);
        await page.screenshot({ path: `${evidenceShots}/list-${group}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("priority");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  const defaultAuthChip = page.getByTestId("row-MOB-1").getByRole("button", { name: `${translate("workItems.modules")}: Auth` });
  const authDefaultRing = await defaultAuthChip.evaluate((element) => ({ outline: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth, focusVisible: element.matches(":focus-visible") }));
  check(!authDefaultRing.focusVisible && (authDefaultRing.outline === "none" || authDefaultRing.width === "0px"), `Auth row chip has no blue box by default: ${JSON.stringify(authDefaultRing)}`);
  await page.screenshot({ path: `${shots}/list-1440-light.png` });
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
  await page.screenshot({ path: `${shots}/popover-scroll-desktop-open.png` });
  const [triggerBounds, mainBounds] = await Promise.all([cycleTrigger.boundingBox(), main.boundingBox()]);
  check(Boolean(triggerBounds && mainBounds), "Cycle trigger and main scroll container remain visible before scrolling");
  const anchorInset = triggerBounds!.y - mainBounds!.y;
  await main.evaluate((element, amount) => { element.scrollTop += amount; }, Math.max(1, Math.min(40, anchorInset - 4)));
  await page.waitForTimeout(100);
  const cyclePopoverPosition = await page.evaluate(() => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="row-MOB-1"] button[aria-label^="Cycle:"]');
    const menu = document.querySelector<HTMLElement>("[data-popover-panel]");
    if (!trigger || !menu) return null;
    const anchor = trigger.getBoundingClientRect();
    const panel = menu.getBoundingClientRect();
    const overlapsHorizontally = panel.left < anchor.right && panel.right > anchor.left;
    return { anchor: { top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right }, panel: { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right }, overlapsHorizontally, verticalGap: Math.min(Math.abs(panel.top - anchor.bottom - 4), Math.abs(anchor.top - panel.bottom - 4)) };
  });
  check(Boolean(cyclePopoverPosition && cyclePopoverPosition.overlapsHorizontally && cyclePopoverPosition.verticalGap < 1), `Cycle picker should remain anchored to its visible trigger while scrolling (CycleAnchorStaysAligned): ${JSON.stringify(cyclePopoverPosition)}`);
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
  await main.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await cycleMenu.waitFor({ state: "detached" });
  check(await main.evaluate((element) => element.scrollTop > 0), "dismissing an offscreen picker should not scroll its trigger back into view");
  await main.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: `${shots}/list-1440-edited.png` });

  // The edits are real: the Actions stored them (reload and read back through the API).
  await page.reload();
  const stored = await call<{ priority: string; assigneeIds: string[]; labelIds: string[]; dueDate: string | null; stateId: string }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: "MOB-1" });
  check(stored.priority === "urgent" && stored.assigneeIds.length === 1 && stored.labelIds.length === 1 && stored.dueDate === day(3), "an inline edit was not stored");
  const selectedCycle = (await call<Array<{ id: string; name: string }>>("list_cycles", { projectId: project!.id })).find((cycle) => cycle.name === "Sprint 17");
  const inCycle = await call<Array<{ displayId: string }>>("list_work_items", { projectId: project!.id, cycleId: selectedCycle!.id });
  check(inCycle.map((item) => item.displayId).join() === "MOB-1", "the Cycle dropdown did not store");
  await page.getByTestId("row-MOB-1").getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 17` }).waitFor();

  // Display options: hiding a property removes it from the rows and persists in the URL.
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByRole("checkbox", { name: translate("layout.property.labels"), exact: true }).click();
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
  const labelsProperty = page.getByRole("checkbox", { name: translate("layout.property.labels"), exact: true });
  if (await labelsProperty.getAttribute("aria-checked") !== "true") await labelsProperty.click();
  const cycleProperty = page.getByRole("checkbox", { name: translate("layout.property.cycle"), exact: true });
  if (await cycleProperty.getAttribute("aria-checked") !== "true") await cycleProperty.click();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileListUrl = page.url();
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(mobileListUrl);
  const mobileRow = mobilePage.getByTestId("row-MOB-1");
  await mobileRow.getByRole("link", { name: "Alpha" }).waitFor();
  await mobileRow.getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 17` }).waitFor();
  const mobileRowLines = await mobileRow.evaluate((row) => {
    const titleLink = row.querySelector("a");
    const cycleControl = row.querySelector<HTMLButtonElement>('button[aria-label^="Cycle:"]');
    if (!titleLink || !cycleControl) return null;
    const title = titleLink.getBoundingClientRect();
    const cycle = cycleControl.getBoundingClientRect();
    return { titleY: title.y, titleBottom: title.bottom, rightY: cycle.y, viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth };
  });
  check(Boolean(mobileRowLines && mobileRowLines.rightY > mobileRowLines.titleBottom - 1 && mobileRowLines.page <= mobileRowLines.viewport), `390 px title and properties use separate compact lines without horizontal page scroll: ${JSON.stringify(mobileRowLines)}`);
  const mobileCycleTrigger = mobilePage.getByTestId("row-MOB-1").getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 17` });
  await mobileCycleTrigger.click();
  const mobileCycleMenu = mobilePage.locator("[data-popover-panel]");
  await mobileCycleMenu.getByRole("menuitemradio", { name: "Sprint 17" }).waitFor();
  const mobileMenuBounds = await mobileCycleMenu.boundingBox();
  check(Boolean(mobileMenuBounds && mobileMenuBounds.x >= 0 && mobileMenuBounds.x + mobileMenuBounds.width <= 390), "Cycle picker should stay within the phone viewport");
  await mobilePage.screenshot({ path: `${shots}/popover-scroll-mobile-open.png` });
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
  const boardPriority = phoneCard.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) });
  check(await boardPriority.evaluate((element) => getComputedStyle(element).borderTopWidth === "1px"), "board card Priority chip retains its outlined border (BoardCardOutlinedChipStillBordered)");
  await page.screenshot({ path: `${shots}/board-390-light.png` });
  await page.getByRole("button", { name: translate("layout.addToGroup").replace("{group}", translate("workItems.priority.none")) }).getByText(translate("layout.addShort")).waitFor();
  await page.getByRole("button", { name: translate("layout.gantt") }).click();
  await page.getByTestId("gantt-layout").waitFor();
  await page.getByText(translate("layout.gantt.scrollHint"), { exact: true }).waitFor();
  await page.getByTestId("gantt-bar-MOB-1").waitFor();
  check(await page.getByTestId("row-MOB-1").count() === 0, "phone Gantt silently falls back to the grouped list");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "phone Gantt scrolls the whole page sideways instead of its timeline");
  const dueEdge = page.getByRole("button", { name: `${translate("layout.gantt.resizeDue")} MOB-1`, exact: true });
  await dueEdge.focus();
  const keyboardResize = page.waitForResponse((response) => response.url().includes("update_work_item") && response.ok() && (response.request().postData() ?? "").includes("dueDate"));
  await page.keyboard.press("ArrowRight");
  await keyboardResize;
  const resizedItem = await call<{ dueDate: string | null }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: "MOB-1" });
  check(resizedItem.dueDate === day(4), "keyboard resizing the Gantt due date did not save one day later");
  for (const layout of ["board", "spreadsheet", "calendar", "gantt"] as const) {
    await page.getByRole("button", { name: translate(`layout.${layout}`) }).click();
    const surface = layout === "board" ? page.getByTestId("board") : layout === "spreadsheet" ? page.getByTestId("sheet-scroll") : page.getByTestId(`${layout}-layout`);
    await surface.waitFor();
    if (layout === "board") {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      const authChip = page.getByTestId("card-MOB-1").getByRole("button", { name: `${translate("workItems.modules")}: Auth` });
      await authChip.waitFor();
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      const defaultOutline = await authChip.evaluate((element) => ({ width: getComputedStyle(element).outlineWidth, style: getComputedStyle(element).outlineStyle, visible: element.matches(":focus-visible") }));
      check(!defaultOutline.visible && (defaultOutline.style === "none" || defaultOutline.width === "0px"), `Auth chip has no default blue focus box: ${JSON.stringify(defaultOutline)}`);
      let keyboardFocused = false;
      for (let attempt = 0; attempt < 100 && !keyboardFocused; attempt += 1) {
        await page.keyboard.press("Tab");
        keyboardFocused = await authChip.evaluate((element) => document.activeElement === element);
      }
      check(keyboardFocused, "Auth chip is reachable by keyboard (BoardAuthKeyboardReachable)");
      const keyboardOutline = await authChip.evaluate((element) => ({ width: getComputedStyle(element).outlineWidth, style: getComputedStyle(element).outlineStyle, visible: element.matches(":focus-visible") }));
      check(keyboardOutline.visible && keyboardOutline.width === "2px", `Auth blue box is the 2px keyboard focus ring: ${JSON.stringify(keyboardOutline)}`);
      await page.screenshot({ path: `${evidenceShots}/board-auth-keyboard-focus-dark-1440.png`, fullPage: true });
      await authChip.evaluate((element) => element.blur());
    }
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        if (layout === "board") await checkBoardSurface();
        await page.screenshot({ path: `${evidenceShots}/${layout}-${theme}-${width}.png`, fullPage: true });
      }
    }
    if (layout === "board") {
      for (const grouping of ["state", "priority", "assignee", "label", "cycle", "module", "creator", "dueDate"] as const) {
        await page.getByRole("button", { name: translate("layout.display") }).click();
        await page.getByLabel(translate("layout.group")).selectOption(grouping);
        await page.keyboard.press("Escape");
        await page.getByTestId("board").waitFor();
        for (const [width, height] of [[1440, 900], [390, 844]] as const) {
          await page.setViewportSize({ width, height });
          for (const theme of ["light", "dark"] as const) {
            await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
            await checkBoardSurface();
            await page.screenshot({ path: `${evidenceShots}/board-${grouping}-${theme}-${width}.png`, fullPage: true });
          }
        }
      }
    }
  }
  await page.getByRole("button", { name: translate("layout.list") }).click();
  for (const [name, label] of [["filters", translate("layout.filters")], ["query", translate("layout.filterQuery.toggle")], ["display", translate("layout.display")]] as const) {
    const control = page.getByRole("button", { name: label });
    await control.click();
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await page.screenshot({ path: `${evidenceShots}/${name}-${theme}-${width}.png`, fullPage: true });
      }
    }
    await control.click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: translate("cycles.title"), exact: true }).click();
  await assertStableBounds(page.getByRole("tab", { name: new RegExp(translate("cycles.status.active")) }), "Tabs");
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
