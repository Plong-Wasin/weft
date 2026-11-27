import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { translate } from "../packages/shared/src";
import { seedWeft, WeftClient } from "../tools/visual/weft-client";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 33150);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 35150);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web, { env: { ...Bun.env, WEFT_AI_ENABLED: "true", OPENAI_API_KEY: "sk-e2e-placeholder-no-call" } }),
  startWeb(webPort, { api }),
];
const viewports = [
  { width: 1440, height: 900, touch: false },
  { width: 1024, height: 768, touch: true },
  { width: 820, height: 1180, touch: true },
  { width: 768, height: 1024, touch: true },
  { width: 844, height: 390, touch: true },
  { width: 667, height: 375, touch: true },
  { width: 390, height: 844, touch: true },
];
const longThai = "ตรวจสอบการตั้งค่าการแจ้งเตือนและกำหนดเวลาสำหรับสมาชิกทุกคนในเวิร์กสเปซก่อนเผยแพร่แผนการเปิดตัว";
const longEnglish = "Review the notification preferences and verify the schedule for all workspace members before publishing the rollout plan";
const shots = Bun.env.LAYOUT_STABILITY_SHOTS_DIR ?? ".local/shots/shadcn-finish-04/after";
const limit = 0.02;
const failures: string[] = [];
const measurements: Array<{ label: string; cls: number }> = [];
const screenshotScreens = new Set(["list", "spreadsheet", "calendar", "gantt", "detail", "peek", "intake", "settings", "auth", "one-item"]);

type ShiftEntry = PerformanceEntry & {
  value: number;
  hadRecentInput: boolean;
  sources: Array<{ node: Node | null }>;
};

type StabilityWindow = Window & { readLayoutShifts: () => Array<{ at: number; score: number; sources: string[] }> };

function observeLayoutShifts() {
  const shifts: ReturnType<StabilityWindow["readLayoutShifts"]> = [];
  const record = (entries: PerformanceEntry[]) => {
    for (const { startTime, value, hadRecentInput, sources } of entries as ShiftEntry[]) {
      if (hadRecentInput) continue;
      shifts.push({
        at: startTime,
        score: value,
        sources: sources.map(({ node }) => node instanceof Element ? node.getAttribute("data-testid") ?? node.tagName.toLowerCase() + "." + String(node.className).slice(0, 90) : node?.parentElement?.tagName ?? "unknown"),
      });
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  observer.observe({ type: "layout-shift", buffered: true });
  (window as StabilityWindow).readLayoutShifts = () => {
    record(observer.takeRecords());
    return shifts;
  };
}

async function seedWorkspace(client: WeftClient, slug: string) {
  const seed = await seedWeft(client, slug);
  const cookie = client.cookies().map(({ name, value }) => `${name}=${value}`).join("; ");
  const me = await (await fetch(`${api}/api/me`, { headers: { cookie } })).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const projects = await client.action<Array<{ id: string }>>("list_projects", { workspaceId });
  const projectId = projects[0]!.id;
  const states = await client.action<Array<{ id: string; group: string }>>("list_states", { projectId });
  const state = states.find(({ group }) => group === "unstarted");
  if (!state) throw new Error("Fixture project has no unstarted state");
  const labels = await Promise.all(["Security", "Integration", "Frontend", "Documentation", "Performance", "Accessibility"].map((name) =>
    client.action<{ id: string }>("create_label", { projectId, name }),
  ));
  const today = new Date().toISOString().slice(0, 10);
  // Keep the real workspace/project Actions in the fixture so normal access, pagination and rendering still apply.
  const richItems = [
    { title: longThai, labelIds: labels.map(({ id }) => id), assigneeIds: [me.user.id], startDate: today, dueDate: today, priority: "urgent" },
    { title: longEnglish, priority: "high" },
  ];
  const create = (fields: Record<string, unknown>) =>
    client.action<{ id: string; displayId: string }>("create_work_item", { projectId, stateId: state.id, ...fields });
  const thai = await create(richItems[0]!);
  const english = await create(richItems[1]!);
  for (let index = 8; index < 200; index += 1) {
    await create({ title: `Item ${index + 1}${index === 8 ? ` https://example.test/${"longsegment".repeat(14)}` : ""}` });
  }
  const single = await client.action<{ id: string }>("create_project", { workspaceId, key: "ONE", name: longThai, visibility: "public" });
  await client.action("create_project", { workspaceId, key: "EMPTY", name: longEnglish.slice(0, 100), visibility: "public" });
  const one = await client.action<{ displayId: string }>("create_work_item", { projectId: single.id, title: longThai });
  for (const title of [longThai, longEnglish, "Short Intake request"]) {
    await client.action("submit_intake_item", { projectId, title });
  }
  // Three or more of each, with mixed content, so equal row heights can be compared.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await client.action("create_cycle", { projectId, name: longEnglish.slice(0, 90), startDate: day(20), endDate: day(30) });
  await client.action("create_cycle", { projectId, name: longThai.slice(0, 90), startDate: day(40), endDate: day(50) });
  await client.action("create_cycle", { projectId, name: "Sprint 2", startDate: day(60), endDate: day(70) });
  await client.action("create_module", { projectId, name: longEnglish.slice(0, 90) });
  await client.action("create_module", { projectId, name: longThai.slice(0, 90), leadId: me.user.id });
  await client.action("create_view", { projectId, name: longEnglish.slice(0, 90), description: longEnglish, query: "priority = high", layout: "list" });
  await client.action("create_view", { projectId, name: longThai.slice(0, 90), query: "priority = low", layout: "list" });
  return { ...seed, thai, english, one };
}

const frame = (page: Page) => page.evaluate(() => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
));
const heading = (page: Page | Locator, name: string) => page.getByRole("heading", { name, exact: true }).first();
const testId = (id: string) => (page: Page) => page.getByTestId(id);

async function equalHeights(rows: Locator, label: string) {
  const heights = await rows.evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().height));
  if (heights.length < 3 || Math.max(...heights) - Math.min(...heights) > 1) {
    failures.push(`${label} row heights: ${[...new Set(heights)].join(", ")}px across ${heights.length} rows`);
  }
}

/** Every box in `elements` stays put (within half a pixel) across hover, focus and menu changes. */
async function holdsStill(page: Page, elements: Locator[], label: string) {
  const bounds = () => Promise.all(elements.map((element) => element.boundingBox()));
  const before = await bounds();
  return async (state: string) => {
    await frame(page);
    const after = await bounds();
    if (before.some((box, index) => {
      const next = after[index];
      return !box || !next || (["x", "y", "width", "height"] as const).some((key) => Math.abs(box[key] - next[key]) > 0.5);
    })) failures.push(`${label} ${state} moved controls or rows: ${JSON.stringify({ before, after })}`);
  };
}

async function rowPropertyMenu(page: Page, rowId: string, neighbourId: string, label: string, touch: boolean) {
  const row = page.getByTestId(rowId);
  const trigger = row.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) });
  await row.scrollIntoViewIfNeeded();
  const compare = await holdsStill(page, [row, page.getByTestId(neighbourId), trigger], label);
  if (!touch) {
    await trigger.hover();
    await compare("row control hover");
    await page.mouse.move(0, 0);
  }
  await trigger.focus();
  await compare("row control focus");
  await page.keyboard.press("Enter");
  const menu = page.locator("[data-popover-panel]");
  await menu.waitFor({ timeout: 4000 });
  await compare("row property menu open");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 4000 });
  await compare("row property menu close");
}

async function spreadsheetHover(page: Page, label: string) {
  const rows = page.locator("tbody tr");
  const compare = await holdsStill(page, [page.locator("thead"), rows.nth(0), rows.nth(1), rows.nth(2)], label);
  await rows.nth(1).hover();
  await compare("spreadsheet row hover");
  await page.mouse.move(0, 0);
}

/** A title sits level with the work item ID beside it, whether it takes one line or two. */
async function titlesCentred(page: Page, label: string) {
  const off = await page.locator("[data-list-row]").evaluateAll((rows) => rows.slice(0, 12).flatMap((row) => {
    const displayId = ((row as HTMLElement).dataset.testid ?? "").replace(/^row-/, "");
    const id = [...row.querySelectorAll<HTMLElement>("span")].find((span) => span.children.length === 0 && span.textContent?.trim() === displayId);
    const title = row.querySelector<HTMLElement>("a[href]");
    if (!id || !title) return [{ displayId, delta: null }];
    const range = document.createRange();
    range.selectNodeContents(title);
    const clip = title.getBoundingClientRect();
    const lines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.top < clip.bottom - 2);
    // Phones put the ID on the second line; the checkbox shares the title's line there.
    const beside = window.innerWidth < 640 ? row.querySelector<HTMLElement>('[role="checkbox"]') ?? id : id;
    const idBox = beside.getBoundingClientRect();
    const delta = (Math.min(...lines.map((rect) => rect.top)) + Math.max(...lines.map((rect) => rect.bottom))) / 2 - (idBox.top + idBox.bottom) / 2;
    return Math.abs(delta) > 3 ? [{ displayId, delta }] : [];
  }));
  if (off.length) failures.push(`${label} titles off centre: ${JSON.stringify(off.slice(0, 4))}`);
}

/** A phone chip strip that holds more than it shows fades its edge; one that fits does not. */
async function stripsFaded(page: Page, label: string) {
  const strips = await page.getByTestId("phone-property-strip").evaluateAll((elements) => elements.map((el) => ({
    overflows: el.scrollWidth > el.clientWidth + 1,
    faded: getComputedStyle(el).maskImage !== "none",
  })));
  if (!strips.some((strip) => strip.overflows)) failures.push(`${label} fixture has no overflowing chip strip`);
  const wrong = strips.filter((strip) => strip.overflows !== strip.faded);
  if (wrong.length) failures.push(`${label} ${wrong.length} chip strips with a wrong edge fade: ${JSON.stringify(wrong[0])}`);
}

/** Static chrome shows while data is still on its way: hold each request and look at what is already there. */
async function heldRequests(browser: Browser, client: WeftClient, slug: string, project: string, displayId: string, workItemId: string) {
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
  const hold = async (pattern: string) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    await context.route(pattern, async (route) => { await released; await route.continue(); });
    return async () => { release(); await context.unrouteAll({ behavior: "wait" }); };
  };
  const step = async (label: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) { failures.push(`held ${label}: ${String(error).split("\n")[0]}`); }
    await context.unrouteAll({ behavior: "ignoreErrors" });
  };
  const page = await context.newPage();
  const seen = (locator: Locator) => locator.waitFor({ timeout: 4000 });

  await step("sign-in settings", async () => {
    const release = await hold("**/api/auth/settings");
    await page.goto(web, { waitUntil: "domcontentloaded" });
    const title = heading(page, translate("app.welcome"));
    await seen(title);
    await seen(page.getByRole("combobox", { name: translate("language.label") }).or(page.getByRole("button", { name: translate("language.label") })).first());
    const before = await title.boundingBox();
    await release();
    await seen(page.getByRole("textbox", { name: translate("auth.email") }));
    const after = await title.boundingBox();
    if (Math.abs((before?.y ?? 0) - (after?.y ?? 99)) > 1) failures.push(`held sign-in settings: heading moved ${before?.y} -> ${after?.y}`);
  });

  await context.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));

  await step("favourites", async () => {
    await hold("**/actions/list_favorite_wiki_pages");
    await page.goto(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
    const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });
    for (const name of [translate("nav.home"), translate("views.title"), translate("cycles.activeTitle")]) await seen(sidebar.getByRole("link", { name, exact: true }));
    await seen(sidebar.getByTestId("sidebar-skeleton"));
  });

  await step("work items", async () => {
    await hold("**/actions/list_work_items");
    await page.goto(`${web}${project}/issues?layout=list`, { waitUntil: "domcontentloaded" });
    const skeleton = page.getByTestId("work-items-skeleton");
    await seen(skeleton);
    const box = await skeleton.boundingBox();
    if (!box || box.height < 400) failures.push(`held work items: skeleton reserves only ${box?.height}px`);
  });

  await step("invalid first query", async () => {
    await page.goto(`${web}${project}/issues?layout=list&q=${encodeURIComponent("priority = = (")}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("alert").first().waitFor({ timeout: 4000 });
    await page.waitForTimeout(500);
    if (await page.getByText(translate("account.loadFailed")).count()) failures.push("held invalid first query: a general load failure shows beside the query error");
  });

  await step("detail reload", async () => {
    await page.goto(`${web}/${slug}/browse/${displayId}`, { waitUntil: "domcontentloaded" });
    const priority = (value: "urgent" | "low") => page.getByRole("button", { name: `${translate("workItems.priority")}: ${translate(`workItems.priority.${value}`)}` }).first();
    await seen(priority("urgent"));
    await hold("**/actions/list_work_items");
    await client.action("update_work_item", { workItemId, priority: "low" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await seen(priority("low"));
    await client.action("update_work_item", { workItemId, priority: "urgent" });
  });
  await context.close();
}

async function fixedGeometry(page: Page, rowId: string, neighbourId: string, label: string, touch: boolean) {
  const toolbar = page.getByTestId("work-items-toolbar");
  const trigger = toolbar.getByRole("button", { name: translate("layout.display") });
  const menu = page.getByRole("dialog", { name: translate("layout.display") });
  const row = page.getByTestId(rowId);
  const neighbour = page.getByTestId(neighbourId);
  const controls = [toolbar, trigger, row, neighbour];
  const bounds = () => Promise.all(controls.map((element) => element.boundingBox()));
  if (!touch) {
    await row.scrollIntoViewIfNeeded();
    const resting = await bounds();
    await row.hover();
    await frame(page);
    if (JSON.stringify(resting) !== JSON.stringify(await bounds())) failures.push(`${label} row hover moved its neighbours`);
    await page.mouse.move(0, 0);
  }
  await trigger.scrollIntoViewIfNeeded();
  const before = await bounds();
  async function compare(state: string) {
    await frame(page);
    const after = await bounds();
    if (before.some((box, index) => {
      const next = after[index];
      return !box || !next || (["x", "y", "width", "height"] as const).some((key) => Math.abs(box[key] - next[key]) > 0.5);
    })) failures.push(`${label} ${state} moved controls or rows: ${JSON.stringify({ before, after })}`);
  }
  if (!touch) {
    await trigger.hover();
    await compare("hover");
    await page.mouse.move(0, 0);
  }
  await trigger.press("Tab");
  await page.keyboard.press("Shift+Tab");
  if (!(await trigger.evaluate((el) => el.matches(":focus-visible")))) failures.push(`${label} Display button lacks visible keyboard focus`);
  await compare("keyboard focus");
  await page.keyboard.press("Enter");
  await menu.waitFor({ timeout: 4000 });
  await compare("menu open");
  const box = await menu.boundingBox();
  const viewport = page.viewportSize()!;
  if (!box || box.x < -1 || box.y < -1 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
    failures.push(`${label} Display menu crosses the viewport: ${JSON.stringify(box)}`);
  }
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 4000 });
  await compare("menu close");
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await mkdir(shots, { recursive: true });
  const slug = `stability-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  const seed = await seedWorkspace(client, slug);
  const base = `/${slug}`;
  const project = `${base}/projects/${seed.key}`;
  const issues = `${project}/issues`;
  const projectName = "Reference";
  const projectReady = (page: Page) => page.locator("main").getByRole("link", { name: new RegExp(projectName) }).first();
  const thaiRow = `row-${seed.thai.displayId}`;
  const englishRow = `row-${seed.english.displayId}`;
  const screens: Array<{ name: string; path: string; ready: (page: Page) => Locator; guest?: boolean }> = [
    { name: "home", path: base, ready: projectReady },
    { name: "projects", path: `${base}/projects`, ready: projectReady },
    { name: "list", path: `${issues}?layout=list`, ready: testId(thaiRow) },
    { name: "board", path: `${issues}?layout=board`, ready: testId(`card-${seed.thai.displayId}`) },
    { name: "spreadsheet", path: `${issues}?layout=spreadsheet`, ready: testId(thaiRow) },
    { name: "calendar", path: `${issues}?layout=calendar`, ready: (page) => page.getByTestId("calendar-layout").getByRole("link", { name: longThai, exact: true }) },
    { name: "gantt", path: `${issues}?layout=gantt`, ready: testId(`gantt-row-${seed.thai.displayId}`) },
    { name: "detail", path: `${base}/browse/${seed.thai.displayId}`, ready: (page) => heading(page, longThai) },
    { name: "peek", path: `${issues}?layout=list&peek=${seed.thai.displayId}`, ready: (page) => heading(page.getByRole("dialog", { name: translate("workItems.peek.title") }), longThai) },
    { name: "cycles", path: `${project}/cycles`, ready: (page) => page.locator("main").getByText("Sprint 1", { exact: true }).first() },
    { name: "modules", path: `${project}/modules`, ready: (page) => page.locator("main").getByText("Authentication", { exact: true }).first() },
    { name: "views", path: `${project}/views`, ready: (page) => page.getByRole("link", { name: "High priority", exact: true }).first() },
    { name: "wiki", path: `${base}/wiki/${seed.wikiPageId}`, ready: (page) => page.getByRole("navigation", { name: translate("wiki.breadcrumb") }).getByText("Getting started", { exact: true }) },
    { name: "inbox", path: `${base}/notifications`, ready: (page) => page.getByText(translate("inbox.empty"), { exact: true }) },
    { name: "intake", path: `${project}/intake`, ready: testId("intake-open-count") },
    { name: "analytics", path: `${base}/analytics/overview`, ready: (page) => heading(page, translate("analytics.projectList")) },
    { name: "ai", path: `${base}/ai`, ready: (page) => page.getByPlaceholder(translate("ai.placeholder")) },
    { name: "settings", path: `${base}/settings`, ready: (page) => heading(page, translate("settings.workspaceTitle")) },
    { name: "auth", path: "/", ready: (page) => page.getByRole("textbox", { name: translate("auth.email") }), guest: true },
    { name: "one-item", path: `${base}/projects/ONE/issues?layout=list`, ready: testId(`row-${seed.one.displayId}`) },
    { name: "empty-project", path: `${base}/projects/EMPTY/issues?layout=list`, ready: (page) => page.getByText(translate("workItems.empty"), { exact: true }) },
  ];
  const browser = await launchBrowser();
  try {
    for (const { width, height, touch } of viewports) {
      for (const colorScheme of ["light", "dark"] as const) {
        const viewport = { width, height };
        const context = await newContext(browser, { viewport, colorScheme, hasTouch: touch, isMobile: touch, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
        await context.addInitScript(observeLayoutShifts);
        const page = await context.newPage();
        for (const screen of screens) {
          const label = `${screen.name}-${width}x${height}-${colorScheme}`;
          await context.clearCookies();
          if (!screen.guest) await context.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));
          const previousFailures = failures.length;
          try {
            await page.goto(`${web}${screen.path}`, { waitUntil: "domcontentloaded", timeout: 12000 });
            await screen.ready(page).waitFor({ timeout: 5000 });
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            await frame(page);
            const result = await page.evaluate(() => ({
              theme: document.documentElement.dataset.theme,
              viewport: document.documentElement.clientWidth,
              pageWidth: document.documentElement.scrollWidth,
              shifts: (window as StabilityWindow).readLayoutShifts(),
            }));
            // Use the largest CLS session window (one-second gap, five-second duration).
            let start = 0;
            let last = 0;
            let session = 0;
            let largest = 0;
            for (const { at, score } of result.shifts) {
              if (at - last > 1000 || at - start > 5000) { start = at; session = 0; }
              session += score;
              last = at;
              largest = Math.max(largest, session);
            }
            measurements.push({ label, cls: largest });
            if (largest > limit) failures.push(`${label} layout shift ${largest.toFixed(4)} > ${limit}: ${JSON.stringify(result.shifts)}`);
            const main = await page.evaluate(() => [...document.querySelectorAll("main")].map((el) => ({ scroll: el.scrollWidth, client: el.clientWidth })));
            if (main.some((box) => box.scroll > box.client)) failures.push(`${label} main scrolls sideways: ${JSON.stringify(main)}`);
            if (result.theme !== colorScheme || result.pageWidth > result.viewport) failures.push(`${label} theme or viewport: ${JSON.stringify(result)}`);
            if (screen.name === "list") {
              const rows = page.locator("[data-list-row]");
              const count = await rows.count();
              if (count !== 200) failures.push(`${label} rendered ${count} of 200 work items`);
              await equalHeights(rows, label);
              await titlesCentred(page, label);
              if (width < 640) await stripsFaded(page, label);
              await fixedGeometry(page, thaiRow, englishRow, label, touch);
              await rowPropertyMenu(page, thaiRow, englishRow, label, touch);
            }
            if (screen.name === "home" || screen.name === "projects") await equalHeights(page.locator("[data-project-row]"), label);
            if (screen.name === "spreadsheet") {
              await equalHeights(page.locator("tbody tr"), label);
              if (!touch) await spreadsheetHover(page, label);
            }
            if (screen.name === "cycles") {
              await page.getByRole("tab", { name: new RegExp(`^${translate("cycles.status.upcoming")}`) }).click();
              await page.getByText("Sprint 2", { exact: true }).waitFor({ timeout: 4000 });
              await equalHeights(page.getByTestId("cycle-row"), label);
            }
            if (screen.name === "modules") await equalHeights(page.locator('[data-testid^="module-row-"]'), label);
            if (screen.name === "views") await equalHeights(page.locator('[data-testid^="view-row-"]'), label);
            if (screen.name === "intake") await equalHeights(page.locator('[data-testid^="intake-"][data-slot="button"]'), label);
            if (screen.name === "one-item" && await page.locator("[data-list-row]").count() !== 1) failures.push(`${label} did not render exactly one item`);
          } catch (error) {
            failures.push(`${label}: ${String(error)}`);
          }
          if (failures.length !== previousFailures || screenshotScreens.has(screen.name)) {
            await page.screenshot({ path: join(shots, `${label}.png`), timeout: 8000 });
          }
        }
        console.log(`layout stability: checked ${screens.length} screens at ${width}x${height} ${colorScheme}`);
        await context.close();
      }
    }
    await heldRequests(browser, client, slug, project, seed.thai.displayId, seed.thai.id);
  } finally {
    await browser.close();
  }
  await Bun.write(join(shots, "measurements.json"), JSON.stringify({ measurements, failures }, null, 2));
  if (failures.length) throw new Error(`${failures.length} layout stability defects:\n${failures.join("\n")}`);
  console.log("layout stability: navigation CLS, equal row heights, stable hover/focus/menu geometry and viewport fit");
} finally {
  for (const server of servers) server.kill();
  await Promise.all(servers.map((server) => server.exited));
}
