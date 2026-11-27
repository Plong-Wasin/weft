// Browser end-to-end flow for the Start and Due calendar popover on a Work item: quick picks, No date, a range picked in one calendar, overdue colouring and the keyboard.
// Run with `bun e2e/date-picker.e2e.ts` (set CHROMIUM_PATH as for the other flows; run-all.ts starts its own servers).
import { check, launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3111);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5211);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const acceptanceShotPhase = Bun.env.SHADCN_SCREENSHOT_PHASE ?? "after";
const acceptanceShots = join(process.cwd(), ".local/shots/shadcn-05", acceptanceShotPhase);
mkdirSync(acceptanceShots, { recursive: true });
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

type Item = { id: string; displayId: string; stateId: string; startDate: string | null; dueDate: string | null };
type State = { id: string; name: string; group: string };
let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };
  const t = (key: string) => translate(key as never);

  await page.goto(web);
  await page.getByRole("button", { name: t("auth.signUp"), exact: true }).click();
  await page.getByLabel(t("auth.name")).fill("Date Tester");
  await page.getByLabel(t("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(t("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(t("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  const createSignedInContext = page.waitForResponse((response) => response.url().includes("/api/auth/") && response.request().method() === "POST" && response.ok());
  await page.getByRole("button", { name: t("auth.signUp") }).click();
  await createSignedInContext; // the session cookie must exist before the workspace is created
  await page.getByLabel(t("workspace.name")).fill("Date team");
  await page.getByLabel(t("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: t("workspace.create") }).click();
  await page.getByRole("button", { name: t("projects.new"), exact: true }).click();
  await page.getByLabel(t("projects.name")).fill("Dates");
  await page.getByLabel(t("projects.key"), { exact: true }).fill("DTE");
  await page.getByRole("button", { name: t("projects.create") }).click();
  await page.getByRole("link", { name: /DTE · Dates/ }).waitFor();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId, archived: false });
  const projectId = project!.id;
  const states = await call<State[]>("list_states", { projectId });
  const completed = states.find((state) => state.group === "completed")!;
  // Dates are calendar days in the browser's zone; the test's day offsets use the same zone so the picker and the assertions agree.
  const localDay = (offset: number) => { const date = new Date(); date.setDate(date.getDate() + offset); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"); };
  const shortOf = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
  const stored = async (displayId: string) => await call<Item>("get_work_item", { workspaceId, displayId });

  const open = await call<Item>("create_work_item", { projectId, title: "Open late", dueDate: localDay(-2) });
  const done = await call<Item>("create_work_item", { projectId, title: "Finished late", dueDate: localDay(-2) });
  await call("update_work_item", { workItemId: done.id, stateId: completed.id });
  const sidebar = page.getByRole("complementary", { name: t("workItems.properties") });
  const dialog = page.locator("[data-popover-panel]"); // whichever date chip opened it
  const startChip = sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.startDate")}:`) });
  const dueChip = sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.dueDate")}:`) });
  // Arms the wait for the save before the click, so a fast response cannot be missed.
  const saveAfter = async (click: () => Promise<unknown>) => { const saved = page.waitForResponse((response) => response.url().includes("update_work_item") && response.ok()); await click(); await saved; };
  // Moves the calendar forward until the day is on screen, then picks it.
  const pickDay = async (offset: number) => {
    const day = localDay(offset);
    const next = dialog.getByRole("button", { name: t("datePicker.nextMonth") });
    for (let turn = 0; turn < 3 && await dialog.locator(`[data-date="${day}"]`).count() === 0; turn += 1) await next.click();
    await dialog.locator(`[data-date="${day}"]`).click();
  };

  // 1. Overdue Due date is red; a completed Work item with a past Due is not overdue.
  await page.goto(`${web}/${slug}/browse/DTE-1`);
  await sidebar.waitFor();
  const overdueMark = sidebar.getByTitle(t("datePicker.overdue"), { exact: true });
  check(await overdueMark.count() === 1, `open item with a past Due should show the overdue mark once: ${JSON.stringify(await stored("DTE-1"))} chip=${await dueChip.evaluate((el) => el.outerHTML)} localDay=${localDay(-2)}`);
  await overdueMark.hover();
  check(await overdueMark.getAttribute("title") === t("datePicker.overdue"), "hovering the overdue Due mark should keep its Overdue tooltip");
  check(await sidebar.getByRole("button", { name: new RegExp(`, ${t("datePicker.overdue")}$`) }).count() === 1, "the overdue Due chip has no accessible name that says Overdue");
  check((await dueChip.textContent())?.includes(shortOf(localDay(-2))) === true, `Due chip should read the short date ${shortOf(localDay(-2))}`);

  // Acceptance screenshots show the calendar popover at every specified viewport and theme.
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 1180], [768, 1024], [844, 390], [667, 375], [390, 844]] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => { localStorage.setItem("weft.theme", value); document.documentElement.setAttribute("data-theme", value); }, theme);
      await page.goto(`${web}/${slug}/browse/DTE-1`);
      await sidebar.waitFor();
      const shotTrigger = sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.startDate")}:`) });
      await shotTrigger.click();
      await dialog.waitFor();
      const pageWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      check(pageWidth.scrollWidth <= pageWidth.innerWidth, `horizontal page scroll at ${width}x${height} ${theme}: ${JSON.stringify(pageWidth)}`);
      await page.screenshot({ path: join(acceptanceShots, `date-picker-${width}x${height}-${theme}.png`) });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { localStorage.setItem("weft.theme", "light"); document.documentElement.setAttribute("data-theme", "light"); });
  await page.goto(`${web}/${slug}/browse/DTE-1`);
  await sidebar.waitFor();

  await page.goto(`${web}/${slug}/browse/DTE-2`);
  await sidebar.waitFor();
  // The State list loads after the item; wait for the completed name so the overdue check sees the final state.
  await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.state")}:`) }).filter({ hasText: completed.name }).waitFor();
  check(await sidebar.getByTitle(t("datePicker.overdue")).count() === 0, "completed item must not be marked overdue");
  console.log("date-picker: overdue red only for open items");

  // 2. Quick picks set the active field; No date clears both.
  await page.goto(`${web}/${slug}/browse/DTE-1`);
  await sidebar.waitFor();
  await startChip.click();
  await dialog.waitFor();
  const quick = (name: string) => saveAfter(() => dialog.getByRole("button", { name, exact: true }).click());
  await quick(t("datePicker.today"));
  await quick(t("datePicker.tomorrow"));
  await dialog.getByRole("button", { name: t("workItems.dueDate") }).click();
  const now = new Date();
  const ahead = ((1 - now.getDay() + 7) % 7) || 7; // days until the next Monday, never 0
  await quick(t("datePicker.nextWeek"));
  await page.keyboard.press("Escape");
  let saved = await stored("DTE-1");
  check(saved.startDate === localDay(1), `Tomorrow quick pick should set Start, got ${saved.startDate}`);
  check(saved.dueDate === localDay(ahead), `Next week quick pick should set Due to the next Monday, got ${saved.dueDate}`);
  console.log("date-picker: quick picks set Start and Due");

  await startChip.click();
  await dialog.waitFor();
  await saveAfter(() => dialog.getByRole("button", { name: t("datePicker.noDate"), exact: true }).click());
  await page.keyboard.press("Escape");
  saved = await stored("DTE-1");
  check(saved.startDate === null && saved.dueDate === null, `No date should clear both, got ${saved.startDate}/${saved.dueDate}`);
  console.log("date-picker: No date clears both");

  // 3. A range picked in one calendar saves both dates.
  await startChip.click();
  await dialog.waitFor();
  await saveAfter(() => pickDay(1)); // Start; the Due becomes the active field
  await saveAfter(() => pickDay(4)); // Due
  await page.keyboard.press("Escape");
  saved = await stored("DTE-1");
  check(saved.startDate === localDay(1) && saved.dueDate === localDay(4), `range should save both dates, got ${saved.startDate}/${saved.dueDate}`);
  await page.reload();
  await sidebar.waitFor();
  check((await startChip.textContent())?.includes(shortOf(localDay(1))) === true, "Start chip should show the saved short date after reload");
  check((await dueChip.textContent())?.includes(shortOf(localDay(4))) === true, "Due chip should show the saved short date after reload");
  check(await sidebar.getByTitle(t("datePicker.overdue")).count() === 0, "a future Due must not be red");
  console.log("date-picker: a range saves Start and Due and survives reload");

  // 4. Keyboard: arrows move the focus between days, Enter picks the focused day.
  await dueChip.click();
  await dialog.waitFor();
  await dialog.locator(`[data-date="${localDay(4)}"]`).focus();
  await page.keyboard.press("ArrowRight");
  check(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.date) === localDay(5), "ArrowRight should move focus to the next day");
  await saveAfter(() => page.keyboard.press("Enter"));
  check((await stored("DTE-1")).dueDate === localDay(5), "Enter on a focused day should set Due");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  console.log("date-picker: keyboard moves and picks, Escape closes");

  // 5. Thai: the calendar shows and takes the same Buddhist-era year as the date text everywhere else; the stored value stays ISO.
  const th = (key: string) => translate(key as never, "th");
  const thaiItem = await call<Item>("create_work_item", { projectId, title: "Thai year", dueDate: "2030-05-06" });
  await call("set_my_locale", { locale: "th" }); // the saved account language wins over the browser copy
  await page.evaluate(() => localStorage.setItem("weft.locale", "th"));
  await page.goto(`${web}/${slug}/browse/${thaiItem.displayId}`);
  const thaiDue = page.getByRole("complementary", { name: th("workItems.properties") }).getByRole("button", { name: new RegExp(`^${th("workItems.dueDate")}:`) });
  await thaiDue.waitFor();
  const thaiChipText = (await thaiDue.textContent()) ?? "";
  check(thaiChipText.includes("2573"), `the Thai Due chip should show 2030 as the Buddhist-era year 2573, shows "${thaiChipText}"`);
  await thaiDue.click();
  await dialog.waitFor();
  const thaiYear = dialog.getByRole("spinbutton", { name: "ปี" });
  check(await thaiYear.inputValue() === "2573" && thaiChipText.includes(await thaiYear.inputValue()), `the calendar year must equal the year the app shows (2573), shows ${await thaiYear.inputValue()}`);
  const thaiGridName = await dialog.locator("[data-month]").getAttribute("aria-label") ?? "";
  check(thaiGridName.includes("2573") && !thaiGridName.includes("2030"), `the Thai calendar grid must be named with the Buddhist-era year, is "${thaiGridName}"`);
  await thaiYear.fill("2574"); // the next Thai year is 2031
  check(await dialog.locator("[data-month]").getAttribute("data-month") === "2031-05", "typing the Thai year 2574 must move the calendar to May 2031");
  await saveAfter(() => dialog.locator('[data-date="2031-05-07"]').click());
  check((await stored(thaiItem.displayId)).dueDate === "2031-05-07", "a day picked in Thai must store the ISO (Gregorian) date");
  await page.keyboard.press("Escape");
  await thaiDue.filter({ hasText: "2574" }).waitFor({ timeout: 5_000 }).catch(async () => check(false, `after the pick the Thai Due chip should show 2574, shows "${await thaiDue.textContent()}"`));
  await call("set_my_locale", { locale: "en" });
  await page.evaluate(() => localStorage.setItem("weft.locale", "en"));
  console.log("date-picker: Thai calendar shows and takes the Buddhist-era year");

  // 6. Time zones far from UTC: the chip shows the stored calendar day, and a picked day is stored as that same day.
  for (const [timezoneId, picked] of [["America/Los_Angeles", "2031-05-09"], ["Pacific/Kiritimati", "2031-05-11"]] as const) {
    const zoned = await newContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId, storageState: await context.storageState() });
    const zonedPage = await zoned.newPage();
    await zonedPage.goto(`${web}/${slug}/browse/${thaiItem.displayId}`);
    const zonedDue = zonedPage.getByRole("complementary", { name: t("workItems.properties") }).getByRole("button", { name: new RegExp(`^${t("workItems.dueDate")}:`) });
    await zonedDue.waitFor();
    const before = (await stored(thaiItem.displayId)).dueDate!;
    check(((await zonedDue.textContent()) ?? "").includes(shortOf(before)), `${timezoneId}: the Due chip should show ${shortOf(before)}, shows "${await zonedDue.textContent()}"`);
    await zonedDue.click();
    const zonedPanel = zonedPage.locator("[data-popover-panel]");
    await zonedPanel.waitFor();
    const zonedSaved = zonedPage.waitForResponse((response) => response.url().includes("update_work_item") && response.ok());
    await zonedPanel.locator(`[data-date="${picked}"]`).click();
    await zonedSaved;
    check((await stored(thaiItem.displayId)).dueDate === picked, `${timezoneId}: picking ${picked} must store ${picked}`);
    await zonedPage.reload();
    await zonedDue.waitFor();
    check(((await zonedDue.textContent()) ?? "").includes(shortOf(picked)), `${timezoneId}: after reload the Due chip should show ${shortOf(picked)}`);
    await zoned.close();
  }
  console.log("date-picker: far time zones keep the calendar day");

  // A read-only Work item keeps the Due field context and overdue name without relying on a button role.
  const readOnlyItem = await call<Item>("create_work_item", { projectId, title: "Read-only overdue", dueDate: localDay(-2) });
  await page.route("**/actions/list_projects", async (route) => {
    const response = await route.fetch();
    const projects = await response.json() as Array<Record<string, unknown>>;
    await route.fulfill({ response, json: projects.map((candidate) => candidate.id === projectId ? { ...candidate, role: "Guest" } : candidate) });
  });
  await page.goto(`${web}/${slug}/browse/${readOnlyItem.displayId}`);
  await sidebar.waitFor();
  const readOnlyDueName = `${t("workItems.dueDate")}: ${shortOf(localDay(-2))}, ${t("datePicker.overdue")}`;
  const readOnlyDue = sidebar.getByRole("button", { name: readOnlyDueName });
  await readOnlyDue.waitFor();
  const readOnlyOverdueMark = readOnlyDue.getByTitle(t("datePicker.overdue"), { exact: true });
  check(await readOnlyOverdueMark.count() === 1, "read-only overdue Due should retain its Overdue tooltip");
  await readOnlyOverdueMark.hover();
  check(await readOnlyOverdueMark.getAttribute("title") === t("datePicker.overdue"), "read-only Due hover should still explain that the date is overdue");
  await readOnlyDue.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: readOnlyDueName }).getByText(readOnlyDueName, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  console.log("date-picker: overdue Due field keeps its accessible context when read-only");

  const touchContext = await newContext(browser, { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(`${web}/${slug}/browse/DTE-1`);
  const touchSidebar = touchPage.getByRole("complementary", { name: t("workItems.properties") });
  const touchStartChip = touchSidebar.getByRole("button", { name: new RegExp(`^${t("workItems.startDate")}:`) });
  await touchStartChip.tap();
  const touchCalendar = touchPage.locator("[data-popover-panel]");
  await touchCalendar.waitFor();
  const touchTargets = await touchPage.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { width: rect.width, height: rect.height } : null;
    };
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      trigger: bounds('button[aria-label^="Start date:"]'),
      quickPick: bounds('[data-popover-panel] button'),
      day: bounds('[data-popover-panel] [data-date]'),
      nextMonth: bounds('[data-popover-panel] button[aria-label="Next month"]'),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  check(touchTargets.coarse, `phone landscape did not use a coarse pointer: ${JSON.stringify(touchTargets)}`);
  const targetSizes = [touchTargets.trigger, touchTargets.quickPick, touchTargets.day, touchTargets.nextMonth];
  check(targetSizes.every((target) => target !== null && target.width >= 44 && target.height >= 44), `a date picker touch target is under 44px: ${JSON.stringify(touchTargets)}`);
  check(touchTargets.scrollWidth <= touchTargets.innerWidth, `horizontal page scroll in touch date picker: ${JSON.stringify(touchTargets)}`);
  await touchPage.screenshot({ path: join(acceptanceShots, "date-picker-844x390-touch-light.png") });
  await touchPage.keyboard.press("Escape");
  await touchContext.close();

  console.log(`date-picker ok: ${open.displayId} ${done.displayId}`);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  process.exit(failed ? 1 : 0);
}
