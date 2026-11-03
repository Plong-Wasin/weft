// Browser end-to-end flow for Calendar placement, rescheduling, quick-create, peek, saved Views and the mobile agenda.
import { chromium } from "playwright";
import { eq } from "drizzle-orm";
import { createDatabase, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3127);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5227);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, CHOKIDAR_USEPOLLING: "true" }, stdout: "ignore", stderr: "inherit" }),
];
async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}
type Item = { id: string; displayId: string; dueDate: string | null; startDate: string | null };
let failed = false;
let testWorkspaceSlug: string | null = null;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  testWorkspaceSlug = slug;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()} ${await response.text()}`); return await response.json() as T; };
  const day = (offset: number) => { const date = new Date(); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Calendar Tester");
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
  const dated = await call<Item>("create_work_item", { projectId: project!.id, title: "Scheduled", startDate: day(8), dueDate: day(10) });
  await call<Item>("create_work_item", { projectId: project!.id, title: "Unscheduled" });
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("tab", { name: translate("layout.calendar") }).click();
  const calendar = page.getByTestId("calendar-layout");
  await calendar.getByTestId(`calendar-card-${dated.displayId}`).waitFor();
  await calendar.getByRole("link", { name: "Unscheduled" }).waitFor();

  // A successful drop persists the due date; a drop before start date leaves the card in place and reports the rejection.
  const validUpdate = page.waitForResponse((response) => response.url().includes("update_work_item"));
  await calendar.getByTestId(`calendar-card-${dated.displayId}`).dragTo(calendar.locator(`[data-calendar-date="${day(9)}"]`));
  await validUpdate;
  let updated = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === dated.id)!;
  check(updated.dueDate?.slice(0, 10) === day(9), `valid drop did not reschedule: ${updated.dueDate}`);
  await calendar.getByTestId(`calendar-card-${dated.displayId}`).dragTo(calendar.locator(`[data-calendar-date="${day(7)}"]`));
  await page.getByRole("alert").waitFor();
  updated = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === dated.id)!;
  check(updated.dueDate?.slice(0, 10) === day(9), "rejected drop changed the stored due date");
  await calendar.getByTestId(`calendar-card-${dated.displayId}`).waitFor();

  await calendar.getByTestId(`calendar-card-${dated.displayId}`).click();
  await page.getByRole("dialog", { name: translate("workItems.peek.title") }).waitFor();
  await page.keyboard.press("Escape");
  const quickDate = day(12);
  await calendar.getByRole("button", { name: translate("layout.calendar.add").replace("{date}", quickDate) }).click();
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Quickly scheduled");
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
  await page.getByRole("link", { name: "Scheduled", exact: true }).waitFor();
  check(new URL(page.url()).searchParams.get("layout") === "calendar", "saved Calendar View did not retain its layout URL");

  const ganttView = await call<{ id: string }>("create_view", { projectId: project!.id, name: "Gantt View", layout: "gantt", groupBy: "state", orderBy: "manual", orderDirection: "asc", properties: ["id", "state", "priority", "assignee", "labels", "dates", "cycle", "modules"], access: "private" });
  await page.goto(`${web}/${slug}/projects/MOB/views/${ganttView.id}`);
  const gantt = page.getByTestId("gantt-layout");
  await gantt.waitFor();
  await gantt.getByTestId("gantt-today").waitFor({ timeout: 10000 }).catch(() => { throw new Error("Gantt today marker is not visible"); });
  await gantt.getByRole("button", { name: translate("layout.gantt.next") }).click();
  await gantt.getByTestId("gantt-today").waitFor({ state: "detached", timeout: 3000 }).catch(() => { throw new Error("Gantt today marker is drawn although today is outside the visible range"); });
  await gantt.getByRole("button", { name: translate("layout.gantt.previous") }).click();
  await gantt.getByTestId("gantt-today").waitFor();
  await gantt.getByRole("link", { name: "Unscheduled", exact: true }).waitFor();
  check(new URL(page.url()).searchParams.get("layout") === "gantt", "saved Gantt View did not retain its layout URL");
  const planned = await call<Item>("create_work_item", { projectId: project!.id, title: "Gantt plan", startDate: day(-2), dueDate: day(0) });
  await page.reload();
  await gantt.getByTestId(`gantt-bar-${planned.displayId}`).waitFor();
  const dropAt = async (date: string) => {
    const axis = await gantt.evaluate((element) => ({ start: element.getAttribute("data-gantt-start")!, days: Number(element.getAttribute("data-gantt-days")) }));
    const offset = Math.round((new Date(`${date}T12:00:00`).getTime() - new Date(`${axis.start}T12:00:00`).getTime()) / 86400000);
    check(offset >= 0 && offset < axis.days, `Gantt drop date ${date} is outside visible axis`);
    return gantt.getByTestId(`gantt-row-${planned.displayId}`).getByTestId(`gantt-drop-${date}`);
  };
  const axis = await gantt.evaluate((element) => Number(element.getAttribute("data-gantt-days")));
  const timeline = gantt.getByTestId(`gantt-row-${planned.displayId}`).locator(":scope > div");
  const timelineBox = await timeline.boundingBox();
  const barBox = await gantt.getByTestId(`gantt-bar-${planned.displayId}`).boundingBox();
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
  const resizeResponse = page.waitForResponse((response) => response.url().includes("update_work_item"));
  const handle = await gantt.getByRole("button", { name: `${translate("layout.gantt.resizeStart")} ${planned.displayId}` }).boundingBox();
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
  const invalidHandle = await gantt.getByRole("button", { name: `${translate("layout.gantt.resizeStart")} ${planned.displayId}` }).boundingBox();
  const invalidBox = await invalidTarget.boundingBox();
  check(!!invalidHandle && !!invalidBox, "Gantt invalid resize target is missing");
  await page.mouse.move(invalidHandle!.x + invalidHandle!.width / 2, invalidHandle!.y + invalidHandle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(invalidBox!.x + invalidBox!.width / 2, invalidBox!.y + invalidBox!.height / 2);
  await gantt.getByTestId("gantt-origin").waitFor({ timeout: 3000 }).catch(() => { throw new Error("Gantt resize showed no origin outline"); });
  check(((await gantt.getByTestId(`gantt-bar-${planned.displayId}`).getAttribute("class")) ?? "").includes("ring-danger-strong"), "Gantt resize past the due date was not marked invalid");
  await page.mouse.up();
  await page.getByRole("alert").waitFor();
  await gantt.getByTestId("gantt-origin").waitFor({ state: "detached", timeout: 3000 }).catch(() => { throw new Error("Gantt preview stayed after a rejected resize"); });
  current = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === planned.id)!;
  check(current.startDate?.slice(0, 10) === day(5) && current.dueDate?.slice(0, 10) === day(6), "rejected Gantt resize changed stored dates");

  // An item with one date has no other edge to cross: its resize preview follows the pointer and is never marked invalid.
  const dueOnly = await call<Item>("create_work_item", { projectId: project!.id, title: "Gantt due only", dueDate: day(3) });
  await page.reload();
  const dueOnlyBar = gantt.getByTestId(`gantt-bar-${dueOnly.displayId}`);
  await dueOnlyBar.waitFor();
  const dueOnlyBox = await dueOnlyBar.boundingBox();
  const dueOnlyHandle = await gantt.getByRole("button", { name: `${translate("layout.gantt.resizeDue")} ${dueOnly.displayId}` }).boundingBox();
  check(!!dueOnlyBox && !!dueOnlyHandle, "Gantt due-only bar or handle is missing");
  const dueOnlyResponse = page.waitForResponse((response) => response.url().includes("update_work_item"));
  await page.mouse.move(dueOnlyHandle!.x + dueOnlyHandle!.width / 2, dueOnlyHandle!.y + dueOnlyHandle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(dueOnlyHandle!.x + dueOnlyHandle!.width / 2 - Math.round(2 * timelineBox!.width / axis), dueOnlyHandle!.y + dueOnlyHandle!.height / 2);
  await gantt.getByTestId("gantt-origin").waitFor({ timeout: 3000 }).catch(() => { throw new Error("Gantt due-only resize showed no origin outline"); });
  const dueOnlyLive = await dueOnlyBar.boundingBox();
  check(!!dueOnlyLive && dueOnlyBox!.x - dueOnlyLive.x > timelineBox!.width / axis, `Gantt due-only bar did not follow the due edge: ${dueOnlyBox!.x} -> ${dueOnlyLive?.x}`);
  check(!((await dueOnlyBar.getAttribute("class")) ?? "").includes("ring-danger-strong"), "Gantt one-sided resize was marked invalid");
  await page.mouse.up();
  await dueOnlyResponse;
  current = (await call<Item[]>("list_work_items", { projectId: project!.id })).find((item) => item.id === dueOnly.id)!;
  check(current.dueDate?.slice(0, 10) === day(1) && !current.startDate, `Gantt due-only resize wrote wrong dates: ${current.startDate}/${current.dueDate}`);
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.getByTestId(`row-${planned.displayId}`).isVisible(), "Gantt did not fall back to the list on mobile");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${web}/${slug}/projects/MOB/views/${savedView.id}`);
  await page.setViewportSize({ width: 390, height: 844 });
  const dayList = page.getByTestId("calendar-days");
  const columns = await dayList.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  check(columns === 1, `mobile Calendar is not a one-column agenda (${columns} columns)`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile agenda overflows horizontally");
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
