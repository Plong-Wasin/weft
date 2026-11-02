// Browser end-to-end flow for Calendar placement, rescheduling, quick-create, peek, saved Views and the mobile agenda.
import { chromium } from "playwright";
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
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()} ${await response.text()}`); return await response.json() as T; };
  const day = (offset: number) => { const date = new Date(); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  await page.goto(web);
  await page.getByLabel(translate("auth.name")).fill("Calendar Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
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

  await page.setViewportSize({ width: 390, height: 844 });
  const dayList = page.getByTestId("calendar-days");
  const columns = await dayList.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  check(columns === 1, `mobile Calendar is not a one-column agenda (${columns} columns)`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile agenda overflows horizontally");
  console.log("calendar e2e passed");
  await browser.close();
} catch (error) { failed = true; console.error(error); }
finally { for (const server of servers) server.kill(); }
process.exit(failed ? 1 : 0);
