// Browser end-to-end flow for the work item peek panel, full page, inline property editing and the create modal.
// Run with `bun e2e/work-item-peek.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import { mkdirSync } from "node:fs";
import { translate } from "../packages/shared/src";
import { comments, createDatabase } from "../packages/db/src";
import { reviewShots } from "../tools/visual/paths";
import { chooseDate, expectDate } from "../tools/choose-date";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("07-work-item-peek-and-detail");
const shadcnShots = ".local/shots/shadcn-04";
mkdirSync(shadcnShots, { recursive: true });
const uxShots = reviewShots("12-work-items-ux");
const runPeekShots = "/home/plong/workspace/weft/.local/ai-ux-reliability/09";
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

type Item = { id: string; displayId: string; title: string; stateId: string; priority: string; assigneeIds: string[]; labelIds: string[]; parentId: string | null; startDate: string | null; dueDate: string | null; description: unknown };
let failed = false;
let fixtureClient: ReturnType<typeof createDatabase>["client"] | undefined;
try {
  await Bun.$`mkdir -p ${runPeekShots}`;
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US", hasTouch: true }, api, web, {
    account: { name: "Peek Tester", email: `${slug}@example.test` },
    workspace: { name: "E2E team", slug },
    project: { name: "Mobile", key: "MOB", visibility: "public", shape: "full" },
  });
  const page = await context.newPage();
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };
  const t = translate as (key: string) => string;
  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const projectId = project!.id;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const setDate = async (scope: import("playwright").Locator, label: string, value: string) => await chooseDate(scope.getByRole("button", { name: new RegExp(`^${label}:`) }), value);
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
  for (const width of [1440, 844, 768, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 844 ? 390 : 900 });
    await page.evaluate((nextTheme) => { localStorage.setItem("weft.theme", nextTheme); document.documentElement.dataset.theme = nextTheme; }, theme);
    await page.goto(`${base}/issues`);
    await page.getByTestId("row-MOB-1").getByRole("link").click();
    await peek.waitFor();
    await page.screenshot({ path: `${uxShots}/peek-${width}-${theme}.png` });
    await page.keyboard.press("Escape");
    await page.goto(`${web}/${slug}/browse/MOB-1`);
    await page.getByRole("heading", { name: "Alpha", level: 1 }).waitFor();
    check(await page.getByRole("heading", { name: "Alpha", level: 1 }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize) >= 24), `the detail title is below 24px at ${width}px (${theme})`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `work item page scrolls sideways at ${width}px (${theme})`);
    await page.screenshot({ path: `${uxShots}/detail-${width}-${theme}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { localStorage.setItem("weft.theme", "light"); document.documentElement.dataset.theme = "light"; });
  await page.goto(`${base}/issues`);
  await page.getByTestId("row-MOB-1").getByRole("link").click();
  await peek.waitFor();
  check(page.url().includes("peek=MOB-1"), "the peek is not in the URL");
  await peek.getByRole("heading", { name: "Alpha", level: 2 }).waitFor();
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
  for (const width of [1920, 1440, 1280, 1024, 844, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 844 ? 390 : 900 });
    await page.goto(`${base}/issues`);
    await page.getByTestId("row-MOB-1").getByRole("link").click();
    await peek.waitFor();
    await peek.getByRole("heading", { name: "Alpha", level: 2 }).waitFor();
    check(await peek.getByRole("heading", { name: "Alpha", level: 2 }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize) >= 24), `the peek title is below 24px at ${width}px`);
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
    const propertyButtons = aside.locator('[data-props-section="primary"] [data-property-row] button');
    const propertyButtonBoxes = await propertyButtons.evaluateAll((nodes) => nodes.slice(0, 4).map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    }));
    check(propertyButtonBoxes.length === 4 && propertyButtonBoxes.every((box) => Math.abs(box.x - propertyButtonBoxes[0]!.x) < 1 && Math.abs(box.width - propertyButtonBoxes[0]!.width) < 1), `the key property values do not share aligned centers and equal widths at ${width}px`);
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
  await peek.getByRole("heading", { name: "Run context", level: 2 }).waitFor();
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
  await page.getByRole("heading", { name: "Alpha", level: 1 }).waitFor();
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
    await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished))); // colour transitions must settle before the shot
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
  const commentActions = page.locator('[data-comment-actions]').first();
  const commentComposer = page.locator('[data-comment-composer]');
  const actionBox = await commentActions.boundingBox();
  const composerBox = await commentComposer.boundingBox();
  check(!!actionBox && !!composerBox && composerBox.y >= actionBox.y + actionBox.height + 20, "the comment composer overlaps or crowds the comment action row");
  const actionGlyphs = await commentActions.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: Array<{ bottom: number; text: string }> = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) rects.push({ bottom: rect.bottom, text: node.textContent.trim() });
    }
    return rects;
  });
  check(actionGlyphs.length > 0 && actionGlyphs.every((glyph) => glyph.bottom <= composerBox!.y), "comment action text is clipped behind the composer");
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
  const propertyGrid = modal.getByTestId("create-property-grid");
  const propertyLayout = await propertyGrid.evaluate((grid) => {
    const buttons = [...grid.querySelectorAll<HTMLButtonElement>(":scope > * button")];
    const rects = buttons.map((button) => ({ ...button.getBoundingClientRect().toJSON(), parent: Boolean(button.closest('[data-testid="create-parent-control"]')) }));
    const glyphs = buttons.flatMap((button) => {
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      const ranges: Array<{ left: number; right: number; top: number; bottom: number; width: number; height: number; text: string }> = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim() || node.parentElement?.closest('[aria-hidden="true"]')) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        ranges.push(...[...range.getClientRects()].map((rect) => ({ ...rect.toJSON(), text: node.textContent?.trim() ?? "" })));
      }
      const bounds = button.getBoundingClientRect();
      return ranges.map((rect) => ({ inside: rect.left >= bounds.left + 4 && rect.right <= bounds.right - 4 && rect.top >= bounds.top && rect.bottom <= bounds.bottom, width: rect.width, height: rect.height, text: rect.text, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, buttonLeft: bounds.left, buttonRight: bounds.right }));
    });
    return { rects, glyphs };
  });
  check(propertyLayout.rects.length >= 6, "create property grid lost one or more work-item property controls");
  check(propertyLayout.rects.every((rect, index, all) => Math.abs(rect.height - all[0]!.height) < 1), "create property controls do not have equal heights");
  const standardWidths = propertyLayout.rects.filter((rect) => !rect.parent).map((rect) => rect.width);
  check(standardWidths.every((width) => Math.abs(width - standardWidths[0]!) < 1), "create property controls do not have equal column widths");
  check(propertyLayout.rects.filter((rect) => rect.parent).every((rect) => rect.width >= standardWidths[0]!), "the parent control does not have enough width for its visible label");
  check(propertyLayout.rects.every((rect, _, all) => all.filter((other) => Math.abs(other.y - rect.y) < 1).every((other) => Math.abs((rect.y + rect.height / 2) - (other.y + other.height / 2)) < 1)), "create property controls are not center-aligned within each row");
  check(propertyLayout.rects.every((rect, index, all) => all.every((other, otherIndex) => index === otherIndex || rect.right <= other.x + 1 || other.right <= rect.x + 1 || rect.bottom <= other.y + 1 || other.bottom <= rect.y + 1)), "create property controls overlap sibling boxes");
  check(propertyLayout.glyphs.every((glyph) => glyph.inside && glyph.width > 0 && glyph.height > 0), `create property label glyphs are clipped by their controls: ${JSON.stringify(propertyLayout.glyphs.filter((glyph) => !glyph.inside))}`);
  const primaryColor = await modal.getByRole("button", { name: translate("workItems.modal.submit") }).evaluate((element) => getComputedStyle(element).backgroundColor);
  const cancelColor = await modal.getByRole("button", { name: translate("workItems.modal.cancel"), exact: true }).last().evaluate((element) => getComputedStyle(element).backgroundColor);
  check(primaryColor !== cancelColor, "Create work item should be visually primary to Cancel");
  const titleField = modal.getByRole("textbox", { name: translate("workItems.titleField") });
  check(await titleField.evaluate((element) => element === document.activeElement), "create dialog did not focus the first field");
  await page.keyboard.press("Shift+Tab");
  check(await modal.evaluate((element) => element.contains(document.activeElement)), "Shift+Tab moved focus outside the create dialog");
  await page.keyboard.press("Tab");
  check(await titleField.evaluate((element) => element === document.activeElement), "Tab did not cycle back into the create dialog");
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
  // Keyboard-only Due date while the 1st of the shown month is out of bounds: Start on the 15th disables the 1st-14th,
  // and the grid must still hold exactly one Tab stop on a pickable day (WAI-ARIA date picker keys).
  const keyDay = (value: string, days: number) => { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
  const keyMonth = (value: string, months: number) => { const [y, m, d] = value.split("-").map(Number); const last = new Date(Date.UTC(y!, m! - 1 + months + 1, 0)).getUTCDate(); return new Date(Date.UTC(y!, m! - 1 + months, Math.min(d!, last))).toISOString().slice(0, 10); };
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const boundStart = `${localToday.slice(0, 7)}-15`;
  const startTrigger = modal.getByRole("button", { name: new RegExp(`^${translate("workItems.startDate")}:`) });
  const dueTrigger = modal.getByRole("button", { name: new RegExp(`^${translate("workItems.dueDate")}:`) });
  await chooseDate(startTrigger, boundStart);
  await dueTrigger.focus();
  await page.keyboard.press("Enter");
  const duePanel = page.locator('[data-popover-panel][role="dialog"]').filter({ has: page.locator("[data-date-picker]") }).last();
  await duePanel.waitFor();
  check(await duePanel.locator(`[data-date="${localToday.slice(0, 7)}-01"]`).getAttribute("aria-disabled") === "true", "the 1st must be out of bounds (before Start) for this keyboard check");
  check(await duePanel.locator('[data-date][tabindex="0"]').count() === 1, "the calendar grid must keep exactly one Tab stop when the 1st is out of bounds");
  const focusedDay = async () => await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.date ?? null);
  for (let tab = 0; tab < 20 && !(await focusedDay()); tab++) await page.keyboard.press("Tab");
  const firstStop = await focusedDay();
  const expectedStop = localToday >= boundStart ? localToday : boundStart;
  check(firstStop === expectedStop, `Tab must reach the calendar on ${expectedStop} (today or the first pickable day), reached ${firstStop}`);
  const press = async (key: string, expected: string) => {
    await page.keyboard.press(key);
    for (let attempt = 0; attempt < 30 && await focusedDay() !== expected; attempt++) await Bun.sleep(50);
    check(await focusedDay() === expected, `${key} must move calendar focus to ${expected}, focus is on ${await focusedDay()}`);
  };
  await press("ArrowRight", keyDay(firstStop!, 1));
  await press("ArrowDown", keyDay(firstStop!, 8));
  await press("ArrowUp", keyDay(firstStop!, 1));
  await press("ArrowLeft", firstStop!);
  await press("PageDown", keyMonth(firstStop!, 1));
  await press("PageUp", firstStop!);
  const weekday = new Date(`${firstStop}T00:00:00Z`).getUTCDay();
  await press("Home", keyDay(firstStop!, -weekday));
  await press("End", keyDay(firstStop!, 6 - weekday));
  const keyboardDue = keyDay(firstStop!, 6 - weekday);
  await page.keyboard.press("Enter");
  await expectDate(dueTrigger, keyboardDue, "keyboard-only Due date");
  await duePanel.waitFor({ state: "hidden" });
  check(await dueTrigger.evaluate((element) => element === document.activeElement), "picking a day must return focus to the Due date trigger");
  await page.keyboard.press("Enter");
  await duePanel.waitFor();
  await page.keyboard.press("Escape");
  await duePanel.waitFor({ state: "hidden" });
  check(await dueTrigger.evaluate((element) => element === document.activeElement), "Escape must close the calendar and return focus to the Due date trigger");
  check(await modal.isVisible(), "Escape in the calendar must not also close the Create dialog");
  await chooseDate(dueTrigger, "");
  await chooseDate(startTrigger, "");
  await setDate(modal, translate("workItems.startDate"), day(2));
  await setDate(modal, translate("workItems.dueDate"), day(5));
  await page.screenshot({ path: `${shots}/create-modal-1440-light.png` });
  await page.screenshot({ path: `${shadcnShots}/dialog-1440-light.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished))); // colour transitions must settle before the shot
  await page.screenshot({ path: `${shadcnShots}/dialog-1440-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
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
  const addButton = page.getByRole("button", { name: translate("workItems.addNew"), exact: true }).first();
  await addButton.click();
  await modal.waitFor();
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached" });
  await page.waitForFunction((element) => element === document.activeElement, await addButton.elementHandle());
  await addButton.click();
  await modal.waitFor();
  await modal.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Created with Enter");
  await page.keyboard.press("Enter");
  await modal.waitFor({ state: "detached" });
  await page.getByRole("link", { name: "Created with Enter", exact: true }).waitFor();
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
  const footerCopy = peek.locator("[data-peek-actions]").getByRole("button", { name: translate("workItems.copyLink"), exact: true });
  const footerDelete = peek.locator("[data-peek-actions]").getByRole("button", { name: translate("workItems.delete"), exact: true });
  check(await footerCopy.evaluate((node) => getComputedStyle(node).color) !== await footerDelete.evaluate((node) => getComputedStyle(node).color), "Delete in the peek footer has no destructive text treatment");
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
    await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished))); // colour transitions must settle before the shot
    await page.screenshot({ path: `${shots}/ticket13-work-item-peek-${theme}-${width}.png` });
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  await page.getByRole("heading", { name: translate("workItems.properties") }).first().waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page scrolls sideways at 390px");
  await page.screenshot({ path: `${shots}/page-390-light.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/issues`);
  await page.getByRole("button", { name: translate("workItems.addNew"), exact: true }).first().click();
  await modal.waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "modal scrolls sideways at 390px");
  await page.screenshot({ path: `${shots}/create-modal-390-light.png` });
  await page.screenshot({ path: `${shadcnShots}/dialog-390-light.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished))); // colour transitions must settle before the shot
  await page.screenshot({ path: `${shadcnShots}/dialog-390-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 1180], [768, 1024], [844, 390], [667, 375], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const bounds = await modal.boundingBox();
      check(!!bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height, `create dialog is clipped at ${width}x${height}`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `create dialog causes horizontal page scroll at ${width}x${height}`);
      if (height <= 390) check(await modal.evaluate((element) => element.scrollHeight > element.clientHeight), `create dialog does not scroll internally at short viewport ${width}x${height}`);
      if (width <= 820) check((await modal.getByRole("button").evaluateAll((buttons) => buttons.every((button) => button.getBoundingClientRect().height >= 44))), `create dialog has a touch target below 44px at ${width}x${height}`);
      await page.screenshot({ path: `${shadcnShots}/dialog-${width}x${height}-${theme}.png` });
    }
  }
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
  const itemsAfterDelete = await call<Item[]>("list_work_items", { projectId });
  check(itemsAfterDelete.some((item) => item.displayId === "MOB-1"), `MOB-1 disappeared after deleting the modal item: ${JSON.stringify(itemsAfterDelete.map((item) => item.displayId))}`);
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
