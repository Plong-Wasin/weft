// Browser end-to-end flow for the work item peek panel, full page, inline property editing and the create modal.
// Run with `bun e2e/work-item-peek.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";
import { comments, createDatabase } from "../packages/db/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("07-work-item-peek-and-detail");
const uxShots = reviewShots("12-work-items-ux");
const runPeekShots = "/home/plong/workspace/weft/.local/ai-ux-reliability/09";
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

type Item = { id: string; displayId: string; title: string; stateId: string; priority: string; assigneeIds: string[]; labelIds: string[]; parentId: string | null; startDate: string | null; dueDate: string | null; description: unknown };
let failed = false;
let fixtureClient: ReturnType<typeof createDatabase>["client"] | undefined;
try {
  await Bun.$`mkdir -p ${runPeekShots}`;
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };
  const t = translate as (key: string) => string;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Peek Tester");
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

  const me = await (await context.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const projectId = project!.id;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const label = await call<{ id: string }>("create_label", { projectId, name: "Bug" });
  const cycle = await call<{ id: string }>("create_cycle", { projectId, name: "Sprint 1", startDate: day(-1), endDate: day(6) });
  const module = await call<{ id: string }>("create_module", { projectId, name: "Auth" });
  const alpha = await call<Item>("create_work_item", { projectId, title: "Alpha" });
  await call<Item>("create_work_item", { projectId, title: "Bravo" });
  await call("add_cycle_items", { cycleId: cycle.id, workItemIds: [alpha.id] });
  await call("add_module_items", { moduleId: module.id, workItemIds: [alpha.id] });
  const stored = async (displayId: string) => await call<Item>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId });
  const peek = page.getByRole("dialog", { name: translate("workItems.peek.title") });
  const base = `${web}/${slug}/projects/MOB`;

  // Peek opens from the list and closes with Escape.
  await page.goto(`${base}/issues`);
  // UX review matrix: work item pages and list peeks at desktop, tablet and phone widths in both themes.
  for (const width of [1440, 768, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate((nextTheme) => { localStorage.setItem("weft.theme", nextTheme); document.documentElement.dataset.theme = nextTheme; }, theme);
    await page.goto(`${base}/issues`);
    await page.getByTestId("row-MOB-1").getByRole("link").click();
    await peek.waitFor();
    await page.screenshot({ path: `${uxShots}/peek-${width}-${theme}.png` });
    await page.keyboard.press("Escape");
    await page.goto(`${web}/${slug}/browse/MOB-1`);
    await page.getByRole("heading", { name: "MOB-1" }).waitFor();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `work item page scrolls sideways at ${width}px (${theme})`);
    await page.screenshot({ path: `${uxShots}/detail-${width}-${theme}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { localStorage.setItem("weft.theme", "light"); document.documentElement.dataset.theme = "light"; });
  await page.goto(`${base}/issues`);
  await page.getByTestId("row-MOB-1").getByRole("link").click();
  await peek.waitFor();
  check(page.url().includes("peek=MOB-1"), "the peek is not in the URL");
  await peek.getByRole("heading", { name: "MOB-1" }).waitFor();
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });
  check(!page.url().includes("peek="), "closing the peek left it in the URL");
  // A reload keeps an open peek; the backdrop closes it too.
  await page.getByTestId("row-MOB-1").getByRole("link").click();
  await peek.waitFor();
  await page.reload();
  await peek.waitFor();
  await page.mouse.click(60, 450);
  await peek.waitFor({ state: "detached" });
  // An open dropdown takes the first Escape; the peek takes the second.
  await page.getByTestId("row-MOB-1").getByRole("link").click();
  await peek.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).first().click();
  await page.keyboard.press("Escape");
  await peek.waitFor();
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });

  // Keyboard only: Enter on a list row opens its peek, Enter on a property opens its menu, Escape closes the menu and returns focus to the property, the next Escape closes the peek.
  await page.goto(`${base}/issues`);
  await page.getByTestId("row-MOB-1").getByRole("link").focus();
  await page.keyboard.press("Enter");
  await peek.waitFor();
  check(page.url().includes("peek=MOB-1"), "Enter on a list row did not open the peek");
  const priorityTrigger = peek.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).first();
  await priorityTrigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: translate("workItems.priority.urgent") }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menuitemradio", { name: translate("workItems.priority.urgent") }).waitFor({ state: "detached" });
  check(await priorityTrigger.evaluate((element) => element === document.activeElement), "Escape in the priority menu did not return focus to the property");
  await peek.waitFor();
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });

  // A failed save shows a plain message in the peek and leaves the property unchanged.
  await page.getByTestId("row-MOB-1").getByRole("link").click();
  await peek.waitFor();
  await page.route(`${api}/actions/update_work_item`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
  await peek.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).first().click();
  await page.getByRole("menuitemradio", { name: translate("workItems.priority.urgent") }).click();
  await peek.getByRole("alert").getByText(translate("workItems.failed"), { exact: true }).waitFor();
  await page.unroute(`${api}/actions/update_work_item`);
  check(await peek.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).first().innerText().then((text) => !text.includes(translate("workItems.priority.urgent"))), "failed save changed the priority");
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });

  // Board, Cycle and Module pages open the same peek.
  await page.goto(`${base}/issues?layout=board`);
  await page.getByTestId("card-MOB-1").getByRole("link").click();
  await peek.waitFor();
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });
  for (const where of [`${base}/cycles/${cycle.id}`, `${base}/modules/${module.id}`]) {
    await page.goto(where);
    await page.getByTestId("row-MOB-1").getByRole("link").click();
    await peek.waitFor();
    await page.keyboard.press("Escape");
    await peek.waitFor({ state: "detached" });
  }
  console.log("peek: opens from list, board, cycle, module and closes with Escape");

  // Peek layout: from 800 px of panel width (80% of the window, at most 1000 px) the Properties sit in a sticky right column beside the content;
  // below that they stack, Properties before the Timeline. The header keeps close and expand; Copy link, Archive and Delete sit under Properties.
  const peekHeader = peek.locator("header").first();
  await page.evaluate(() => { localStorage.setItem("weft.theme", "dark"); document.documentElement.dataset.theme = "dark"; });
  for (const width of [1920, 1440, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`${base}/issues`);
    await page.getByTestId("row-MOB-1").getByRole("link").click();
    await peek.waitFor();
    await peek.getByRole("heading", { name: "MOB-1" }).waitFor();
    const aside = peek.getByRole("complementary", { name: translate("workItems.properties"), exact: true });
    const panel = await peek.boundingBox();
    const side = await aside.boundingBox();
    const title = await peek.getByRole("textbox", { name: translate("workItems.titleField") }).boundingBox();
    const timeline = await peek.getByRole("heading", { name: translate("timeline.title"), exact: true }).boundingBox();
    check(!!panel && !!side && !!title && !!timeline, `the peek has no box at ${width}px`);
    if (width >= 1024) {
      check(Math.abs(panel!.width - Math.min(width * 0.8, 1160)) < 2, `the peek is ${panel!.width}px wide at ${width}px, expected 80% of the window up to 1160px`);
      check(side!.x >= title!.x + title!.width - 1, `Properties is not beside the content at ${width}px`);
      check(await aside.evaluate((node) => getComputedStyle(node).position) === "sticky", `Properties is not sticky in the two-column peek at ${width}px`);
    } else {
      check(side!.y + side!.height <= timeline!.y + 1, `the Timeline is not after Properties at ${width}px`);
      check(await aside.evaluate((node) => getComputedStyle(node).position) !== "sticky", `Properties is sticky in the one-column peek at ${width}px`);
    }
    if (width === 390) check(panel!.width >= 388, `the peek is not full width at 390px (${panel!.width})`);
    // Two columns: the key-property chips are hidden (Properties shows the same fields); stacked: they sit under the title.
    const chips = await peek.getByRole("group", { name: translate("workItems.quickProperties"), exact: true }).isVisible();
    check(chips === (width < 1024), `the key-property chips are ${chips ? "shown" : "hidden"} at ${width}px`);
    const descriptionToolbar = await peek.getByTestId("description-toolbar").boundingBox();
    const gap = descriptionToolbar!.y - (title!.y + title!.height);
    if (width >= 1024) check(gap <= 48, `the description sits ${gap}px under the title at ${width}px; expected the editor toolbar only (48px or less)`);
    check(JSON.stringify(await aside.locator("[data-props-section]").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.propsSection))) === '["primary","more","details"]', `the peek Properties sections are not the page's at ${width}px`);
    const details = await aside.locator('[data-props-section="details"]').boundingBox();
    const actions = await aside.locator("[data-peek-actions]").boundingBox();
    check(!!details && !!actions && actions.y >= details.y, `the peek actions are not under Properties at ${width}px`);
    for (const key of ["workItems.copyLink", "workItems.delete"] as const) check(await peekHeader.getByRole("button", { name: translate(key), exact: true }).count() === 0, `${key} is still in the peek header at ${width}px`);
    check(await peekHeader.getByRole("link", { name: translate("workItems.peek.expand") }).count() === 1, `the peek header lost expand at ${width}px`);
    // Close and Expand sit at the top right, Expand just left of Close.
    const closeBox = await peekHeader.getByRole("button", { name: translate("workItems.peek.close") }).boundingBox();
    const expandBox = await peekHeader.getByRole("link", { name: translate("workItems.peek.expand") }).boundingBox();
    check(!!closeBox && !!expandBox && closeBox.x + closeBox.width >= panel!.x + panel!.width - 40 && expandBox.x + expandBox.width <= closeBox.x + 1, `Close and Expand are not at the top right at ${width}px`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) && await peek.evaluate((node) => node.scrollWidth <= node.clientWidth), `the peek scrolls sideways at ${width}px`);
    await page.screenshot({ path: `${uxShots}/peek-layout-${width}-dark.png` });
  }

  // Seed one Run and an Agent-authored comment after the layout assertions. Keeping the Agent assignment out of the matrix
  // ensures the Run fixture cannot affect the responsive description spacing being asserted above.
  const runItem = await call<Item>("create_work_item", { projectId, title: "Run context" });
  const agent = await call<{ id: string; userId: string }>("create_agent", { workspaceId: me.workspaces[0]!.id, name: "Peek Run Agent", instructions: "Wait for a person to inspect this Run.", model: "default" });
  await call("set_agent_project_access", { agentId: agent.id, allProjects: false, projectIds: [projectId] });
  const assignment = await call<{ wakeOutcomes: Array<{ status: string }> }>("update_work_item", { workItemId: runItem.id, assigneeIds: [agent.userId] });
  check(assignment.wakeOutcomes[0]?.status === "started", "the peek regression Run did not start");
  const runs = await call<Array<{ id: string; status: string }>>("list_runs", { workItemId: runItem.id });
  const targetRun = runs[0];
  check(!!targetRun, "the assigned Agent Run was not returned");
  const fixtureDb = createDatabase();
  fixtureClient = fixtureDb.client;
  const runCommentBody = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Run output for peek navigation." }] }] };
  await fixtureDb.db.insert(comments).values({ workspaceId: me.workspaces[0]!.id, projectId, workItemId: runItem.id, authorId: agent.userId, body: runCommentBody, bodyMarkdown: "Run output for peek navigation.", bodyText: "Run output for peek navigation.", runId: targetRun.id });

  // The actual View run link from a comment in the peek must keep the peek while highlighting its Run.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/issues`);
  await page.getByRole("link", { name: "Run context", exact: true }).click();
  await peek.waitFor();
  await peek.getByRole("heading", { name: runItem.displayId }).waitFor();
  const actualViewRun = peek.getByRole("link", { name: translate("comments.viewRun"), exact: true });
  await actualViewRun.waitFor();
  await actualViewRun.click();
  await page.waitForURL((url) => url.searchParams.get("peek") === runItem.displayId && url.searchParams.get("run") === targetRun.id);
  let focusedRun = page.locator(`#run-${targetRun.id}`);
  await focusedRun.waitFor();
  check(await focusedRun.getAttribute("data-highlighted") === "true", "clicking View run did not focus the targeted Run");
  check(new URL(page.url()).searchParams.get("peek") === runItem.displayId, "clicking View run lost the Work item peek context");

  // Direct navigation is a separate check: the target Run and Work item context restore from one URL.
  await page.goto(`${base}/issues?peek=${encodeURIComponent(runItem.displayId)}&run=${encodeURIComponent(targetRun.id)}`);
  await peek.waitFor();
  focusedRun = page.locator(`#run-${targetRun.id}`);
  await focusedRun.waitFor();
  check(await focusedRun.getAttribute("data-highlighted") === "true", "direct navigation did not focus the targeted Run");
  check(new URL(page.url()).searchParams.get("peek") === runItem.displayId, "direct navigation lost the Work item peek context");
  await Bun.write(`${runPeekShots}/peek-run-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await focusedRun.scrollIntoViewIfNeeded();
  await Bun.write(`${runPeekShots}/peek-run-390.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { localStorage.setItem("weft.theme", "light"); document.documentElement.dataset.theme = "light"; });
  // Two columns: the Properties stay in view while the content scrolls (a 520 px high window makes the content taller than the panel).
  await page.setViewportSize({ width: 1440, height: 520 });
  await page.goto(`${base}/issues`);
  await page.getByTestId("row-MOB-1").getByRole("link").click();
  await peek.waitFor();
  const stickyAside = peek.getByRole("complementary", { name: translate("workItems.properties"), exact: true });
  const stickyTimeline = peek.getByRole("heading", { name: translate("timeline.title"), exact: true });
  const sideBefore = await stickyAside.boundingBox();
  const timelineBefore = await stickyTimeline.boundingBox();
  await stickyAside.evaluate((node) => { const scroller = node.parentElement!; scroller.scrollTop = scroller.scrollHeight; });
  check(await stickyAside.evaluate((node) => node.parentElement!.scrollHeight > node.parentElement!.clientHeight), "the peek content does not scroll at 1440 x 520");
  const sideAfter = await stickyAside.boundingBox();
  const timelineAfter = await stickyTimeline.boundingBox();
  check(!!sideBefore && !!sideAfter && !!timelineBefore && !!timelineAfter && timelineAfter.y < timelineBefore.y - 50 && Math.abs(sideAfter.y - sideBefore.y) < 2, "Properties did not stay in view while the content scrolled");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });

  // Expand to the full page at the browse-by-key URL, with every section.
  await page.goto(`${base}/issues`);
  await page.getByTestId("row-MOB-1").getByRole("link").click();
  await peek.getByRole("link", { name: translate("workItems.peek.expand") }).click();
  await page.waitForURL(`${web}/${slug}/browse/MOB-1`);
  await page.getByRole("heading", { name: "MOB-1" }).waitFor();
  // Empty sections stay hidden; the action row is the way in.
  const actionRow = page.getByRole("group", { name: translate("workItems.actions") });
  for (const key of ["workItems.addSubItemAction", "workItems.addRelationAction", "workItems.addLinkAction", "workItems.attachAction"] as const) await actionRow.getByRole("button", { name: translate(key) }).waitFor();
  for (const name of [translate("timeline.title"), translate("workItems.properties")]) {
    await page.getByRole("heading", { name }).first().waitFor();
  }
  await page.getByTestId("description-editor").waitFor();
  await page.getByRole("navigation", { name: translate("workItems.breadcrumb") }).waitFor();
  const pageToggle = page.getByTestId("work-item-properties-toggle");
  const pageProperties = page.getByRole("complementary", { name: translate("workItems.properties"), exact: true });
  check(await pageToggle.getAttribute("aria-expanded") === "true", "work item details toggle must expose its expanded state");
  check(await pageToggle.getAttribute("aria-controls") === await pageProperties.getAttribute("id"), "work item details toggle must control the page panel");
  await pageToggle.click();
  check(await page.getByRole("complementary", { name: translate("workItems.properties"), exact: true }).count() === 0, "a hidden work item panel must leave the accessibility tree");
  await page.keyboard.press("Control+i");
  await pageProperties.waitFor();
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).first().focus();
  await page.keyboard.press("Control+i");
  check(await pageProperties.isVisible(), "Ctrl+I must not toggle while focus is in a text field");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+i");
  await pageProperties.waitFor({ state: "hidden" });
  await page.reload();
  await page.getByTestId("work-item-properties-toggle").waitFor();
  check(await page.getByRole("complementary", { name: translate("workItems.properties"), exact: true }).count() === 0, "a hidden work item panel must remain hidden after reload");
  for (const width of [1440, 1100, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `work item page scrolls horizontally at ${width}px with details collapsed`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Control+i");
  await pageProperties.waitFor();
  await page.screenshot({ path: `${shots}/page-1440-light.png` });
  for (const [theme, width, height] of [["light", 1440, 900], ["dark", 1440, 900], ["light", 768, 900], ["dark", 768, 900], ["light", 390, 844], ["dark", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await page.screenshot({ path: `${shots}/ticket13-work-item-page-${theme}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  // Every sidebar property is editable inline.
  const sidebar = page.getByRole("complementary", { name: translate("workItems.properties") });
  const pick = async (property: string, option: string, role: "menuitemradio" | "menuitemcheckbox" = "menuitemradio") => {
    await sidebar.getByRole("button", { name: new RegExp(`^${property}:`) }).click();
    await page.getByRole(role, { name: option, exact: true }).click();
    await page.keyboard.press("Escape");
  };
  await pick(translate("workItems.state"), "Todo");
  await pick(translate("workItems.priority"), translate("workItems.priority.high"));
  await pick(translate("workItems.assignees"), "Peek Tester", "menuitemcheckbox");
  await pick(translate("workItems.labels"), "Bug", "menuitemcheckbox");
  // Start and Due share one calendar popover: the Start chip opens it, the first day picks Start and the next picks Due.
  const calendar = page.locator("[data-popover-panel]");
  const pickCalendarDay = async (value: string) => {
    for (let turn = 0; turn < 3 && await calendar.locator(`[data-date="${value}"]`).count() === 0; turn += 1) await calendar.getByRole("button", { name: translate("datePicker.nextMonth") }).click();
    await calendar.locator(`[data-date="${value}"]`).click();
  };
  await sidebar.getByRole("button", { name: new RegExp(`^${translate("workItems.startDate")}:`) }).click();
  await pickCalendarDay(day(1));
  await pickCalendarDay(day(4));
  await page.keyboard.press("Escape");
  await pick(translate("workItems.modules"), "Auth", "menuitemcheckbox"); // removes the existing membership
  await pick(translate("workItems.cycle"), translate("workItems.noCycle"));
  await pick(translate("workItems.parent"), "MOB-2 Bravo");
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).first().fill("Alpha renamed");
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).first().press("Enter");
  await page.getByTestId("description-editor").locator(".ProseMirror").click();
  await page.keyboard.type("Typed in the description");
  await page.waitForResponse((response) => response.url().includes("update_work_item") && response.ok() && (response.request().postData() ?? "").includes("description"));
  await Bun.sleep(300); // kept: the other fields save on their own requests, which this flow does not wait on; the reads below check them
  const edited = await stored("MOB-1");
  const states = await call<Array<{ id: string; name: string }>>("list_states", { projectId });
  check(edited.stateId === states.find((state) => state.name === "Todo")!.id, "state did not store");
  check(edited.priority === "high", "priority did not store");
  check(edited.assigneeIds.join() === me.user.id, "assignee did not store");
  check(edited.labelIds.join() === label.id, "label did not store");
  check(edited.startDate === day(1) && edited.dueDate === day(4), "dates did not store");
  check(edited.parentId !== null && edited.title === "Alpha renamed", "parent or title did not store");
  check(JSON.stringify(edited.description).includes("Typed in the description"), "description did not autosave");
  check((await call<Item[]>("list_work_items", { projectId, cycleId: cycle.id })).length === 0, "cycle was not cleared");
  check((await call<Item[]>("list_work_items", { projectId, moduleId: module.id })).length === 0, "module was not cleared");
  const cycleAdded = page.waitForResponse((response) => response.url().endsWith("/actions/add_cycle_items"));
  await pick(translate("workItems.cycle"), "Sprint 1");
  await cycleAdded;
  const moduleAdded = page.waitForResponse((response) => response.url().endsWith("/actions/add_module_items"));
  await pick(translate("workItems.modules"), "Auth", "menuitemcheckbox");
  await moduleAdded;
  check((await call<Item[]>("list_work_items", { projectId, cycleId: cycle.id })).length === 1, "cycle did not store");
  check((await call<Item[]>("list_work_items", { projectId, moduleId: module.id })).length === 1, "module did not store");
  console.log("page: every property edits inline");

  // Sub-work items, relations, comments with replies and the activity timeline.
  await actionRow.getByRole("button", { name: translate("workItems.addSubItemAction") }).click();
  await page.getByRole("textbox", { name: `${translate("workItems.subItems")}: ${translate("workItems.titleField")}` }).fill("Child task");
  await page.locator("form").getByRole("button", { name: translate("workItems.subItems.add") }).click();
  await page.getByRole("link", { name: /Child task/ }).waitFor();
  await actionRow.getByRole("button", { name: translate("workItems.addRelationAction") }).click();
  const relationDialog = page.getByRole("dialog", { name: translate("relations.addTitle") });
  await relationDialog.waitFor();
  await page.getByRole("combobox", { name: translate("relations.target") }).selectOption({ label: "MOB-2 Bravo" });
  await page.locator("form").getByRole("button", { name: translate("relations.add"), exact: true }).click();
  await page.getByText(translate("relations.type.blocks")).first().waitFor();
  const commentEditor = '[data-testid="comment-editor"] .ProseMirror';
  await page.locator(commentEditor).first().click();
  await page.keyboard.type("First comment");
  await page.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  await page.getByText("First comment").waitFor();
  await page.getByRole("button", { name: translate("comments.reply"), exact: true }).first().click();
  await page.locator(commentEditor).first().click();
  await page.keyboard.type("A reply");
  await page.getByRole("button", { name: translate("comments.reply"), exact: true }).last().click();
  await page.getByText("A reply").waitFor();
  // The default timeline shows Comments only: All shows the Activity entries too.
  await page.getByRole("combobox", { name: translate("timeline.filter", "en"), exact: true }).selectOption("all");
  await page.getByText(translate("workItems.activity.created")).first().waitFor();
  await page.screenshot({ path: `${shots}/page-activity-1440-light.png`, fullPage: true });
  console.log("page: sub-work items, relations, comments with replies and activity");

  // Create modal.
  await page.goto(`${base}/issues`);
  await page.getByRole("button", { name: translate("workItems.addNew"), exact: true }).first().click();
  const modal = page.getByRole("dialog", { name: translate("workItems.modal.title") });
  await modal.waitFor();
  await modal.getByRole("textbox", { name: translate("workItems.titleField") }).fill("From the modal");
  await modal.getByRole("textbox", { name: translate("workItems.description") }).fill("Line one\nLine two");
  const modalPick = async (property: string, option: string, role: "menuitemradio" | "menuitemcheckbox" = "menuitemradio") => {
    await modal.getByRole("button", { name: new RegExp(`^${property}:`) }).click();
    await page.getByRole(role, { name: option, exact: true }).click();
    if (role === "menuitemcheckbox") await page.keyboard.press("Escape"); // a multi dropdown stays open; a single one already closed
  };
  await modalPick(translate("workItems.priority"), translate("workItems.priority.urgent"));
  await modalPick(translate("workItems.assignees"), "Peek Tester", "menuitemcheckbox");
  await modalPick(translate("workItems.labels"), "Bug", "menuitemcheckbox");
  await modalPick(translate("workItems.cycle"), "Sprint 1");
  await modalPick(translate("workItems.modules"), "Auth", "menuitemcheckbox");
  await modalPick(translate("workItems.modal.parent"), "MOB-2 Bravo");
  await modal.getByLabel(translate("workItems.startDate")).fill(day(2));
  await modal.getByLabel(translate("workItems.dueDate")).fill(day(5));
  await page.screenshot({ path: `${shots}/create-modal-1440-light.png` });
  await modal.getByRole("button", { name: translate("workItems.modal.submit") }).click();
  await modal.waitFor({ state: "detached" });
  await page.getByRole("link", { name: "From the modal" }).waitFor();
  const created = (await call<Item[]>("list_work_items", { projectId })).find((item) => item.title === "From the modal")!;
  check(created.priority === "urgent" && created.assigneeIds.join() === me.user.id && created.labelIds.join() === label.id, "modal priority, assignee or label did not store");
  check(created.parentId !== null && created.startDate === day(2) && created.dueDate === day(5), "modal parent or dates did not store");
  check(JSON.stringify((await stored(created.displayId)).description).includes("Line two"), "modal description did not store");
  check((await call<Item[]>("list_work_items", { projectId, cycleId: cycle.id })).some((item) => item.id === created.id), "modal cycle did not store");
  check((await call<Item[]>("list_work_items", { projectId, moduleId: module.id })).some((item) => item.id === created.id), "modal module did not store");
  // Escape closes an empty modal.
  await page.getByRole("button", { name: translate("workItems.addNew"), exact: true }).first().click();
  await modal.waitFor();
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached" });
  console.log("modal: creates with parent, labels, assignees, dates, cycle and modules");

  // Narrow screens: the peek goes full screen, the page stacks, the modal fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "From the modal" }).click();
  await peek.waitFor();
  const box = await peek.boundingBox();
  check(!!box && box.width >= 388, `peek is not full screen at 390px (${box?.width})`);
  for (const key of ["workItems.peek.close", "workItems.peek.expand"] as const) {
    const action = peek.getByRole(key === "workItems.peek.expand" ? "link" : "button", { name: translate(key) });
    check((await action.innerText()).includes(translate(key)), `${key} has no visible phone label`);
  }
  // On a phone, Copy link and Delete are labelled buttons under Properties; no header More menu is left in the peek.
  for (const key of ["workItems.copyLink", "workItems.delete"] as const) {
    check(await peek.locator("[data-peek-actions]").getByRole("button", { name: translate(key), exact: true }).isVisible(), `${key} is not a visible button under Properties on phone`);
  }
  await peek.waitFor();
  check(await page.getByText(translate("timeline.filter"), { exact: true }).isVisible(), "timeline filter has no visible label");
  check(await page.getByText(translate("timeline.sort"), { exact: true }).isVisible(), "timeline sort has no visible label");
  const phoneCommentToolbar = peek.getByRole("toolbar", { name: translate("comments.toolbar") });
  // Comment formatting controls are icon buttons named by aria-label and tooltip, and grow to a 40px touch target on a phone.
  const phoneBold = phoneCommentToolbar.getByRole("button", { name: translate("wiki.tool.bold") });
  check(await phoneBold.isVisible() && (await phoneBold.getAttribute("title"))?.includes(translate("wiki.tool.bold")) === true, "comment formatting controls have no accessible name or tooltip on phone");
  const boldBox = await phoneBold.boundingBox();
  check(!!boldBox && boldBox.width >= 40 && boldBox.height >= 40, `comment formatting control is below a 40px touch target on phone (${boldBox?.width}x${boldBox?.height})`);
  check(await peek.getByRole("button", { name: translate("wiki.insert.image"), exact: true }).last().getAttribute("title") === translate("wiki.insert.image"), "comment image control has no tooltip on phone");
  await page.screenshot({ path: `${shots}/peek-390-light.png` });
  for (const [theme, width, height] of [["light", 1440, 900], ["dark", 1440, 900], ["light", 768, 900], ["dark", 768, 900], ["light", 390, 844], ["dark", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await page.screenshot({ path: `${shots}/ticket13-work-item-peek-${theme}-${width}.png` });
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  await page.getByRole("heading", { name: translate("workItems.properties") }).first().waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page scrolls sideways at 390px");
  await page.screenshot({ path: `${shots}/page-390-light.png`, fullPage: true });
  await page.goto(`${base}/issues`);
  await page.getByRole("button", { name: translate("workItems.addNew"), exact: true }).first().click();
  await modal.waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "modal scrolls sideways at 390px");
  await page.screenshot({ path: `${shots}/create-modal-390-light.png` });
  // Peek at 1440 for the review shots.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "From the modal" }).click();
  await peek.waitFor();
  await page.screenshot({ path: `${shots}/peek-1440-light.png` });
  // Delete asks first: dismissing the confirmation keeps the work item, accepting deletes it and closes the peek.
  let asked = "";
  page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.dismiss(); });
  await peek.getByRole("button", { name: translate("workItems.delete"), exact: true }).click();
  check(asked === translate("workItems.deleteConfirm"), `delete did not ask for confirmation (${asked})`);
  check(await peek.isVisible(), "dismissing the delete confirmation closed the peek");
  await page.goto(`${base}/issues`);
  await page.getByRole("link", { name: "From the modal" }).waitFor();
  await page.getByRole("link", { name: "From the modal" }).click();
  await peek.waitFor();
  page.once("dialog", (dialog) => void dialog.accept());
  await peek.getByRole("button", { name: translate("workItems.delete"), exact: true }).click();
  await peek.waitFor({ state: "detached" });
  await page.goto(`${base}/issues`);
  await page.getByTestId("row-MOB-1").getByRole("link").waitFor();
  check(await page.getByRole("link", { name: "From the modal" }).count() === 0, "accepting the delete confirmation kept the work item");
  void t;
  console.log("e2e work item peek and detail: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await fixtureClient?.end();
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
