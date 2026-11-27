// Browser end-to-end flow for the week start: calendar, Gantt week zoom and date picker start on Sunday by default,
// Preferences switches them to Monday, the choice survives a reload, and the phone calendar list still works.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase, workspaces } from "../packages/db/src";
import { translate, type MessageKey } from "../packages/shared/src";
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3199);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5299);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = join(process.cwd(), ".local/shots/15-week-start");
mkdirSync(shots, { recursive: true });
const servers = [startApi(apiPort, web), startWeb(webPort, { api, env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true" } })];
const t = (key: string) => translate(key as MessageKey);
let failed = false;
let slug: string | null = null;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const name = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" }, api, web, {
    account: { name: "Week Tester", email: `${name}@example.test` },
    workspace: { name: "E2E team", slug: name },
    project: { name: "Weeks", key: "WKS", visibility: "public", shape: "simple" },
  });
  slug = name;
  const page = await context.newPage();
  // Thursday 26 November 2026; November 2026 starts on a Sunday, so the two settings give clearly different grids.
  await page.clock.setFixedTime(new Date(2026, 10, 26, 12));
  const call = async <T>(action: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${action}`, { data: body }); check(response.ok(), `${action} failed: ${response.status()} ${await response.text()}`); return await response.json() as T; };
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  await call("create_work_item", { projectId: project!.id, title: "Dated", dueDate: "2026-11-26" });

  const calendar = page.getByTestId("calendar-layout");
  const openCalendar = async () => {
    await page.goto(`${web}/${name}/projects/WKS/issues?layout=calendar`);
    await calendar.waitFor();
  };

  async function expectWeekStart(day: "sunday" | "monday") {
    const monday = day === "monday";
    await openCalendar();
    const grid = calendar.getByTestId("calendar-month-grid");
    const header = await grid.locator("xpath=preceding-sibling::div[1]").locator(":scope > div").allTextContents();
    check(header.length === 7 && header[0] === t(monday ? "layout.weekday.mon" : "layout.weekday.sun") && header[6] === t(monday ? "layout.weekday.sun" : "layout.weekday.sat"), `${day}: calendar headers are ${header.join(",")}`);
    const first = await grid.locator("[data-calendar-date]").first().getAttribute("data-calendar-date");
    check(first === (monday ? "2026-10-26" : "2026-11-01"), `${day}: calendar grid starts on ${first}`);
    await page.screenshot({ path: join(shots, `calendar-${day}.png`) });

    await page.goto(`${web}/${name}/projects/WKS/issues?layout=gantt`);
    const gantt = page.getByTestId("gantt-layout");
    await gantt.getByRole("combobox", { name: t("layout.gantt.zoom") }).selectOption("week");
    const start = await gantt.getAttribute("data-gantt-start");
    check(start === (monday ? "2026-11-16" : "2026-11-15"), `${day}: Gantt week zoom starts on ${start}`);

    await page.goto(`${web}/${name}/browse/WKS-1`);
    await page.getByRole("complementary", { name: t("workItems.properties") }).getByRole("button", { name: new RegExp(`^${t("workItems.dueDate")}:`) }).click();
    const panel = page.locator("[data-popover-panel]");
    await panel.locator('[data-date="2026-11-26"]').waitFor();
    const narrow = (date: number) => new Intl.DateTimeFormat("en-US", { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 10, date)));
    const columns = await panel.locator("[data-month]").locator("xpath=preceding-sibling::div[1]").locator("span").allTextContents();
    // 1 November 2026 is a Sunday.
    const wanted = Array.from({ length: 7 }, (_, index) => narrow(index + (monday ? 2 : 1)));
    check(columns.join() === wanted.join(), `${day}: date picker headers are ${columns.join()}`);
    const leftmost = await panel.locator("[data-month]").evaluate((element) => {
      const left = element.getBoundingClientRect().left;
      return [...element.querySelectorAll<HTMLElement>("[data-date]")].filter((cell) => cell.getBoundingClientRect().left - left < 8).map((cell) => cell.dataset.date!);
    });
    check(leftmost[0] === (monday ? "2026-11-02" : "2026-11-01"), `${day}: leftmost date picker column starts with ${leftmost[0]}`);
    await page.screenshot({ path: join(shots, `date-picker-${day}.png`) });
    await panel.locator('[data-date="2026-11-26"]').focus();
    const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.date ?? null);
    for (const [key, expected] of [["Home", monday ? "2026-11-23" : "2026-11-22"], ["End", monday ? "2026-11-29" : "2026-11-28"]] as const) {
      await page.keyboard.press(key);
      for (let attempt = 0; attempt < 30 && await focused() !== expected; attempt++) await Bun.sleep(50);
      check(await focused() === expected, `${day}: ${key} focused ${await focused()}, not ${expected}`);
    }
    console.log(`week-start ok: ${day}`);
  }

  await expectWeekStart("sunday");

  await page.getByRole("button", { name: t("profile.menu"), exact: true }).click();
  await page.getByRole("menuitem", { name: t("accountPrefs.menu"), exact: true }).click();
  const choice = page.getByRole("combobox", { name: t("accountPrefs.weekStart") });
  check(await choice.inputValue() === "sunday", "the week start preference is not Sunday by default");
  await choice.selectOption("monday");
  await page.reload();
  await choice.waitFor();
  check(await choice.inputValue() === "monday", "the week start preference did not survive a reload");
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    check(((await choice.boundingBox())?.height ?? 0) >= 44, `week start control is under 44 px at ${width}x${height}`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `preferences scroll sideways at ${width}x${height}`);
    await page.screenshot({ path: join(shots, `preferences-${width}x${height}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectWeekStart("monday");
  await page.reload();
  await expectWeekStart("monday");

  await page.setViewportSize({ width: 390, height: 844 });
  await openCalendar();
  const days = calendar.getByTestId("calendar-days");
  await days.locator('[data-calendar-date="2026-11-26"]').getByRole("link", { name: "Dated" }).waitFor();
  check(!await calendar.getByTestId("calendar-month-grid").isVisible(), "the month grid shows on a phone");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "phone calendar list scrolls sideways");
  await page.screenshot({ path: join(shots, "phone-calendar-list.png") });
  console.log("week-start e2e passed");
  await browser.close();
} catch (error) { failed = true; console.error(error); }
finally {
  for (const server of servers) server.kill();
  if (slug) {
    const { client, db } = createDatabase();
    try { await db.delete(workspaces).where(eq(workspaces.slug, slug)); }
    finally { await client.end(); }
  }
}
process.exit(failed ? 1 : 0);
