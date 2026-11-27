// Browser end-to-end flow for Calendar placement, rescheduling, quick-create, peek, saved Views and the mobile agenda.
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import { eq } from "drizzle-orm";
import { createDatabase, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3127);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5227);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api, env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true" } }),
];
type Item = { id: string; displayId: string; dueDate: string | null; startDate: string | null };
let failed = false;
let testWorkspaceSlug: string | null = null;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" }, api, web, {
    account: { name: "Calendar Tester", email: `${slug}@example.test` },
    workspace: { name: "E2E team", slug },
    project: { name: "Mobile", key: "MOB", visibility: "public", shape: "simple" },
  });
  const page = await context.newPage();
  // Keep the three-day pill in one calendar week, including when the suite runs at month end.
  const today = new Date(2026, 0, 5, 12);
  await page.clock.setFixedTime(today);
  testWorkspaceSlug = slug;
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()} ${await response.text()}`); return await response.json() as T; };
  const day = (offset: number) => { const date = new Date(today); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const dated = await call<Item>("create_work_item", { projectId: project!.id, title: "Scheduled — ปรับปรุงขั้นตอนตรวจสอบข้อมูลก่อนเผยแพร่", startDate: day(8), dueDate: day(10) });
  await call<Item>("create_work_item", { projectId: project!.id, title: "Unscheduled" });
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("button", { name: translate("layout.calendar") }).click();
  const calendar = page.getByTestId("calendar-layout");
  await calendar.getByTestId(`calendar-card-${dated.displayId}`).waitFor();
  await calendar.getByRole("link", { name: "Unscheduled" }).waitFor();
  const monthGrid = calendar.getByTestId("calendar-month-grid");
  const firstWeek = monthGrid.locator(":scope > div").first();
  const dayCells = firstWeek.locator(":scope > div");
  const dayBoxes = await dayCells.evaluateAll((cells) => cells.map((cell) => { const box = cell.getBoundingClientRect(); return { x: box.x, width: box.width, height: box.height }; }));
  check(dayBoxes.length === 7 && dayBoxes.every((box) => Math.abs(box.width - dayBoxes[0]!.width) < 1), "Calendar day columns do not have equal widths");
  const firstDateText = await dayCells.first().locator("time").textContent();
  check(/^\d{1,2}$/.test(firstDateText ?? ""), `Calendar day label repeats weekday or month: ${firstDateText}`);
  const longCalendarItem = calendar.getByTestId(`calendar-card-${dated.displayId}`);
  const titleFits = await longCalendarItem.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const font = getComputedStyle(element).font;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = font;
    return { rangeWidth: text.width, measuredWidth: context.measureText(element.textContent ?? "").width, available: element.clientWidth - 16, leftInset: text.left - box.left };
  });
  check(titleFits.measuredWidth <= titleFits.available + 1 && titleFits.rangeWidth <= titleFits.available + 1 && titleFits.leftInset >= 7, "Calendar item glyphs are clipped inside their pill");
  const rangeBox = await longCalendarItem.boundingBox();
  check(!!rangeBox && rangeBox.width >= dayBoxes[0]!.width * 2.5, "Calendar pill does not span its inclusive multi-day range");
  const addButton = calendar.getByRole("button", { name: translate("layout.calendar.add").replace("{date}", day(0)) });
  const addBefore = await addButton.evaluate((element) => ({ opacity: getComputedStyle(element).opacity, box: element.getBoundingClientRect().toJSON() }));
  await addButton.hover();
  const addAfter = await addButton.evaluate((element) => ({ opacity: getComputedStyle(element).opacity, box: element.getBoundingClientRect().toJSON() }));
  check(Number(addBefore.opacity) < 0.1 && Number(addAfter.opacity) > 0.9, "Calendar add action is not quiet until hover");
  check(Math.abs(addBefore.box.x - addAfter.box.x) < 0.1 && Math.abs(addBefore.box.y - addAfter.box.y) < 0.1 && Math.abs(addBefore.box.width - addAfter.box.width) < 0.1, "Calendar add action shifts the cell when revealed");
  const calendarSegments = await monthGrid.locator("[data-testid^='calendar-card-']").evaluateAll((elements) => elements.map((element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom }; }));
  check(calendarSegments.every((a, index) => calendarSegments.slice(index + 1).every((b) => a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1)), "Calendar event pills overlap another item");

  // A successful drop persists the due date; a drop before start date leaves the card in place and reports the rejection.
  const validUpdate = page.waitForResponse((response) => response.url().includes("update_work_item"));
  await calendar.getByTestId(`calendar-card-${dated.displayId}`).dragTo(calendar.locator(`[data-calendar-date="${day(9)}"]`), { targetPosition: { x: 20, y: 96 } });
  await validUpdate;
  let updated = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === dated.id)!;
  check(updated.dueDate?.slice(0, 10) === day(9), `valid drop did not reschedule: ${updated.dueDate}`);
  await calendar.getByTestId(`calendar-card-${dated.displayId}`).dragTo(calendar.locator(`[data-calendar-date="${day(7)}"]`), { targetPosition: { x: 20, y: 96 } });
  await page.getByRole("alert").waitFor();
  updated = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === dated.id)!;
  check(updated.dueDate?.slice(0, 10) === day(9), "rejected drop changed the stored due date");
  await calendar.getByTestId(`calendar-card-${dated.displayId}`).waitFor();

  await calendar.getByTestId(`calendar-card-${dated.displayId}`).click();
  await page.getByRole("dialog", { name: translate("workItems.peek.title") }).waitFor();
  await page.keyboard.press("Escape");
  const quickDate = day(12);
  if (await calendar.locator(`[data-calendar-date="${quickDate}"]`).count() === 0) {
    await calendar.getByRole("button", { name: translate("layout.calendar.next") }).click();
    await calendar.locator(`[data-calendar-date="${quickDate}"]`).waitFor();
  }
  const quickCell = monthGrid.locator(`[data-calendar-date="${quickDate}"]`);
  const quickCellBefore = await quickCell.boundingBox();
  await quickCell.getByRole("button", { name: translate("layout.calendar.add").replace("{date}", quickDate) }).click();
  const quickTitleInput = page.getByRole("textbox", { name: translate("workItems.titleField") });
  await quickTitleInput.waitFor();
  const quickCellAfter = await quickCell.boundingBox();
  check(!!quickCellBefore && !!quickCellAfter && Math.abs(quickCellBefore.height - quickCellAfter.height) < 1, "Opening Calendar quick-create shifts the week row");
  await quickTitleInput.fill("Quickly scheduled");
  const quickCreated = page.waitForResponse((response) => response.url().includes("create_work_item"));
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).press("Enter");
  const quickResponse = await quickCreated;
  check(quickResponse.ok(), `quick-create failed: ${quickResponse.status()} ${await quickResponse.text()}`);
  await calendar.getByTestId("calendar-card-MOB-3").waitFor();
  const quick = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.displayId === "MOB-3")!;
  check(quick.dueDate?.slice(0, 10) === quickDate, `quick-create date was ${quick.dueDate}`);

  const savedView = await call<{ id: string }>("create_view", { projectId: project!.id, name: "Calendar View", layout: "calendar", groupBy: "state", orderBy: "manual", orderDirection: "asc", properties: ["id", "state", "priority", "assignee", "labels", "dates", "cycle", "modules"], access: "private" });
  await page.goto(`${web}/${slug}/projects/MOB/views/${savedView.id}`);
  await page.getByTestId("calendar-layout").waitFor();
  await page.getByRole("link", { name: "Scheduled — ปรับปรุงขั้นตอนตรวจสอบข้อมูลก่อนเผยแพร่", exact: true }).waitFor();
  check(new URL(page.url()).searchParams.get("layout") === "calendar", "saved Calendar View did not retain its layout URL");

  const ganttView = await call<{ id: string }>("create_view", { projectId: project!.id, name: "Gantt View", layout: "gantt", groupBy: "state", orderBy: "manual", orderDirection: "asc", properties: ["id", "state", "priority", "assignee", "labels", "dates", "cycle", "modules"], access: "private" });
  await page.goto(`${web}/${slug}/projects/MOB/views/${ganttView.id}`);
  const gantt = page.getByTestId("gantt-layout");
  await gantt.waitFor();
  const planned = await call<Item>("create_work_item", { projectId: project!.id, title: "Gantt plan", startDate: day(-2), dueDate: day(0) });
  const clipped = await call<Item>("create_work_item", { projectId: project!.id, title: "Gantt continues", startDate: day(0), dueDate: day(45) });
  await page.reload();
  await gantt.getByTestId(`gantt-bar-${planned.displayId}`).waitFor();
  const clippedBar = gantt.getByTestId(`gantt-bar-${clipped.displayId}`);
  await clippedBar.waitFor();
  check(await clippedBar.locator("[data-gantt-overflow='due']").count() === 1, "Gantt bar clipped at the range end has no continuation indicator");
  await gantt.getByTestId("gantt-today").waitFor({ timeout: 10000 }).catch(() => { throw new Error("Gantt today marker is not visible"); });
  const todayLayer = await gantt.getByTestId("gantt-today").evaluate((element) => ({ z: Number(getComputedStyle(element).zIndex), width: element.getBoundingClientRect().width, style: getComputedStyle(element).borderLeftStyle }));
  check(todayLayer.z < 10 && todayLayer.width <= 1.5 && todayLayer.style === "dashed", "Gantt today marker obscures row content or is not a one-pixel dashed line");
  const initialLabel = gantt.getByTestId(`gantt-label-${planned.displayId}`);
  const labelMetrics = await initialLabel.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = style.font;
    const textWidth = context.measureText(element.textContent ?? "").width;
    const box = element.getBoundingClientRect();
    const bar = element.parentElement!.querySelector<HTMLElement>(`[data-testid='gantt-bar-${element.textContent}']`)!;
    const barBox = bar.getBoundingClientRect();
    return { textWidth, available: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), z: Number(style.zIndex), label: { left: box.left, right: box.right }, bar: { left: barBox.left, right: barBox.right }, fontSize: parseFloat(style.fontSize) };
  });
  check(labelMetrics.textWidth <= labelMetrics.available + 1 && labelMetrics.z > todayLayer.z && labelMetrics.fontSize >= 12, "Gantt label glyphs clip or sit under the today line");
  check(labelMetrics.label.right <= labelMetrics.bar.left + 1 || labelMetrics.label.left >= labelMetrics.bar.right - 1, "Gantt issue label is inside its date bar");
  const tickFontSize = await gantt.locator(".mt-2.overflow-x-auto").locator("div[title]").first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  check(tickFontSize >= 12, `Gantt date ticks are too small: ${tickFontSize}px`);
  await gantt.getByRole("button", { name: translate("layout.gantt.next") }).click();
  await gantt.getByTestId("gantt-today").waitFor({ state: "detached", timeout: 3000 }).catch(() => { throw new Error("Gantt today marker is drawn although today is outside the visible range"); });
  await gantt.getByRole("button", { name: translate("layout.gantt.previous") }).click();
  await gantt.getByTestId("gantt-today").waitFor();
  await gantt.getByRole("link", { name: "Unscheduled", exact: true }).waitFor();
  check(new URL(page.url()).searchParams.get("layout") === "gantt", "saved Gantt View did not retain its layout URL");
  await gantt.getByLabel(translate("layout.gantt.zoom")).selectOption("quarter");
  await gantt.getByTestId(`gantt-bar-${planned.displayId}`).waitFor();
  const dropAt = async (date: string) => {
    const axis = await gantt.evaluate((element) => ({ start: element.getAttribute("data-gantt-start")!, days: Number(element.getAttribute("data-gantt-days")) }));
    const offset = Math.round((new Date(`${date}T12:00:00`).getTime() - new Date(`${axis.start}T12:00:00`).getTime()) / 86400000);
    check(offset >= 0 && offset < axis.days, `Gantt drop date ${date} is outside visible axis`);
    return gantt.locator(`[data-gantt-date="${date}"]`).first();
  };
  const revealDropTarget = async (target: ReturnType<typeof gantt.getByTestId>) => target.evaluate((element) => {
    const scroller = element.closest<HTMLElement>(".overflow-x-auto")!;
    const box = element.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    if (box.left < viewport.left) scroller.scrollLeft -= viewport.left - box.left;
    else if (box.right > viewport.right) scroller.scrollLeft += box.right - viewport.right;
  });
  const axis = await gantt.evaluate((element) => Number(element.getAttribute("data-gantt-days")));
  const timeline = gantt.getByTestId(`gantt-row-${planned.displayId}`).locator(":scope > div");
  const plannedBar = gantt.getByTestId(`gantt-bar-${planned.displayId}`);
  await plannedBar.scrollIntoViewIfNeeded();
  const timelineBox = await timeline.boundingBox();
  const barBox = await plannedBar.boundingBox();
  check(!!timelineBox && !!barBox, "Gantt bar or timeline is missing");
  const moveResponse = page.waitForResponse((response) => response.url().includes("update_work_item"));
  // Text selected across the Gantt must not turn a bar press into a native text drag, which would cancel the pointer drag.
  await page.evaluate(() => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('[data-testid="gantt-layout"]')!);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.mouse.move(barBox!.x + barBox!.width / 2, barBox!.y + barBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(barBox!.x + barBox!.width / 2 + Math.round(6 * timelineBox!.width / axis), barBox!.y + barBox!.height / 2);
  // While dragging, the bar carries a shadow and a dashed outline marks where it started.
  await gantt.getByTestId("gantt-origin").waitFor({ timeout: 3000 }).catch(() => { throw new Error("Gantt drag showed no origin outline"); });
  check(((await gantt.getByTestId(`gantt-bar-${planned.displayId}`).getAttribute("class")) ?? "").includes("shadow-xl"), "Gantt bar has no shadow while dragging");
  const liveBox = await gantt.getByTestId(`gantt-bar-${planned.displayId}`).boundingBox();
  check(!!liveBox && liveBox.x - barBox!.x > 3 * timelineBox!.width / axis, `Gantt bar did not follow the pointer while dragging: ${barBox!.x} -> ${liveBox?.x}`);
  await page.mouse.up();
  await moveResponse;
  await gantt.getByTestId("gantt-origin").waitFor({ state: "detached", timeout: 3000 }).catch(() => { throw new Error("Gantt origin outline stayed after the drop"); });
  let current = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === planned.id)!;
  check(current.startDate?.slice(0, 10) === day(4) && current.dueDate?.slice(0, 10) === day(6), `Gantt drag did not shift both dates: ${current.startDate}/${current.dueDate}`);
  const resized = await dropAt(day(5));
  await revealDropTarget(resized);
  const resizeResponse = page.waitForResponse((response) => response.url().includes("update_work_item"));
  const resizeHandle = gantt.getByRole("button", { name: `${translate("layout.gantt.resizeStart")} ${planned.displayId}` });
  const handle = await resizeHandle.boundingBox();
  const target = await resized.boundingBox();
  check(!!handle && !!target, "Gantt resize handle or target is missing");
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2);
  await page.mouse.up();
  await resizeResponse;
  current = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === planned.id)!;
  check(current.startDate?.slice(0, 10) === day(5) && current.dueDate?.slice(0, 10) === day(6), `Gantt edge resize wrote wrong dates: ${current.startDate}/${current.dueDate}`);
  const invalidTarget = await dropAt(day(7));
  await revealDropTarget(invalidTarget);
  const invalidResizeHandle = gantt.getByRole("button", { name: `${translate("layout.gantt.resizeStart")} ${planned.displayId}` });
  const invalidHandle = await invalidResizeHandle.boundingBox();
  const invalidBox = await invalidTarget.boundingBox();
  check(!!invalidHandle && !!invalidBox, "Gantt invalid resize target is missing");
  await page.mouse.move(invalidHandle!.x + invalidHandle!.width / 2, invalidHandle!.y + invalidHandle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(invalidBox!.x + invalidBox!.width / 2, invalidBox!.y + invalidBox!.height / 2);
  await gantt.getByTestId("gantt-origin").waitFor({ timeout: 3000 }).catch(() => { throw new Error("Gantt resize showed no origin outline"); });
  check(((await gantt.getByTestId(`gantt-bar-${planned.displayId}`).getAttribute("class")) ?? "").includes("ring-destructive"), "Gantt resize past the due date was not marked invalid");
  await page.mouse.up();
  await page.getByRole("alert").waitFor();
  await gantt.getByTestId("gantt-origin").waitFor({ state: "detached", timeout: 3000 }).catch(() => { throw new Error("Gantt preview stayed after a rejected resize"); });
  current = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === planned.id)!;
  check(current.startDate?.slice(0, 10) === day(5) && current.dueDate?.slice(0, 10) === day(6), "rejected Gantt resize changed stored dates");

  // An item with one date has no other edge to cross: its resize preview follows the pointer and is never marked invalid.
  const dueOnly = await call<Item>("create_work_item", { projectId: project!.id, title: "Gantt due only", dueDate: day(3) });
  await page.reload();
  await gantt.getByLabel(translate("layout.gantt.zoom")).selectOption("quarter");
  const dueOnlyBar = gantt.getByTestId(`gantt-bar-${dueOnly.displayId}`);
  await dueOnlyBar.waitFor();
  const dueOnlyTarget = await dropAt(day(1));
  await revealDropTarget(dueOnlyTarget);
  await dueOnlyBar.scrollIntoViewIfNeeded();
  const dueOnlyBox = await dueOnlyBar.boundingBox();
  const dueOnlyResizeHandle = gantt.getByRole("button", { name: `${translate("layout.gantt.resizeDue")} ${dueOnly.displayId}` });
  const dueOnlyHandle = await dueOnlyResizeHandle.boundingBox();
  const dueOnlyTargetBox = await dueOnlyTarget.boundingBox();
  check(!!dueOnlyBox && !!dueOnlyHandle && !!dueOnlyTargetBox, "Gantt due-only bar, handle or target is missing");
  const dueOnlyResponse = page.waitForResponse((response) => response.url().includes("update_work_item"));
  await page.mouse.move(dueOnlyHandle!.x + dueOnlyHandle!.width / 2, dueOnlyHandle!.y + dueOnlyHandle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(dueOnlyTargetBox!.x + dueOnlyTargetBox!.width / 2, dueOnlyTargetBox!.y + dueOnlyTargetBox!.height / 2);
  await gantt.getByTestId("gantt-origin").waitFor({ timeout: 3000 }).catch(() => { throw new Error("Gantt due-only resize showed no origin outline"); });
  const dueOnlyLive = await dueOnlyBar.boundingBox();
  check(!!dueOnlyLive && dueOnlyBox!.x - dueOnlyLive.x > timelineBox!.width / axis, `Gantt due-only bar did not follow the due edge: ${dueOnlyBox!.x} -> ${dueOnlyLive?.x}`);
  check(!((await dueOnlyBar.getAttribute("class")) ?? "").includes("ring-destructive"), "Gantt one-sided resize was marked invalid");
  await page.mouse.up();
  await dueOnlyResponse;
  current = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === dueOnly.id)!;
  check(current.dueDate?.slice(0, 10) === day(1) && !current.startDate, `Gantt due-only resize wrote wrong dates: ${current.startDate}/${current.dueDate}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText(translate("layout.gantt.scrollHint"), { exact: true }).waitFor({ timeout: 3000 }).catch(() => { throw new Error("Gantt on mobile shows no sideways-scroll hint"); });
  check(await gantt.getByTestId(`gantt-bar-${planned.displayId}`).count() === 1, "Gantt on mobile lost its timeline bar");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${web}/${slug}/projects/MOB/views/${savedView.id}`);
  await page.setViewportSize({ width: 390, height: 844 });
  const dayList = page.getByTestId("calendar-days");
  const columns = await dayList.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  check(columns === 1, `mobile Calendar is not a one-column agenda (${columns} columns)`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile agenda overflows horizontally");
  const agendaDay = dayList.locator("[data-calendar-date]").first();
  const agendaDate = await agendaDay.getAttribute("data-calendar-date");
  const agendaBoxBefore = await agendaDay.boundingBox();
  await agendaDay.getByRole("button", { name: translate("layout.calendar.add").replace("{date}", agendaDate!) }).click();
  await dayList.getByRole("textbox", { name: translate("workItems.titleField") }).waitFor();
  const agendaBoxAfter = await agendaDay.boundingBox();
  check(!!agendaBoxBefore && !!agendaBoxAfter && Math.abs(agendaBoxBefore.height - agendaBoxAfter.height) < 1, "Mobile calendar quick-create shifts the agenda row");
  await dayList.getByRole("textbox", { name: translate("workItems.titleField") }).press("Escape");
  console.log("calendar e2e passed");
  await browser.close();
} catch (error) { failed = true; console.error(error); }
finally {
  for (const server of servers) server.kill();
  if (testWorkspaceSlug) {
    const { client, db } = createDatabase();
    try { await db.delete(workspaces).where(eq(workspaces.slug, testWorkspaceSlug)); }
    finally { await client.end(); }
  }
}
process.exit(failed ? 1 : 0);
