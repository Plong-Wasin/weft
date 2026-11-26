// Browser end-to-end flow: sign up, create work items, drag a card on the kanban board, check it persists.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { and, eq, like } from "drizzle-orm";
import { createDatabase, projectMembers, projects, users, workItemAssignees, workItems, workspaceMembers, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
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

async function titlesIn(page: Page, column: string) {
  return page.locator(`[data-testid="column-${column}"] article [data-testid="card-title"]`).allTextContents();
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  const shots = reviewShots("06-board-layout");
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Kanban Tester");
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
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  // An empty project shows the empty state: its Add work item button creates Alpha in the modal; Backlog's + then adds the rest inline.
  await page.getByRole("status").filter({ hasText: translate("workItems.emptyHint") }).getByRole("button", { name: translate("workItems.addNew"), exact: true }).click();
  const modal = page.getByRole("dialog", { name: translate("workItems.modal.title") });
  await modal.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Alpha");
  await modal.getByRole("button", { name: translate("workItems.modal.submit"), exact: true }).click();
  await page.getByRole("link", { name: /Alpha/ }).waitFor();
  await page.getByRole("button", { name: translate("layout.addToGroup").replace("{group}", "Backlog") }).click();
  for (const title of ["Bravo", "Charlie"]) {
    await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill(title);
    await page.getByRole("button", { name: translate("workItems.create") }).click();
    await page.getByRole("link", { name: new RegExp(title) }).waitFor();
  }

  await page.getByRole("button", { name: translate("layout.board") }).click();
  if (!page.url().includes("layout=board")) throw new Error("layout is not in the URL");
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const boardScroller = page.getByTestId("board");
  check(await boardScroller.evaluate((el) => el.scrollWidth > el.clientWidth), "board should preserve horizontal scrolling when columns overflow");
  check(await page.getByTestId("board-scroll-affordance").isVisible(), "board should show a horizontal scroll affordance");
  const firstCard = page.locator('[data-testid^="card-"]').first();
  const cardSelection = firstCard.getByTestId("card-selection");
  await page.mouse.move(5, 5);
  const restingSelection = await cardSelection.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, hover: matchMedia("(hover: hover)").matches, classes: el.className }));
  check(Number.parseFloat(restingSelection.opacity) === 0, `board card checkbox should be hidden at rest: ${JSON.stringify(restingSelection)}`);
  await firstCard.hover();
  const hoveredSelection = await cardSelection.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, parentHover: el.closest("article")?.matches(":hover"), parentClass: el.closest("article")?.className }));
  check(Number.parseFloat(hoveredSelection.opacity) === 1, `board card checkbox should appear on hover: ${JSON.stringify(hoveredSelection)}`);
  const cardProperties = firstCard.getByTestId("card-properties");
  if (await cardProperties.count()) {
    const chipLayout = await cardProperties.evaluate((row) => {
      const boxes = [...row.children].map((child) => child.getBoundingClientRect());
      return { rowHeight: row.getBoundingClientRect().height, boxes: boxes.map(({ left, right, top, height }) => ({ left, right, centerY: top + height / 2 })), height: row.clientHeight, scrollHeight: row.scrollHeight };
    });
    const aligned = chipLayout.boxes.every((box) => Math.abs(box.centerY - chipLayout.boxes[0]!.centerY) <= 1);
    const nonOverlapping = chipLayout.boxes.every((box, index) => index === 0 || chipLayout.boxes[index - 1]!.right <= box.left + 1);
    check(chipLayout.rowHeight <= 48 && aligned && nonOverlapping && chipLayout.scrollHeight <= chipLayout.height + 1, `board properties should stay in one aligned, non-overlapping row: ${JSON.stringify(chipLayout)}`);
  }
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(await page.getByLabel(translate("layout.subGroup")).count() === 1, "board Sub-group control is missing");
  await page.getByLabel(translate("layout.subGroup")).selectOption("priority");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(page.url().includes("subgroup=priority"), "Sub-group is not in the URL");
  await page.getByTestId("board-swimlanes").waitFor();
  check(await page.getByTestId("board").evaluate((el) => getComputedStyle(el).overflowX) === "auto", "the board must still scroll sideways when its columns overflow");
  check(JSON.stringify(await titlesIn(page, "Backlog")) === JSON.stringify(["Alpha", "Bravo", "Charlie"]), "expected three cards in Backlog");

  await page.getByRole("button", { name: translate("layout.list") }).click();
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(await page.getByLabel(translate("layout.subGroup")).count() === 1, "list Sub-group control is missing");
  await page.getByLabel(translate("layout.subGroup")).selectOption("priority");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.locator(`section[aria-label="${translate("workItems.priority.none")}"]`).first().waitFor();
  await page.getByRole("button", { name: translate("layout.spreadsheet") }).click();
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(await page.getByLabel(translate("layout.subGroup")).count() === 0, "spreadsheet shows the Sub-group control");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByRole("button", { name: translate("layout.board") }).click();
  await page.getByTestId("board-swimlanes").waitFor();

  // Drag Charlie to the Todo column, then reorder inside Backlog (Bravo above Alpha).
  await page.getByTestId("card-MOB-3").dragTo(page.getByTestId("column-Todo"));
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Todo"] [data-testid="card-MOB-3"]'));
  await page.getByTestId("card-MOB-2").dragTo(page.getByTestId("card-MOB-1"));
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Backlog"] article')?.getAttribute("data-testid") === "card-MOB-2");

  await page.reload();
  await page.getByTestId("card-MOB-3").waitFor();
  check(JSON.stringify(await titlesIn(page, "Todo")) === JSON.stringify(["Charlie"]), "Charlie did not stay in Todo after reload");
  check(JSON.stringify(await titlesIn(page, "Backlog")) === JSON.stringify(["Bravo", "Alpha"]), "reorder did not persist");

  // Quick add in a column creates the card in that column (State group).
  await page.getByRole("button", { name: translate("layout.addToGroup").replace("{group}", "Backlog") }).first().click();
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Delta");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Backlog"] [data-testid="card-MOB-4"]'));
  check((await titlesIn(page, "Backlog")).includes("Delta"), "quick add did not land in Backlog");

  // Rapid arrow input is applied in order, and a card remounted in another column keeps its handle focused.
  let rapidMoves = 0;
  await page.route(`${api}/actions/move_work_item`, async (route) => { rapidMoves += 1; await Bun.sleep(300); await route.continue(); });
  const deltaReorder = page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-4` });
  await deltaReorder.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector('[data-testid="column-In Progress"] [data-testid="card-MOB-4"]'), undefined, { timeout: 5000 });
  await page.unroute(`${api}/actions/move_work_item`);
  check(rapidMoves === 2, `expected both rapid moves to run, got ${rapidMoves}`);
  const deltaId = await page.getByTestId("card-MOB-4").getAttribute("data-card-id");
  check(await page.evaluate(() => document.activeElement?.getAttribute("data-reorder")) === deltaId, "cross-column keyboard move did not restore focus to its handle");

  // An async successful move must not take focus back after the user moves it elsewhere.
  let releaseMove!: () => void;
  const moveGate = new Promise<void>((resolve) => { releaseMove = resolve; });
  await page.route(`${api}/actions/move_work_item`, async (route) => { await moveGate; await route.continue(); });
  const focusAway = page.getByRole("button", { name: translate("layout.display") });
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-4` }).focus();
  const delayedMove = page.waitForRequest((request) => request.url().endsWith("/actions/move_work_item"));
  await page.keyboard.press("ArrowLeft");
  await delayedMove;
  await focusAway.focus();
  releaseMove();
  await page.locator('[data-testid="column-Todo"] [data-testid="card-MOB-4"]').waitFor();
  await Bun.sleep(50);
  check(await focusAway.evaluate((element) => element === document.activeElement), "successful async move stole focus after the user moved it to another control");
  await page.unroute(`${api}/actions/move_work_item`);
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-4` }).press("ArrowRight");
  await page.locator('[data-testid="column-In Progress"] [data-testid="card-MOB-4"]').waitFor();

  // A successful Action followed by a stale board snapshot reaches the queue timeout; focus must stay elsewhere then too.
  const resetDb = createDatabase();
  const [deltaBeforeTimeout] = await resetDb.db.select({ stateId: workItems.stateId }).from(workItems).where(eq(workItems.id, deltaId!));
  await resetDb.client.end();
  await page.route(`${api}/actions/move_work_item`, async (route) => {
    const response = await route.fetch();
    const rollback = createDatabase();
    await rollback.db.update(workItems).set({ stateId: deltaBeforeTimeout!.stateId }).where(eq(workItems.id, deltaId!));
    await rollback.client.end();
    await route.fulfill({ response });
  });
  await page.route(`${api}/actions/list_work_items`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  const staleRefresh = page.waitForResponse((response) => response.url().endsWith("/actions/list_work_items"));
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-4` }).press("ArrowLeft");
  await staleRefresh;
  await focusAway.focus();
  await page.waitForTimeout(2200);
  check(await focusAway.evaluate((element) => element === document.activeElement), "keyboard move timeout stole focus after the user moved it elsewhere");
  await page.unroute(`${api}/actions/move_work_item`);
  await page.unroute(`${api}/actions/list_work_items`);
  await page.reload();
  await page.locator('[data-testid="column-In Progress"] [data-testid="card-MOB-4"]').waitFor();

  // A failed Action must not leave a previous success announcement or move the card.
  await page.route(`${api}/actions/move_work_item`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "temporary failure" }) }));
  const failedMoveResponse = page.waitForResponse((response) => response.url().endsWith("/actions/move_work_item") && response.status() === 500);
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-4` }).press("ArrowRight");
  await failedMoveResponse;
  await page.waitForTimeout(150);
  check(await page.locator('[data-testid="column-In Progress"] [data-testid="card-MOB-4"]').count() === 1, "failed keyboard move changed the card's column");
  check(await page.evaluate(() => document.activeElement?.getAttribute("data-reorder")) === deltaId, "failed move did not retain focus on the card handle");
  check((await page.locator('[data-testid="board"] [role="status"]').textContent()) === "", "failed keyboard move left a misleading success announcement");
  await page.unroute(`${api}/actions/move_work_item`);

  // A successful move whose following list refresh fails must not be announced as confirmed or replay queued arrows against stale columns.
  let refreshFailureMoves = 0;
  await page.route(`${api}/actions/move_work_item`, async (route) => { refreshFailureMoves += 1; await route.continue(); });
  await page.route(`${api}/actions/list_work_items`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary refresh failure" }) }));
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-1` }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(2200);
  await page.getByRole("alert").getByText("The move was saved, but the board could not refresh. Reload the page to see the latest order.").waitFor({ timeout: 5000 });
  check(refreshFailureMoves === 1, `stale board replayed a queued move ${refreshFailureMoves} times`);
  check((await page.locator('[data-testid="board"] [role="status"]').textContent()) === "", "unconfirmed keyboard move was announced as successful");
  check(await page.evaluate(() => document.activeElement?.getAttribute("data-reorder")) === await page.getByTestId("card-MOB-1").getAttribute("data-card-id"), "timed-out refresh lost focus from the reorder handle");
  await page.unroute(`${api}/actions/list_work_items`);
  await page.unroute(`${api}/actions/move_work_item`);
  await page.reload();
  await page.locator('[data-testid="column-Todo"] [data-testid="card-MOB-1"]').waitFor();
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-1` }).press("ArrowLeft");
  await page.locator('[data-testid="column-Backlog"] [data-testid="card-MOB-1"]').waitFor();

  // A moved item can leave the active filter; focus and confirmation must remain available.
  const deltaCardId = await page.getByTestId("card-MOB-4").getAttribute("data-card-id");
  await page.route(`${api}/actions/list_work_items`, async (route) => {
    const response = await route.fetch();
    const items = await response.json() as Array<{ id: string }>;
    await route.fulfill({ response, json: items.filter((item) => item.id !== deltaCardId) });
  });
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-4` }).press("ArrowRight");
  await page.getByTestId("card-MOB-4").waitFor({ state: "detached" });
  await page.getByRole("status").getByText(translate("board.movedTo").replace("{name}", "MOB-4").replace("{column}", "Done")).waitFor({ timeout: 5000 });
  check(await page.getByTestId("board").evaluate((element) => element === document.activeElement), "filtered move lost focus instead of returning it to the board");
  await page.unroute(`${api}/actions/list_work_items`);
  await page.reload();
  await page.getByTestId("card-MOB-4").waitFor();

  // A column collapses to a narrow strip and expands again.
  await page.getByRole("button", { name: `${translate("layout.toggleGroup")}: Todo` }).click();
  check(await page.locator('[data-testid="column-Todo"][data-collapsed]').count() === 1, "Todo did not collapse");
  await page.getByRole("button", { name: `${translate("layout.toggleGroup")}: Todo` }).click();
  await page.getByTestId("card-MOB-3").waitFor();

  // Board grouped by priority: dragging a card into a column changes its priority.
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("priority");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(page.url().includes("layout=board") && page.url().includes("group=priority"), "board group is not in the URL");
  const high = translate("workItems.priority.high");
  await page.getByTestId("card-MOB-1").dragTo(page.getByTestId(`column-${high}`));
  await page.waitForFunction((name) => document.querySelector(`[data-testid="column-${name}"] [data-testid="card-MOB-1"]`), high);
  await page.reload();
  await page.getByTestId("card-MOB-1").waitFor();
  check((await titlesIn(page, high)).join() === "Alpha", "priority drag did not persist");
  // Priority uses server ordering: moving Delta behind every existing High card exposes a false computed index.
  const bravoReorder = page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-2` });
  await bravoReorder.focus();
  for (const priority of ["low", "medium", "high"]) {
    await page.keyboard.press("ArrowLeft");
    const name = translate(`workItems.priority.${priority}` as "workItems.priority.low");
    await page.locator(`[data-testid="column-${name}"] [data-testid="card-MOB-2"]`).waitFor();
  }
  check((await titlesIn(page, high)).join() === "Bravo,Alpha", "priority keyboard move did not land in High in manual order");
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-3` }).focus();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowLeft");
  await page.locator(`[data-testid="column-${high}"] [data-testid="card-MOB-3"]`).waitFor();
  check((await titlesIn(page, high)).includes("Charlie"), "priority keyboard move did not land in High");
  const nonePriority = translate("workItems.priority.none");
  const prioritySourceIndex = (await titlesIn(page, nonePriority)).indexOf("Delta");
  const priorityInsertionPosition = Math.min(prioritySourceIndex, (await titlesIn(page, high)).length) + 1;
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-4` }).focus();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowLeft");
  await page.locator(`[data-testid="column-${high}"] [data-testid="card-MOB-4"]`).waitFor();
  const highTitles = await titlesIn(page, high);
  check(highTitles.indexOf("Delta") + 1 !== priorityInsertionPosition, `fixture did not expose server ordering: ${JSON.stringify(highTitles)}`);
  const priorityAnnouncement = await page.locator('[data-testid="board"] [role="status"]').textContent();
  check(priorityAnnouncement?.includes("MOB-4 moved to High") && !priorityAnnouncement.includes("position"), "priority announcement claimed an unsupported position");
  await page.screenshot({ path: `${shots}/board-priority-1440.png` });

  // Assignee grouping also orders cards by the board's existing manual sort, independently of the drop index.
  for (const id of ["MOB-1", "MOB-2"]) {
    await page.getByTestId(`card-${id}`).getByRole("button", { name: new RegExp(translate("workItems.assignees")) }).click();
    await page.getByRole("menuitemcheckbox", { name: "Kanban Tester" }).click();
    await page.keyboard.press("Escape");
  }
  await page.goto(page.url().replace(/[?].*/, "?layout=board&group=assignee"));
  await page.getByTestId("card-MOB-4").waitFor();
  const personColumn = "Kanban Tester";
  const noAssignee = translate("layout.unassigned");
  const assigneeSourceIndex = (await titlesIn(page, noAssignee)).indexOf("Delta");
  const assigneeInsertionPosition = Math.min(assigneeSourceIndex, (await titlesIn(page, personColumn)).length) + 1;
  await page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-4` }).focus();
  await page.keyboard.press("ArrowLeft");
  await page.locator(`[data-testid="column-${personColumn}"] [data-testid="card-MOB-4"]`).waitFor();
  const assignedTitles = await titlesIn(page, personColumn);
  check(assignedTitles.indexOf("Delta") + 1 !== assigneeInsertionPosition, `fixture did not expose assignee ordering: ${JSON.stringify(assignedTitles)}`);
  check((await page.locator('[data-testid="board"] [role="status"]').textContent())?.includes(`MOB-4 moved to ${personColumn}`), "assignee move announcement omitted its destination");
  check(!(await page.locator('[data-testid="board"] [role="status"]').textContent())?.includes("position"), "assignee announcement claimed an unsupported position");
  const focusedAssigneeHandle = await page.evaluate(() => document.activeElement?.getAttribute("data-reorder"));
  check(focusedAssigneeHandle === await page.getByTestId("card-MOB-4").getAttribute("data-card-id"), `assignee cross-column move did not restore focus: active=${focusedAssigneeHandle ?? "none"}`);

  // A work item with two Assignees appears in both columns; moving from the second column follows the pointer drop semantics.
  const colleagueId = `zz-kanban-colleague-${slug}`;
  const setupDb = createDatabase();
  const [workspace] = await setupDb.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug));
  const [project] = await setupDb.db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, workspace!.id), eq(projects.key, "MOB")));
  const [firstItem] = await setupDb.db.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.projectId, project!.id), eq(workItems.sequence, 1)));
  await setupDb.db.insert(users).values({ id: colleagueId, name: "Kanban Colleague", email: `e2e-${slug}@example.test` });
  await setupDb.db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: colleagueId, role: "Member" });
  await setupDb.db.insert(projectMembers).values({ workspaceId: workspace!.id, projectId: project!.id, userId: colleagueId, role: "Member" });
  await setupDb.db.insert(workItemAssignees).values({ workItemId: firstItem!.id, userId: colleagueId });
  await setupDb.client.end();
  await page.reload();
  await page.locator('[data-testid="column-Kanban Tester"] [data-testid="card-MOB-1"]').waitFor();
  const colleagueCard = page.getByTestId(`column-Kanban Colleague`).getByTestId("card-MOB-1");
  const colleagueHandle = colleagueCard.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-1` });
  // Dropping within the same assignee column must preserve every assignee.
  await colleagueCard.dragTo(page.getByTestId("column-Kanban Colleague"));
  await page.waitForTimeout(500);
  await page.reload();
  await colleagueCard.waitFor();
  await page.locator('[data-testid="column-Kanban Tester"] [data-testid="card-MOB-1"]').waitFor();
  // Moving from the second assignee to the first must still reduce the assignment to that destination.
  await colleagueHandle.press("ArrowLeft");
  await colleagueCard.waitFor({ state: "detached", timeout: 5000 });
  await page.locator('[data-testid="column-Kanban Tester"] [data-testid="card-MOB-1"]').waitFor();
  const restoreDb = createDatabase();
  await restoreDb.db.insert(workItemAssignees).values({ workItemId: firstItem!.id, userId: colleagueId });
  await restoreDb.client.end();
  await page.reload();
  await colleagueHandle.waitFor();
  await colleagueHandle.press("ArrowRight");
  await page.locator(`[data-testid="column-${noAssignee}"] [data-testid="card-MOB-1"]`).waitFor();
  check(await page.locator(`[data-testid="column-Kanban Tester"] [data-testid="card-MOB-1"]`).count() === 0, "moving a multi-assignee card from its second assignee did not clear its previous assignments");
  check(await page.locator(`[data-testid="column-Kanban Colleague"] [data-testid="card-MOB-1"]`).count() === 0, "keyboard move used the first matching assignee column instead of the originating column");
  // Query-defined ordering cannot be changed by a keyboard move of the manual order.
  await page.goto(page.url().replace(/[?].*/, "?layout=board&q=ORDER%20BY%20title"));
  const sortedHandle = page.getByRole("button", { name: `${translate("sortable.reorder")}: MOB-2` });
  await sortedHandle.waitFor();
  check(!((await sortedHandle.getAttribute("aria-keyshortcuts")) ?? "").includes("ArrowUp"), "query-sorted board advertises unavailable manual reordering");
  let sortedMoves = 0;
  await page.route(`${api}/actions/move_work_item`, async (route) => { sortedMoves += 1; await route.continue(); });
  await sortedHandle.press("ArrowUp");
  await page.waitForTimeout(200);
  check(sortedMoves === 0, "query-sorted board changed hidden manual order");
  await page.unroute(`${api}/actions/move_work_item`);
  await page.goto(page.url().replace(/[?].*/, "?layout=board"));
  await page.getByTestId("card-MOB-2").waitFor();
  await page.screenshot({ path: `${shots}/board-state-1440.png` });

  // Touch at 390px: a long-press picks the card up, the board scrolls at its edge, lifting drops it in that column.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByTestId("card-MOB-2").waitFor();
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, x?: number, y?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: x!, y: y! }] });
  const centre = async (testId: string) => { const box = (await page.getByTestId(testId).boundingBox())!; return { x: box.x + box.width / 2, y: box.y + 14 }; };
  await page.screenshot({ path: `${shots}/board-state-390.png` });
  const from = await centre("card-MOB-2");
  await touch("touchStart", from.x, from.y);
  await Bun.sleep(450);
  for (let step = 1; step <= 10; step += 1) { await touch("touchMove", from.x + ((375 - from.x) * step) / 10, from.y); await Bun.sleep(30); }
  await page.getByTestId("column-Todo").waitFor();
  for (let attempt = 0; attempt < 40; attempt += 1) { const todo = (await page.getByTestId("column-Todo").boundingBox())!; if (todo.x + 40 < 350) break; await Bun.sleep(100); }
  const todo = (await page.getByTestId("column-Todo").boundingBox())!;
  await touch("touchMove", Math.min(todo.x + 60, 340), todo.y + 30);
  await Bun.sleep(100);
  await page.screenshot({ path: `${shots}/board-touch-drag-390.png` });
  await touch("touchEnd");
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Todo"] [data-testid="card-MOB-2"]'));
  await page.reload();
  await page.getByTestId("card-MOB-2").waitFor();
  check((await titlesIn(page, "Todo")).includes("Bravo"), "touch drag did not persist");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page scrolls sideways at 390px");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Filters and grouping are in the URL and survive a reload.
  await page.getByRole("button", { name: translate("layout.list") }).click();
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("priority");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByRole("button", { name: translate("layout.filters") }).click();
  await page.getByRole("dialog", { name: translate("layout.filters") }).getByRole("button", { name: translate("layout.filter.state") }).click();
  await page.getByRole("group", { name: translate("layout.filter.state") }).getByRole("checkbox", { name: "Todo" }).click();
  check(page.url().includes("group=priority") && page.url().includes("q="), "filters are not in the URL");
  await page.reload();
  await page.getByRole("link", { name: /Charlie/ }).waitFor();
  check(await page.getByRole("link", { name: /Alpha/ }).count() === 0, "filter did not survive reload");

  // The drag wrote an Activity on the card.
  await page.getByRole("link", { name: /Charlie/ }).click();
  // The timeline opens on Comments; the state change is an Activity entry.
  await page.getByRole("combobox", { name: translate("timeline.filter", "en"), exact: true }).selectOption("all");
  await page.getByText(translate("workItems.activity.changed").replace("{field}", "state")).waitFor();
  console.log("e2e kanban: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  // The flow commits real rows (the servers use their own connections), so remove them: other tests expect an empty instance.
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
