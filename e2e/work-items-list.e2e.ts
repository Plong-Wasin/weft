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
  // The value an empty property control shows after "<Property>: " in its accessible name (a dash, or the "No …" word of that property).
  const emptyValues = ["—", translate("workItems.priority.none"), translate("workItems.noCycle"), translate("workItems.noDates"), translate("workItems.noModules"), translate("workItems.noAssignee"), translate("workItems.noEstimate")];
  /**
   * Measures list rows from what is painted, independent of the data attributes the app sets:
   * - emptyPainted: painted controls whose accessible name says the value is empty (any property, including Priority);
   * - outside / glyphOverflow: controls, property cells and text glyphs (after ancestor clipping) that leave the row box;
   * - siblingOverlaps: rows whose boxes overlap the next row;
   * - signature: the set properties (by accessible name) plus chip and title line counts, so rows with the same data group together.
   */
  const measureRows = (rows: Element[], empties: string[]) => {
    const shown = (element: Element) => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      }
      return element.getClientRects().length > 0;
    };
    const inside = (inner: { left: number; right: number; top: number; bottom: number }, outer: DOMRect) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
    const measured = rows.map((row) => {
      const rowBox = row.getBoundingClientRect();
      const controls = [...row.querySelectorAll<HTMLElement>("button[aria-label]")].filter(shown);
      const valueOf = (control: HTMLElement) => (control.getAttribute("aria-label") ?? "").split(": ").slice(1).join(": ").trim();
      const emptyPainted = controls.filter((control) => empties.includes(valueOf(control))).map((control) => control.getAttribute("aria-label"));
      const setProperties = controls.filter((control) => !empties.includes(valueOf(control))).map((control) => (control.getAttribute("aria-label") ?? "").split(":")[0]).sort();
      const outside = [...row.querySelectorAll<HTMLElement>("[data-phone-property], [data-list-property], button, a[href]")].filter(shown)
        .filter((element) => !inside(element.getBoundingClientRect(), rowBox)).map((element) => element.getAttribute("aria-label") ?? element.tagName);
      const glyphOverflow: string[] = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim() || !node.parentElement || !shown(node.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
          for (let parent = node.parentElement; parent && parent !== row; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            const clip = parent.getBoundingClientRect();
            if (style.overflowX !== "visible") { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
            if (style.overflowY !== "visible") { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
          }
          if (right > left && bottom > top && !inside({ left, right, top, bottom }, rowBox)) glyphOverflow.push(node.textContent.trim());
        }
      }
      const cells = [...row.querySelectorAll<HTMLElement>("[data-phone-property], [data-list-property]")].filter(shown);
      // Cells of different heights centred on one visual line share that line: a new line starts only below the previous one.
      let chipLines = 0, lineBottom = -Infinity;
      for (const rect of cells.map((cell) => cell.getBoundingClientRect()).sort((a, b) => a.top - b.top)) {
        if (rect.top >= lineBottom - 0.5) chipLines += 1;
        lineBottom = Math.max(lineBottom, rect.bottom);
      }
      const phoneChips = [...row.querySelectorAll<HTMLElement>("[data-phone-property]")].filter(shown).length;
      const title = row.querySelector<HTMLElement>("a[href]");
      const titleLines = title ? (() => { const range = document.createRange(); range.selectNodeContents(title); return new Set([...range.getClientRects()].filter((rect) => rect.height > 0).map((rect) => Math.round(rect.top))).size; })() : 0;
      return { id: (row as HTMLElement).dataset.testid, top: rowBox.top, bottom: rowBox.bottom, height: rowBox.height, chipLines, phoneChips, emptyPainted, outside, glyphOverflow, signature: `${setProperties.join(",")}|chips:${chipLines}|title:${titleLines}` };
    });
    const ordered = measured.slice().sort((a, b) => a.top - b.top);
    const heights = new Map<string, number[]>();
    for (const row of measured) heights.set(row.signature, [...heights.get(row.signature) ?? [], row.height]);
    return {
      rows: measured,
      siblingOverlaps: ordered.slice(1).flatMap((row, index) => ordered[index]!.bottom <= row.top + 0.5 ? [] : [{ previous: ordered[index]!.id, current: row.id }]),
      unequalHeights: [...heights].filter(([, list]) => Math.max(...list) - Math.min(...list) > 1).map(([signature, list]) => ({ signature, list })),
    };
  };
  /** Real hit testing of a 44px touch target: the 4 corners and 4 edge midpoints, 1px inside a 44x44 square centred on the control, must resolve to the control or a descendant. */
  const missedHitPoints = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2, reach = 21;
    const points = [[-reach, -reach], [0, -reach], [reach, -reach], [reach, 0], [reach, reach], [0, reach], [-reach, reach], [-reach, 0]] as const;
    return points.flatMap(([dx, dy]) => {
      const hit = document.elementFromPoint(cx + dx, cy + dy);
      return hit && (hit === element || element.contains(hit)) ? [] : [{ dx, dy, hit: hit ? `${hit.tagName}${hit.getAttribute("aria-label") ? `[${hit.getAttribute("aria-label")}]` : ""}.${String(hit.className).slice(0, 40)}` : null }];
    });
  };
  const checkBoardSurface = async () => {
    const lane = page.locator('[data-testid^="column-"]').first();
    const colors = await lane.evaluate((element) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--card)";
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
      return { background, expected, foreground, contrast: (light! + .05) / (dark! + .05), theme: document.documentElement.getAttribute("data-theme"), token: getComputedStyle(document.documentElement).getPropertyValue("--card"), classes: element.className };
    });
    check(colors.background === colors.expected, `board lane uses the active shadcn card token: ${JSON.stringify(colors)}`);
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
      const seededRow = page.getByTestId("row-MOB-5");
      await seededRow.getByRole("button", { name: `${translate("workItems.modules")}: Auth`, exact: true }).waitFor();
      await seededRow.getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 1`, exact: true }).waitFor();
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "390px list has no horizontal page scroll (ListNoHorizontalScroll390)");
      const phoneHeights = await page.locator('[data-testid^="row-"]').evaluateAll((rows) => rows.map((item) => item.getBoundingClientRect().height));
      // These seeded rows need two metadata lines at 390px. They measure 121px, with 1px allowed for rounding.
      // Every other row keeps the single-line budget, even if its metadata wraps by mistake.
      const twoLineRows = new Set([
        "row-MOB-1", "row-MOB-4", "row-MOB-5", "row-MOB-6", "row-MOB-8", "row-MOB-9",
        "row-MOB-10", "row-MOB-11", "row-MOB-12", "row-MOB-13", "row-MOB-14", "row-MOB-16",
        "row-MOB-17", "row-MOB-20", "row-MOB-24", "row-MOB-25", "row-MOB-28",
      ]);
      const assertPhoneRows = async () => {
        const geometry = await page.locator('[data-testid^="row-"]').evaluateAll(measureRows, emptyValues);
        const overBudget = geometry.rows.filter((row) => twoLineRows.has(row.id ?? "")
          ? row.chipLines > 2 || row.height > 122
          : row.chipLines > 1 || row.height >= 100);
        const escaped = geometry.rows.filter((row) => row.outside.length || row.glyphOverflow.length);
        // A row with no chips holds a title line and an ID line only: no chip line is reserved.
        const chipless = geometry.rows.filter((row) => row.phoneChips === 0);
        const reserved = chipless.filter((row) => row.height > 90);
        return { geometry, overBudget, escaped, chipless, reserved, ok: phoneHeights.length > 0 && overBudget.length === 0 && escaped.length === 0 && geometry.siblingOverlaps.length === 0 && geometry.unequalHeights.length === 0 };
      };
      const phoneRows = await assertPhoneRows();
      check(phoneRows.geometry.rows.filter((row) => twoLineRows.has(row.id ?? "")).length === twoLineRows.size, "390px list renders every seeded dense row for the height check");
      check(phoneRows.ok, `390px list rows are contained, compact and equal for equal data (ListPhoneRowsContained): ${JSON.stringify({ heights: phoneHeights, overBudget: phoneRows.overBudget, escaped: phoneRows.escaped, siblingOverlaps: phoneRows.geometry.siblingOverlaps, unequalHeights: phoneRows.geometry.unequalHeights })}`);
      check(phoneRows.chipless.length > 0 && phoneRows.reserved.length === 0, `390px rows without chips reserve no chip line (ListPhoneChiplessRowCompact): ${JSON.stringify(phoneRows.chipless.map((row) => ({ id: row.id, height: row.height })))}`);
      // Self-test: a chip forced wider than its row must make the same measure fail, so the assertion cannot pass vacuously.
      await page.addStyleTag({ content: '[data-testid="row-MOB-1"] [data-phone-property], [data-testid="row-MOB-1"] [data-phone-property] button { max-width: none !important; width: 640px !important; flex: none !important; }' }).then((tag) => tag.evaluate((element) => element.setAttribute("data-e2e-overflow-probe", "")));
      const forcedOverflow = await assertPhoneRows();
      await page.evaluate(() => document.querySelector("[data-e2e-overflow-probe]")?.remove());
      check(!forcedOverflow.ok && forcedOverflow.escaped.some((row) => row.id === "row-MOB-1"), `ListPhoneRowsContained detects a chip that overflows its row: ${JSON.stringify(forcedOverflow.escaped.map((row) => ({ id: row.id, outside: row.outside })))}`);
      const titleWidth = await firstRow.getByRole("link", { name: "Alpha" }).evaluate((element) => element.getBoundingClientRect().width);
      check(titleWidth >= 140, `390px list title gets at least 140px (ListPhoneTitleWidth140): ${titleWidth}`);
      check(await firstRow.locator("[data-testid=list-property-wrap]").count() === 0, "390px list omits the empty property row (ListNoEmptySecondLine)");
      const denseRowMetadata = page.getByTestId("row-MOB-4").locator(":scope > div > div").nth(1);
      check(await denseRowMetadata.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "390px list wraps or truncates populated property chips inside the row (ListPhonePropertiesFitInsideRow)");
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
  await mobilePage.getByTestId("row-MOB-1").waitFor();
  const mobileListMetrics = await mobilePage.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="work-items-list-container"]');
    const rows = [...(list?.querySelectorAll<HTMLElement>("[data-list-row]") ?? [])];
    const metadata = rows.map((row) => row.querySelector<HTMLElement>('[data-testid="work-item-row-metadata"]'));
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      listRight: list?.getBoundingClientRect().right ?? null,
      listClientWidth: list?.clientWidth ?? null,
      listScrollWidth: list?.scrollWidth ?? null,
      rowsOverflow: rows.map((row) => row.scrollWidth > row.clientWidth + 1),
      metadataOverflow: metadata.map((item) => item ? item.scrollWidth > item.clientWidth + 1 : true),
    };
  });
  check(mobileListMetrics.documentWidth <= mobileListMetrics.viewportWidth, `390px phone list keeps the document within the viewport: ${JSON.stringify(mobileListMetrics)}`);
  check(mobileListMetrics.listRight !== null && mobileListMetrics.listRight <= mobileListMetrics.viewportWidth && mobileListMetrics.listScrollWidth !== null && mobileListMetrics.listClientWidth !== null && mobileListMetrics.listScrollWidth <= mobileListMetrics.listClientWidth + 1 && mobileListMetrics.rowsOverflow.every((overflow) => !overflow) && mobileListMetrics.metadataOverflow.every((overflow) => !overflow), `390px work item rows and property chips fit inside the list card: ${JSON.stringify(mobileListMetrics)}`);
  const mobileRow = mobilePage.getByTestId("row-MOB-1");
  await mobileRow.getByRole("link", { name: "Alpha" }).waitFor();
  const rowCheckbox = mobileRow.getByRole("checkbox");
  const checkboxMetrics = await Promise.all([rowCheckbox].map(async (checkbox) => {
    const box = await checkbox.boundingBox();
    return box ? { width: box.width, height: box.height } : null;
  }));
  check(checkboxMetrics.every((box) => !!box && box.width <= 24 && box.height <= 24), `390px touch checkboxes stay visually at or below 24px: ${JSON.stringify(checkboxMetrics)}`);
  const checkboxHitTargets = await Promise.all([rowCheckbox].map((checkbox) => checkbox.evaluate((element) => {
    const before = getComputedStyle(element, "::before");
    return { width: parseFloat(before.width), height: parseFloat(before.height) };
  })));
  check(checkboxHitTargets.every((box) => box.width >= 44 && box.height >= 44), `390px touch checkboxes retain 44px invisible hit areas: ${JSON.stringify(checkboxHitTargets)}`);
  const cycleChip = mobileRow.getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 17` });
  const cycleChipMetrics = await cycleChip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = getComputedStyle(element, "::before");
    return { width: rect.width, height: rect.height, targetWidth: parseFloat(target.width), targetHeight: parseFloat(target.height) };
  });
  check(cycleChipMetrics.height <= 36 && cycleChipMetrics.targetWidth >= 44 && cycleChipMetrics.targetHeight >= 44, `390px property chips stay visually compact with 44px touch targets: ${JSON.stringify(cycleChipMetrics)}`);
  for (const [name, control] of [["Cycle chip", cycleChip], ["State chip", mobileRow.getByRole("button", { name: /^State:/ })], ["row checkbox", rowCheckbox]] as const) {
    await control.scrollIntoViewIfNeeded();
    const misses = await control.evaluate(missedHitPoints);
    check(misses.length === 0, `390px ${name} answers taps across its whole 44px area (TouchHitArea44): ${JSON.stringify(misses)}`);
  }
  const rowTitleBox = await mobileRow.getByRole("link", { name: "Alpha" }).boundingBox();
  const rowCheckboxBox = await rowCheckbox.boundingBox();
  check(!!rowTitleBox && !!rowCheckboxBox && (rowTitleBox.x >= rowCheckboxBox.x + rowCheckboxBox.width || rowTitleBox.y >= rowCheckboxBox.y + rowCheckboxBox.height || rowTitleBox.x + rowTitleBox.width <= rowCheckboxBox.x || rowTitleBox.y + rowTitleBox.height <= rowCheckboxBox.y), `390px title does not overlap its checkbox: ${JSON.stringify({ title: rowTitleBox, checkbox: rowCheckboxBox })}`);
  // A hit area must not take taps from its neighbours: the title's left edge opens the item, not the row checkbox.
  const titleEdge = await mobileRow.getByRole("link", { name: "Alpha" }).evaluate((link) => {
    link.scrollIntoView({ block: "center" });
    const rect = link.getBoundingClientRect();
    return [1, rect.height / 2, rect.height - 1].map((dy) => { const hit = document.elementFromPoint(rect.left + 0.5, rect.top + dy); return hit === link ? "title" : hit?.getAttribute("aria-label") ?? hit?.tagName ?? null; });
  });
  check(titleEdge.every((hit) => hit === "title"), `390px title left edge answers as the title (TouchTitleEdgeNotStolen): ${JSON.stringify(titleEdge)}`);
  const toolbar = mobilePage.getByTestId("work-items-toolbar");
  const mobileView = toolbar.getByRole("combobox", { name: translate("layout.switch") });
  const mobileMore = toolbar.getByRole("button", { name: translate("workItems.moreActions") });
  const addWorkItem = mobilePage.getByRole("button", { name: translate("workItems.addNew"), exact: true });
  const [addBox, toolbarBox] = await Promise.all([addWorkItem.boundingBox(), toolbar.boundingBox()]);
  check(!!addBox && !!toolbarBox && addBox.y > toolbarBox.y + toolbarBox.height, "390px Add work item floats below the toolbar");
  await mobileMore.tap();
  const mobileSelectShown = mobilePage.getByRole("menuitemcheckbox", { name: translate("bulk.selectShown") });
  const selectShownBox = await mobileSelectShown.boundingBox();
  check(!!selectShownBox && selectShownBox.width >= 44 && selectShownBox.height >= 44, "390px Select shown has a full touch target in the overflow menu");
  await mobilePage.getByRole("menuitem", { name: translate("views.saveAs") }).tap();
  const saveViewDialog = mobilePage.getByRole("dialog", { name: translate("views.form.saveTitle") });
  await saveViewDialog.waitFor();
  const saveViewDialogBox = await saveViewDialog.boundingBox();
  check(!!saveViewDialogBox && saveViewDialogBox.x >= 0 && saveViewDialogBox.x + saveViewDialogBox.width <= 390, `390px Save as view form opens inside the viewport (PhoneSaveViewOpens): ${JSON.stringify(saveViewDialogBox)}`);
  await mobilePage.keyboard.press("Escape");
  await saveViewDialog.waitFor({ state: "hidden" });
  const filterButton = toolbar.getByRole("button", { name: translate("layout.filters"), exact: true });
  const displayButton = toolbar.getByRole("button", { name: translate("layout.display") });
  // Stacked checkboxes (Display > properties): each answers across its own label row, and the midpoint between two belongs to neither neighbour's overlay.
  await displayButton.tap();
  const displayFields = mobilePage.getByRole("dialog", { name: translate("layout.display") }).locator("fieldset");
  await displayFields.waitFor();
  const stack = await displayFields.evaluate((fieldset) => {
    const boxes = [...fieldset.querySelectorAll<HTMLElement>('[role="checkbox"]')];
    const labelOf = (box: Element) => box.closest("label")!;
    const stolen: unknown[] = [];
    boxes.slice(0, -1).forEach((upper, index) => {
      const lower = boxes[index + 1]!;
      upper.scrollIntoView({ block: "center" });
      const a = upper.getBoundingClientRect(), b = lower.getBoundingClientRect();
      const x = a.left + a.width / 2, labelA = labelOf(upper).getBoundingClientRect();
      const midpoint = (a.top + a.height / 2 + b.top + b.height / 2) / 2;
      for (const [name, y, owners] of [["midpoint", midpoint, [upper, lower]], ["upper label bottom", labelA.bottom - 1, [upper]]] as const) {
        const hit = document.elementFromPoint(x, y);
        const hitBox = boxes.find((box) => !!hit && labelOf(box).contains(hit));
        if (!hitBox) continue;
        const own = labelOf(hitBox).getBoundingClientRect();
        if (!(owners as readonly HTMLElement[]).includes(hitBox) || y < own.top || y > own.bottom) stolen.push({ pair: index, name, toggles: labelOf(hitBox).textContent, rowOf: labelOf(upper).textContent });
      }
    });
    return { count: boxes.length, stolen };
  });
  check(stack.count >= 2 && stack.stolen.length === 0, `390px stacked checkboxes keep their taps to their own row (TouchStackedCheckboxNeighbours): ${JSON.stringify(stack)}`);
  await mobilePage.keyboard.press("Escape");
  await displayFields.waitFor({ state: "hidden" });
  const toolbarControls = await Promise.all([mobileView, filterButton, displayButton, mobileMore].map((control) => control.boundingBox()));
  check(toolbarControls.every((box) => !!box && box.width >= 44 && box.height >= 44 && box.y === toolbarControls[0]?.y), "390px phone toolbar controls share one row and each has a 44px touch target");
  // Reads each toolbar control as the user sees it: its accessible label, its text colour and the colour behind it, and the WCAG contrast ratio between them.
  const readToolbarContrast = () => mobilePage.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('[data-testid="work-items-toolbar"]');
    // A 2D canvas resolves any computed colour (oklch, color-mix, rgb) to 8-bit sRGB, so the contrast is measured on the colour the browser paints.
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const parse = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r: r!, g: g!, b: b!, a: a! / 255 };
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const [R, G, B] = [r, g, b].map((channel) => { const s = channel / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
    };
    const pageBackground = parse(getComputedStyle(document.body).backgroundColor);
    const backdrop = (element: HTMLElement) => {
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color.a > 0) return color;
      }
      return pageBackground;
    };
    const controls = [...(toolbar?.querySelectorAll<HTMLElement>("button, a[href], label, select") ?? [])].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    });
    return controls.map((element) => {
      const text = element.textContent?.trim() ?? "";
      const name = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? text;
      const foreground = parse(getComputedStyle(element).color);
      const background = backdrop(element);
      const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return { name, text, color: getComputedStyle(element).color, background: `rgb(${background.r}, ${background.g}, ${background.b})`, ratio: Number(((hi! + 0.05) / (lo! + 0.05)).toFixed(2)) };
    });
  });
  const assertToolbarReadable = async (label: string) => {
    const controls = await readToolbarContrast();
    check(controls.length === 4 && controls.every((control) => control.name.trim() !== ""), `${label}: every toolbar control has an accessible label: ${JSON.stringify(controls.filter((control) => control.name.trim() === ""))}`);
    check(controls.every((control) => control.ratio >= 4.5), `${label}: toolbar text contrast is at least 4.5:1: ${JSON.stringify(controls.filter((control) => control.ratio < 4.5))}`);
  };
  for (const theme of ["light", "dark"] as const) {
    // Stored the way the app stores it (theme.ts): a reload applies the theme before first paint, so the check reads the page a user gets.
    await mobilePage.evaluate((value) => localStorage.setItem("weft.theme", value), theme);
    await mobilePage.goto(mobileListUrl);
    await mobilePage.getByTestId("row-MOB-1").getByRole("button", { name: `${translate("workItems.cycle")}: Sprint 17` }).waitFor();
    await assertToolbarReadable(`390px ${theme} after reload`);
    await mobilePage.screenshot({ path: `${evidenceShots}/work-items-list-touch-390-${theme}.png`, fullPage: true });
  }
  // The theme picker switches data-theme at runtime (theme.ts applyTheme); the same toolbar must stay readable after that switch too.
  for (const theme of ["light", "dark"] as const) {
    await mobilePage.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    // Colour transitions (transition-colors) still run for a moment after the switch; read the settled colours a user sees.
    await mobilePage.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    await assertToolbarReadable(`390px ${theme} after runtime switch`);
  }
  for (const [width, height] of [[390, 844], [844, 390]] as const) {
    await mobilePage.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) {
      await mobilePage.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const geometry = await mobilePage.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>("[data-list-row]")];
        const inside = (inner: DOMRect, outer: DOMRect) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
        const measured = rows.map((row) => {
          const rowBox = row.getBoundingClientRect();
          const elements = [...row.querySelectorAll<HTMLElement>("[data-phone-property], [data-list-property], button, a[href]")]
            .filter((element) => {
              const style = getComputedStyle(element);
              return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
            });
          const elementOverflows = elements.flatMap((element) => {
            const box = element.getBoundingClientRect();
            return inside(box, rowBox) ? [] : [{ tag: element.tagName, className: element.className, box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom } }];
          });
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          const glyphOverflows: Array<{ text: string; box: { x: number; y: number; right: number; bottom: number } }> = [];
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
              for (let parent = node.parentElement; parent && parent !== row; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                const clip = parent.getBoundingClientRect();
                if (style.overflowX !== "visible") { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
                if (style.overflowY !== "visible") { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
              }
              const visibleGlyph = { left, right, top, bottom };
              if (right <= left || bottom <= top || inside(visibleGlyph as DOMRect, rowBox)) continue;
              glyphOverflows.push({ text: node.textContent.trim(), box: { x: left, y: top, right, bottom } });
            }
          }
          const title = row.querySelector<HTMLElement>("a[href]");
          const titleLines = title ? (() => {
            const range = document.createRange();
            range.selectNodeContents(title);
            return new Set([...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => Math.round(rect.top))).size;
          })() : 0;
          const propertyRows = new Set([...row.querySelectorAll<HTMLElement>("[data-phone-property], [data-list-property]")]
            .filter((element) => getComputedStyle(element).display !== "none" && element.getClientRects().length > 0)
            .map((element) => Math.round(element.getBoundingClientRect().top))).size;
          return {
            id: row.dataset.testid,
            box: { top: rowBox.top, bottom: rowBox.bottom, height: rowBox.height },
            // Chipless rows reserve no chip line, so "has chips" is part of the data shape.
            signature: `${titleLines}/${propertyRows}/${[...row.querySelectorAll<HTMLElement>("[data-phone-property]")].some((cell) => getComputedStyle(cell).display !== "none") ? "chips" : "chipless"}`,
            elementOverflows,
            glyphOverflows,
          };
        });
        const ordered = measured.slice().sort((a, b) => a.box.top - b.box.top);
        const siblingOverlaps = ordered.slice(1).flatMap((row, index) => {
          const previous = ordered[index]!;
          return previous.box.bottom <= row.box.top + 0.5 ? [] : [{ previous: previous.id, current: row.id, previousBottom: previous.box.bottom, currentTop: row.box.top }];
        });
        const heightGroups = new Map<string, number[]>();
        for (const row of measured) heightGroups.set(row.signature, [...heightGroups.get(row.signature) ?? [], row.box.height]);
        const equalHeightGroups = [...heightGroups].filter(([, heights]) => heights.length > 1)
          .map(([signature, heights]) => ({ signature, min: Math.min(...heights), max: Math.max(...heights) }));
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          rows: measured,
          siblingOverlaps,
          equalHeightGroups,
        };
      });
      check(geometry.viewportWidth === width && geometry.documentWidth <= width, `${width}x${height} ${theme} dense list stays within the viewport: ${JSON.stringify({ viewportWidth: geometry.viewportWidth, documentWidth: geometry.documentWidth })}`);
      check(geometry.rows.length > 0 && geometry.rows.every((row) => row.elementOverflows.length === 0 && row.glyphOverflows.length === 0), `${width}x${height} ${theme} chips and text glyphs stay inside their own row boxes: ${JSON.stringify(geometry.rows.filter((row) => row.elementOverflows.length || row.glyphOverflows.length).map((row) => ({ id: row.id, box: row.box, elements: row.elementOverflows, glyphs: row.glyphOverflows })))}`);
      check(geometry.siblingOverlaps.length === 0, `${width}x${height} ${theme} sibling list rows do not overlap: ${JSON.stringify(geometry.siblingOverlaps)}`);
      check(geometry.equalHeightGroups.every((group) => group.max - group.min <= 1), `${width}x${height} ${theme} rows with matching title/property line data have equal heights: ${JSON.stringify(geometry.equalHeightGroups)}`);
      const denseRows = geometry.rows.filter((row) => row.id === "row-MOB-1" || row.id === "row-MOB-4");
      check(denseRows.length === 2 && denseRows.every((row) => row.elementOverflows.length === 0 && row.glyphOverflows.length === 0), `${width}x${height} ${theme} dense MOB-1/MOB-4 rows contain every chip and glyph: ${JSON.stringify(denseRows)}`);
    }
  }
  // Touch devices at any width (TouchListAnyWidth): a phone in portrait or landscape, and a phone browser in "Desktop site" mode,
  // which keeps the touch screen (hover: none, pointer: coarse) but lays the page out about 980px wide, so the wide list grid renders.
  const assertTouchList = async (target: typeof mobilePage, label: string) => {
    const media = await target.evaluate(() => ({ hoverNone: matchMedia("(hover: none)").matches, coarse: matchMedia("(pointer: coarse)").matches }));
    check(media.hoverNone && media.coarse, `${label} runs as a touch device: ${JSON.stringify(media)}`);
    const touch = await target.evaluate(() => {
      const shown = (element: Element) => {
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        }
        return element.getClientRects().length > 0;
      };
      const box = (element: Element | null | undefined) => { if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-list-row]")];
      const measured = rows.map((row) => {
        const rowBox = row.getBoundingClientRect();
        const checkbox = row.querySelector<HTMLElement>('[role="checkbox"]');
        const before = checkbox ? getComputedStyle(checkbox, "::before") : null;
        const displayId = (row.dataset.testid ?? "").replace(/^row-/, "");
        const id = [...row.querySelectorAll<HTMLElement>("span")].find((span) => span.children.length === 0 && span.textContent?.trim() === displayId);
        const title = row.querySelector<HTMLElement>("a[href]");
        const shownEmpty = [...row.querySelectorAll<HTMLElement>('[data-empty-property="true"]')].filter(shown).map((cell) => cell.dataset.listProperty);
        const dashes = [...row.querySelectorAll<HTMLElement>("button, span")].filter((element) => element.children.length === 0 && element.textContent?.trim() === "—" && shown(element)).length;
        const outside = [...row.querySelectorAll<HTMLElement>("button, a[href], [data-list-property], [data-phone-property]")].filter(shown).filter((element) => {
          const r = element.getBoundingClientRect();
          return r.left < rowBox.left - 0.5 || r.right > rowBox.right + 0.5 || r.top < rowBox.top - 0.5 || r.bottom > rowBox.bottom + 0.5;
        }).map((element) => element.getAttribute("aria-label") ?? element.tagName);
        return {
          id: row.dataset.testid, height: rowBox.height, shownEmpty, dashes, outside,
          checkbox: box(checkbox), hitWidth: before ? parseFloat(before.width) : 0, hitHeight: before ? parseFloat(before.height) : 0,
          checkboxOverId: overlaps(box(checkbox), box(id)), checkboxOverTitle: overlaps(box(checkbox), box(title)),
          // Rows with the same number of painted properties on the same number of lines, and the same title line count, carry the same data shape, so their heights must match.
          signature: (() => { const cells = [...row.querySelectorAll<HTMLElement>("[data-list-property], [data-phone-property]")].filter(shown); return `${cells.length}x${new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().top))).size}/${cells.filter((cell) => cell.hasAttribute("data-phone-property")).length}`; })() + "/" + (title ? new Set([...(() => { const range = document.createRange(); range.selectNodeContents(title); return range.getClientRects(); })()].map((rect) => Math.round(rect.top))).size : 0),
        };
      });
      const heights = new Map<string, number[]>();
      for (const row of measured) heights.set(row.signature, [...heights.get(row.signature) ?? [], row.height]);
      return {
        viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth, rows: measured,
        unequalHeights: [...heights].filter(([, list]) => Math.max(...list) - Math.min(...list) > 1).map(([signature, list]) => ({ signature, list })),
      };
    });
    check(touch.rows.length >= 5, `${label} renders list rows to measure: ${touch.rows.length}`);
    check(touch.documentWidth <= touch.viewportWidth, `${label} nothing is wider than the viewport (TouchNoHorizontalOverflow): ${touch.documentWidth} > ${touch.viewportWidth}`);
    check(touch.rows.every((row) => row.shownEmpty.length === 0 && row.dashes === 0), `${label} paints no empty property slot or dash (TouchNoEmptySlots): ${JSON.stringify(touch.rows.filter((row) => row.shownEmpty.length || row.dashes).map((row) => ({ id: row.id, shownEmpty: row.shownEmpty, dashes: row.dashes })))}`);
    const smallBox = (rect: { width: number; height: number } | null) => !!rect && rect.width >= 12 && rect.width <= 24 && rect.height >= 12 && rect.height <= 24;
    check(touch.rows.every((row) => smallBox(row.checkbox) && row.hitWidth >= 44 && row.hitHeight >= 44),
      `${label} checkboxes draw a 12-24px box with a 44px hit area (TouchSmallCheckbox): ${JSON.stringify(touch.rows.map((row) => ({ id: row.id, checkbox: row.checkbox, hit: [row.hitWidth, row.hitHeight] })))}`);
    check(touch.rows.every((row) => !row.checkboxOverId && !row.checkboxOverTitle), `${label} the checkbox never covers the ID or title (TouchCheckboxNoOverlap): ${JSON.stringify(touch.rows.filter((row) => row.checkboxOverId || row.checkboxOverTitle))}`);
    check(touch.rows.every((row) => row.outside.length === 0), `${label} row content stays inside its row (TouchRowContained): ${JSON.stringify(touch.rows.filter((row) => row.outside.length))}`);
    check(touch.unequalHeights.length === 0, `${label} rows with the same data have equal heights (TouchEqualRowHeights): ${JSON.stringify(touch.unequalHeights)}`);
    // Detector independent of the app's data attributes: any painted control whose accessible name reads as empty (Priority "No priority", a dash, "No cycle", …).
    const painted = await target.locator("[data-list-row]").evaluateAll(measureRows, emptyValues);
    check(painted.rows.every((row) => row.emptyPainted.length === 0), `${label} paints no empty property control, Priority included (TouchNoEmptySlots): ${JSON.stringify(painted.rows.filter((row) => row.emptyPainted.length).map((row) => ({ id: row.id, emptyPainted: row.emptyPainted })))}`);
    check(painted.rows.every((row) => row.glyphOverflow.length === 0) && painted.siblingOverlaps.length === 0, `${label} no glyph leaves its row and rows do not overlap (TouchRowContained): ${JSON.stringify({ glyphs: painted.rows.filter((row) => row.glyphOverflow.length), overlaps: painted.siblingOverlaps })}`);
    // An unpainted empty Priority keeps its track, so the ID column starts at the same x in rows with and without a priority.
    const idLefts = await target.locator("[data-list-row]").evaluateAll((rows) => rows.map((row) => {
      const displayId = ((row as HTMLElement).dataset.testid ?? "").replace(/^row-/, "");
      const id = [...row.querySelectorAll<HTMLElement>("span")].find((span) => span.children.length === 0 && span.textContent?.trim() === displayId);
      return id ? Math.round(id.getBoundingClientRect().left) : null;
    }));
    check(idLefts.every((left) => left !== null && Math.abs(left - idLefts[0]!) <= 1), `${label} the ID column stays aligned whether or not a row has a priority (TouchIdColumnAligned): ${JSON.stringify(idLefts)}`);
    if (await target.evaluate(() => window.innerWidth >= 640)) {
      const oneLineHeights = painted.rows.filter((row) => row.signature.endsWith("title:1")).map((row) => row.height);
      check(oneLineHeights.length > 0 && Math.max(...oneLineHeights) - Math.min(...oneLineHeights) <= 1, `${label} one-line grid rows all share one height whatever data they carry (TouchGridEqualHeights): ${JSON.stringify(oneLineHeights)}`);
    }
    // Touch hides empty properties in the list (PR #184); they are set in the peek, which one tap on the row title opens (TouchPeekOneTap).
    const peekRow = target.locator("[data-list-row]").nth(1);
    await peekRow.locator("a[href]").first().tap();
    const peek = target.locator("[data-peek]");
    await peek.waitFor();
    check(await peek.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}`) }).count() > 0, `${label} one tap on a row title opens the peek with its property controls (TouchPeekOneTap)`);
    await target.keyboard.press("Escape");
    await peek.waitFor({ state: "hidden" });
    const firstRowControls = target.getByTestId("row-MOB-1").locator('button[aria-label], [role="checkbox"]');
    for (let index = 0; index < await firstRowControls.count(); index += 1) {
      const control = firstRowControls.nth(index);
      if (!await control.isVisible()) continue;
      await control.scrollIntoViewIfNeeded();
      const misses = await control.evaluate(missedHitPoints);
      check(misses.length === 0, `${label} ${await control.getAttribute("aria-label")} answers taps across its whole 44px area (TouchHitArea44): ${JSON.stringify(misses)}`);
    }
  };
  const desktopSiteContext = await browser.newContext({ viewport: { width: 980, height: 1800 }, deviceScaleFactor: 2.3, isMobile: false, hasTouch: true, storageState: await context.storageState() });
  const desktopSitePage = await desktopSiteContext.newPage();
  for (const theme of ["light", "dark"] as const) {
    await desktopSitePage.addInitScript((value) => localStorage.setItem("weft.theme", value), theme);
    await desktopSitePage.goto(mobileListUrl);
    await desktopSitePage.getByTestId("row-MOB-1").getByRole("link", { name: "Alpha" }).waitFor();
    await assertTouchList(desktopSitePage, `980px desktop-site touch ${theme}`);
    await desktopSitePage.screenshot({ path: `${evidenceShots}/work-items-list-touch-desktop-site-980-${theme}.png` });
  }
  await desktopSiteContext.close();
  for (const [width, height] of [[390, 844], [844, 390]] as const) {
    await mobilePage.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) {
      await mobilePage.evaluate((value) => localStorage.setItem("weft.theme", value), theme);
      await mobilePage.goto(mobileListUrl);
      await mobilePage.getByTestId("row-MOB-1").getByRole("link", { name: "Alpha" }).waitFor();
      await assertTouchList(mobilePage, `${width}x${height} touch ${theme}`);
    }
  }
  await mobilePage.setViewportSize({ width: 390, height: 844 });
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
  const phoneView = page.getByRole("combobox", { name: translate("layout.switch") });
  for (const layout of ["list", "board", "spreadsheet", "calendar", "gantt"] as const) {
    check(await phoneView.getByRole("option", { name: translate(`layout.${layout}`) }).count() === 1, `${layout} has a named option on a phone`);
  }
  const titleBox = await page.getByRole("heading", { name: /MOB · Mobile/ }).boundingBox();
  check(!!titleBox && titleBox.x >= 0 && titleBox.x + titleBox.width <= 390, "project title stays within the phone viewport beside the breadcrumb");
  await phoneView.selectOption("board");
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
  await phoneView.selectOption("gantt");
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
    await phoneView.selectOption(layout);
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
  await phoneView.selectOption("list");
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    const toggleQuery = async () => {
      if (width >= 768) {
        await page.getByRole("button", { name: translate("layout.filterQuery.toggle") }).click();
      } else {
        await page.getByRole("button", { name: translate("workItems.moreActions") }).click();
        await page.getByRole("menuitemcheckbox", { name: translate("layout.filterQuery.button") }).click();
      }
    };
    for (const [name, toggle] of [
      ["filters", () => page.getByRole("button", { name: translate("layout.filters") }).click()],
      ["query", toggleQuery],
      ["display", () => page.getByRole("button", { name: translate("layout.display") }).click()],
    ] as const) {
      await toggle();
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        await page.screenshot({ path: `${evidenceShots}/${name}-${theme}-${width}.png`, fullPage: true });
      }
      await toggle();
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  check(await page.evaluate(() => window.innerWidth === 1440 && window.innerHeight === 900), "Cycles sidebar check runs at the desktop viewport after phone screenshots");
  // Since #210 the shell restores the desktop sidebar when the viewport widens again, so the Cycles link is back without a click.
  await page.getByRole("button", { name: translate("shell.collapseSidebar") }).waitFor();
  const cyclesLink = page.getByRole("link", { name: translate("cycles.title"), exact: true });
  await page.waitForFunction((label) => [...document.querySelectorAll<HTMLAnchorElement>('#desktop-sidebar a')].some((link) => link.textContent.trim() === label && link.getBoundingClientRect().left >= 0), translate("cycles.title"));
  const cyclesLinkBounds = await cyclesLink.boundingBox();
  check(!!cyclesLinkBounds && cyclesLinkBounds.x >= 0 && cyclesLinkBounds.x + cyclesLinkBounds.width <= 1440 && cyclesLinkBounds.y >= 0 && cyclesLinkBounds.y + cyclesLinkBounds.height <= 900, `Cycles sidebar link is visible after restoring the desktop sidebar: ${JSON.stringify(cyclesLinkBounds)}`);
  await page.getByRole("link", { name: translate("cycles.title"), exact: true }).click();
  const activeCyclesTab = page.getByRole("tab", { name: new RegExp(`${translate("cycles.status.active")}\\s+16$`) });
  await activeCyclesTab.waitFor();
  await assertStableBounds(page.getByRole("tab", { name: new RegExp(translate("cycles.status.active")) }), "Tabs");
  await assertStableBounds(activeCyclesTab, "Tabs");

  const edgeTapContext = await browser.newContext({ hasTouch: true, isMobile: true, storageState: await context.storageState() });
  const edgeTapPage = await edgeTapContext.newPage();
  const compactItem = await call<{ displayId: string }>("create_work_item", { projectId: project!.id, title: "Priority only", priority: "high" });
  await edgeTapPage.setViewportSize({ width: 390, height: 844 });
  await edgeTapPage.goto(mobileListUrl);
  // A compact row with populated Priority must fit both hit areas even without trailing chips.
  const compactRow = edgeTapPage.getByTestId(`row-${compactItem.displayId}`);
  const compactPriorityName = `${translate("workItems.priority")}: ${translate("workItems.priority.high")}`;
  const compactPriority = compactRow.getByRole("button", { name: compactPriorityName });
  const compactCheckbox = compactRow.getByRole("checkbox");
  await compactPriority.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const compactBounds = await compactRow.boundingBox();
  check(!!compactBounds && compactBounds.height <= 90 && await compactRow.locator("[data-phone-property]").count() === 0,
    `390px touch row with only leading properties stays within 90px: ${JSON.stringify(compactBounds)}`);
  for (const target of [compactPriority, compactCheckbox]) {
    const misses = await target.evaluate(missedHitPoints);
    check(misses.length === 0, `Compact touch control receives its entire 44px area: ${JSON.stringify(misses)}`);
  }
  const priorityBounds = (await compactPriority.boundingBox())!;
  await edgeTapPage.touchscreen.tap(priorityBounds.x + priorityBounds.width / 2, priorityBounds.y + priorityBounds.height / 2 - 21);
  const priorityDialog = edgeTapPage.getByRole("dialog", { name: compactPriorityName });
  await priorityDialog.waitFor();
  check(await compactCheckbox.getAttribute("aria-checked") === "false", "The upper edge of Priority opens its picker without selecting the row");
  await edgeTapPage.keyboard.press("Escape");
  await priorityDialog.waitFor({ state: "hidden" });
  const checkboxBounds = (await compactCheckbox.boundingBox())!;
  await edgeTapPage.touchscreen.tap(checkboxBounds.x + checkboxBounds.width / 2, checkboxBounds.y + checkboxBounds.height / 2 + 21);
  check(await compactCheckbox.getAttribute("aria-checked") === "true" && !await priorityDialog.isVisible(), "The lower edge of the checkbox selects the row without opening Priority");
  await compactCheckbox.tap();
  check(await compactCheckbox.getAttribute("aria-checked") === "false", "The compact row checkbox can clear its selection");

  // Use the same member's locale setting the app reads and exercise real taps near the neighbouring layout button.
  for (const locale of ["en", "th"] as const) {
    await call("set_my_locale", { locale });
    for (const [width, height] of [[320, 700], [844, 390]] as const) {
      await edgeTapPage.setViewportSize({ width, height });
      await edgeTapPage.goto(mobileListUrl);
      await edgeTapPage.waitForFunction((value) => document.documentElement.lang === value, locale);
      const toolbar = edgeTapPage.getByTestId("work-items-toolbar");
      const switcher = toolbar.getByRole("combobox", { name: translate("layout.switch", locale) });
      await switcher.waitFor();
      await edgeTapPage.evaluate(() => document.fonts.ready);
      const dimensions = await toolbar.evaluate((element) => ({
        documentWidth: document.documentElement.scrollWidth,
        clippedControls: [...element.querySelectorAll<HTMLElement>('button, a[href], [role="checkbox"], select')].flatMap((control) => {
          const { left, right } = control.getBoundingClientRect();
          return left < 0 || right > window.innerWidth ? [control.getAttribute("aria-label") ?? control.textContent] : [];
        }),
      }));
      check(dimensions.documentWidth <= width && dimensions.clippedControls.length === 0, `${locale} ${width}px toolbar fits: ${JSON.stringify(dimensions)}`);
      if (width === 320) {
        const list = edgeTapPage.getByTestId("work-items-list-container");
        const populatedRow = list.getByTestId("row-MOB-1");
        await populatedRow.getByRole("button", { name: `${translate("workItems.cycle", locale)}: Sprint 17`, exact: true }).waitFor();
        await populatedRow.getByRole("button", { name: `${translate("workItems.modules", locale)}: Auth`, exact: true }).waitFor();
        const widths = await Promise.all([edgeTapPage.locator("#main-content"), list].map((container) =>
          container.evaluate(({ id, clientWidth, scrollWidth }) => ({ container: id || "work items list", clientWidth, scrollWidth }))));
        check(widths.every(({ clientWidth, scrollWidth }) => clientWidth > 0 && scrollWidth <= clientWidth + 1),
          `${locale} 320px main and list content fit inside their scroll containers: ${JSON.stringify(widths)}`);
      }
      const switcherBox = await switcher.boundingBox();
      check(!!switcherBox && switcherBox.width >= 44 && switcherBox.height >= 44, `${locale} ${width}px view dropdown occupies its own 44px target`);
      check((await switcher.evaluate(missedHitPoints)).length === 0, `${locale} ${width}px view dropdown owns its full 44px target`);
      for (const layout of ["board", "spreadsheet", "calendar", "gantt", "list"] as const) {
        await switcher.selectOption({ label: translate(`layout.${layout}`, locale) });
        await edgeTapPage.waitForURL((url) => (url.searchParams.get("layout") ?? "list") === layout, { timeout: 5000 });
        check(await switcher.inputValue() === layout, `${locale} ${width}px view dropdown displays ${layout}`);
      }
      if (width === 320) {
        const displayName = translate("layout.display", locale);
        const display = toolbar.getByRole("button", { name: displayName });
        const displayBox = (await display.boundingBox())!;
        await edgeTapPage.touchscreen.tap(displayBox.x + displayBox.width / 2, displayBox.y + displayBox.height / 2 + 21);
        const displayDialog = edgeTapPage.getByRole("dialog", { name: displayName });
        await displayDialog.waitFor();
        await edgeTapPage.keyboard.press("Escape");
        await displayDialog.waitFor({ state: "hidden" });
        const more = toolbar.getByRole("button", { name: translate("workItems.moreActions", locale) });
        await more.tap();
        await edgeTapPage.getByRole("menuitem", { name: translate("views.saveAs", locale) }).tap();
        const saveDialog = edgeTapPage.getByRole("dialog", { name: translate("views.form.saveTitle", locale) });
        await saveDialog.waitFor();
        await edgeTapPage.keyboard.press("Escape");
        await saveDialog.waitFor({ state: "hidden" });
        await more.tap();
        const query = edgeTapPage.getByRole("menuitemcheckbox", { name: translate("layout.filterQuery.button", locale) });
        check(await query.getAttribute("aria-checked") === "false", `${locale} Filter Query starts unchecked`);
        await query.tap();
        await more.tap();
        check(await query.getAttribute("aria-checked") === "true", `${locale} Filter Query shows its checked state`);
        await edgeTapPage.keyboard.press("Escape");
      }
    }
  }
  await edgeTapContext.close();
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
