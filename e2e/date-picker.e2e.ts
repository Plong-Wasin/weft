// Browser end-to-end flow for the Start and Due calendar popover on a Work item: quick picks, No date, a range picked in one calendar, overdue colouring and the keyboard.
// Run with `bun e2e/date-picker.e2e.ts` (set CHROMIUM_PATH as for the other flows; run-all.ts starts its own servers).
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3111);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5211);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
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

type Item = { id: string; displayId: string; stateId: string; startDate: string | null; dueDate: string | null };
type State = { id: string; name: string; group: string };
let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };
  const t = (key: string) => translate(key as never);

  await page.goto(web);
  await page.getByRole("button", { name: t("auth.signUp"), exact: true }).click();
  await page.getByLabel(t("auth.name")).fill("Date Tester");
  await page.getByLabel(t("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(t("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(t("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  const signedUp = page.waitForResponse((response) => response.url().includes("/api/auth/") && response.request().method() === "POST" && response.ok());
  await page.getByRole("button", { name: t("auth.signUp") }).click();
  await signedUp; // the session cookie must exist before the workspace is created
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

  console.log(`date-picker ok: ${open.displayId} ${done.displayId}`);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  process.exit(failed ? 1 : 0);
}
