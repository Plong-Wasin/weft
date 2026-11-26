// Browser check for the work item views layout (list, board, spreadsheet, calendar, gantt, filters, display, bulk bar)
// with long Thai and English names. Each named step guards one class of defect. Run with `bun e2e/run-all.ts work-item-views-layout.e2e.ts`.
import { chromium, type Locator, type Page } from "playwright";
import { translate } from "../packages/shared/src";
import { WeftClient } from "../tools/visual/weft-client";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31460);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52460);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

const t = (key: string) => translate(key as never);
const failures: string[] = [];
const step = async (name: string, run: () => Promise<void>) => {
  try { await run(); console.log(`ok - ${name}`); } catch (error) { failures.push(name); console.log(`not ok - ${name}: ${(error as Error).message}`); }
};
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

/** True for each checkbox whose box is drawn small and whose 44px square around the centre still answers as that checkbox. */
async function checkboxFaults(surface: string, checkboxes: Locator) {
  const faults: string[] = [];
  for (const box of (await checkboxes.all()).slice(0, 4)) {
    await box.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
    const fault = await box.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const name = element.getAttribute("aria-label") ?? element.closest("label")?.textContent ?? "checkbox";
      if (rect.width > 20 || rect.height > 20) return `${name} drawn ${rect.width}x${rect.height}`;
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const missed = [[-21, 0], [21, 0], [0, -21], [0, 21]].filter(([dx, dy]) => { const hit = document.elementFromPoint(cx + dx!, cy + dy!); return !hit || !(hit === element || element.contains(hit)); });
      return missed.length ? `${name} misses taps at ${JSON.stringify(missed)}` : null;
    });
    if (fault) faults.push(`${surface}: ${fault}`);
  }
  return faults;
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const client = new WeftClient(api, web);
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await client.signUp("Views Tester", `${slug}@example.test`, "a-secure-password");
  const workspace = await client.action("create_workspace", { name: "Views team", slug });
  const project = await client.action("create_project", { workspaceId: workspace.id, name: "Views", key: "VIE", visibility: "public", shape: "full" });
  const states = await client.action<any[]>("list_states", { projectId: project.id });
  const labels = [];
  for (const [name, color] of [["ฟีเจอร์ใหม่สำหรับลูกค้าองค์กร", "#3b82f6"], ["เอกสารประกอบการใช้งาน", "#10b981"], ["Design", "#a855f7"]]) labels.push(await client.action("create_label", { projectId: project.id, name, color }));
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const cycle = await client.action("create_cycle", { projectId: project.id, name: "รอบการทำงานที่ 12 Stabilisation, polish and migration validation across all surfaces", startDate: day(-3), endDate: day(10) });
  const module = await client.action("create_module", { projectId: project.id, name: "ระบบยืนยันตัวตน Authentication and access" });
  const ids: string[] = [];
  for (let index = 0; index < 8; index += 1) ids.push((await client.action("create_work_item", { projectId: project.id, title: index % 2 ? "Refactor the notification delivery pipeline so that retries back off exponentially" : "แก้ไขปัญหาการเข้าสู่ระบบไม่ได้หลังจากเปลี่ยนรหัสผ่านครั้งแรกของผู้ใช้งาน", stateId: states[index % 3].id, priority: "high", labelIds: labels.map((label) => label.id), startDate: day(-8), dueDate: day(-2) })).id);
  await client.action("add_cycle_items", { cycleId: cycle.id, workItemIds: ids });
  await client.action("add_module_items", { moduleId: module.id, workItemIds: ids });

  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const open = async (width: number, height: number, touch: boolean) => {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    await context.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));
    return context.newPage();
  };
  const go = async (page: Page, layout: string) => {
    await page.goto(`${web}/${slug}/projects/VIE/issues?layout=${layout}`);
    await page.getByText("VIE-1", { exact: true }).first().or(page.getByTestId("calendar-layout")).first().waitFor({ state: "attached" });
  };
  const toolbarOf = (page: Page) => page.getByTestId("work-items-toolbar");

  const desktop = await open(1440, 900, false);
  await step("list property columns never paint over each other (1440)", async () => {
    await go(desktop, "list");
    await desktop.locator('[data-list-property="modules"] button').first().waitFor();
    const faults = await desktop.locator("[data-list-row]").evaluateAll((rows) => rows.flatMap((row) => [...row.querySelectorAll<HTMLElement>("[data-list-property]")].filter((cell) => cell.getClientRects().length).flatMap((cell) => {
      const box = cell.getBoundingClientRect();
      return [...cell.querySelectorAll<HTMLElement>("button, button span")].filter((child) => { const rect = child.getBoundingClientRect(); return rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1) && !child.parentElement!.closest(".truncate"); })
        .map((child) => `${cell.dataset.listProperty} spills ${Math.round(child.getBoundingClientRect().width)}px into ${Math.round(box.width)}px`);
    })));
    check(faults.length === 0, [...new Set(faults)].slice(0, 6).join("; "));
  });
  await step("list dates are shown whole (1440)", async () => {
    const clipped = await desktop.locator('[data-list-property="dates"] button span.truncate').evaluateAll((spans) => spans.filter((span) => span.scrollWidth > span.clientWidth).map((span) => `${span.textContent} ${span.scrollWidth}>${span.clientWidth}`));
    check(clipped.length === 0, clipped.slice(0, 3).join("; "));
  });
  await step("list label chip never leaves a one-letter stub (1440)", async () => {
    const stubs = await desktop.locator('[data-list-property="labels"] [title]').evaluateAll((names) => names.filter((name) => name.getClientRects().length > 0 && name.classList.contains("truncate") && name.clientWidth < 16).map((name) => `${name.textContent} ${name.clientWidth}px`));
    check(stubs.length === 0, stubs.slice(0, 3).join("; "));
  });
  await step("Display selects and the Gantt zoom select look like controls (1440)", async () => {
    await go(desktop, "list");
    await toolbarOf(desktop).getByRole("button", { name: t("layout.display"), exact: true }).click();
    const borders = await desktop.getByRole("dialog", { name: t("layout.display") }).locator("select").evaluateAll((selects) => selects.map((select) => parseFloat(getComputedStyle(select).borderTopWidth)));
    check(borders.length >= 4 && borders.every((width) => width >= 1), `Display select border widths ${borders.join(",")}`);
    await go(desktop, "gantt");
    const padding = await desktop.getByRole("combobox", { name: t("layout.gantt.zoom") }).evaluate((select) => parseFloat(getComputedStyle(select).paddingRight));
    check(padding >= 24, `zoom select leaves ${padding}px for its chevron`);
  });
  await step("calendar and gantt Today buttons are both bordered (1440)", async () => {
    for (const layout of ["calendar", "gantt"]) {
      await go(desktop, layout);
      const width = await desktop.getByRole("button", { name: t("layout.calendar.today"), exact: true }).evaluate((button) => { const style = getComputedStyle(button); return style.borderTopColor === "rgba(0, 0, 0, 0)" ? 0 : parseFloat(style.borderTopWidth); });
      check(width >= 1, `${layout} Today has no visible border`);
    }
  });

  await step("long picker options grow instead of overlapping the next one (1440)", async () => {
    await go(desktop, "spreadsheet");
    await desktop.getByTestId("row-VIE-1").getByRole("button", { name: new RegExp(`^${t("workItems.cycle")}:`) }).click();
    await desktop.getByRole("menuitemradio").first().waitFor();
    const spills = await desktop.getByRole("menuitemradio").evaluateAll((options) => options.map((option) => Math.round(option.querySelector("span")!.getBoundingClientRect().height - option.getBoundingClientRect().height)));
    check(spills.length >= 2 && spills.every((spill) => spill <= 0), `option text is taller than its row by ${spills.join(",")}px`);
  });

  const tablet = await open(820, 1180, true);
  await step("calendar month cells keep quiet add buttons and the Gantt shows its timeline on a touch tablet (820)", async () => {
    await go(tablet, "calendar");
    const border = await tablet.getByTestId("calendar-month-grid").getByRole("button").first().evaluate((button) => getComputedStyle(button).borderTopColor);
    check(border === "rgba(0, 0, 0, 0)", `month cell add button border ${border}`);
    await go(tablet, "gantt");
    const width = await tablet.getByTestId("gantt-row-VIE-1").evaluate((row) => Math.round(row.firstElementChild!.getBoundingClientRect().width));
    check(width <= 200, `Gantt label column is ${width}px`);
  });

  const phone = await open(390, 844, true);
  await step("touch checkboxes stay small with a 44px tap area: spreadsheet, board, filters, display (390)", async () => {
    const faults: string[] = [];
    await go(phone, "spreadsheet");
    faults.push(...await checkboxFaults("spreadsheet", phone.getByTestId("sheet-scroll").getByRole("checkbox")));
    await go(phone, "board");
    await phone.getByTestId("board").getByRole("checkbox").first().waitFor({ state: "attached" });
    await toolbarOf(phone).locator("label").filter({ has: phone.getByRole("checkbox") }).tap();
    faults.push(...await checkboxFaults("board", phone.getByTestId("board").getByRole("checkbox")));
    await go(phone, "list");
    await toolbarOf(phone).getByRole("button", { name: t("layout.filters"), exact: true }).tap();
    const filters = phone.getByRole("dialog", { name: t("layout.filters") });
    await filters.getByRole("button", { name: t("layout.filter.state") }).tap();
    faults.push(...await checkboxFaults("filters", filters.getByRole("checkbox")));
    await go(phone, "list");
    await toolbarOf(phone).getByRole("button", { name: t("layout.display"), exact: true }).tap();
    faults.push(...await checkboxFaults("display", phone.getByRole("dialog", { name: t("layout.display") }).getByRole("checkbox")));
    check(faults.length === 0, faults.slice(0, 8).join("; "));
  });
  await step("phone Gantt shows the timeline beside the titles (390)", async () => {
    await go(phone, "gantt");
    const visible = await phone.getByTestId("gantt-row-VIE-1").evaluate((row) => {
      const scroller = row.closest(".overflow-x-auto")!.getBoundingClientRect();
      const timeline = row.lastElementChild!.getBoundingClientRect();
      return Math.round(scroller.right - timeline.left);
    });
    check(visible >= 160, `only ${visible}px of the timeline is on screen`);
  });
  await step("phone bulk bar has equal rows and does not trap the last work item under it (390)", async () => {
    await go(phone, "list");
    await toolbarOf(phone).locator("label").filter({ has: phone.getByRole("checkbox") }).tap();
    const bar = phone.getByTestId("bulk-bar");
    await bar.waitFor();
    const widths = await bar.getByTestId("bulk-actions").locator("button").evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().width)));
    check(widths.length >= 7 && Math.max(...widths) - Math.min(...widths) <= 1, `bulk action widths ${widths.join(",")}`);
    const height = (await bar.boundingBox())!.height;
    check(height <= 220, `bulk bar is ${height}px tall`);
    await phone.evaluate(() => { for (const element of [document.scrollingElement!, ...document.querySelectorAll("main, main *")]) element.scrollTop = element.scrollHeight; });
    const gap = await phone.evaluate(() => {
      const last = [...document.querySelectorAll('[data-testid="work-items-list-container"] section')].at(-1)!.getBoundingClientRect();
      return Math.round(document.querySelector('[data-testid="bulk-bar"]')!.getBoundingClientRect().top - last.bottom);
    });
    check(gap >= 0, `the last group ends ${-gap}px under the bulk bar`);
  });

  await browser.close();
} finally {
  for (const server of servers) server.kill();
}
if (failures.length) { console.error(`work-item-views-layout failed: ${failures.join(", ")}`); process.exit(1); }
console.log("work-item-views-layout ok");
process.exit(0);
