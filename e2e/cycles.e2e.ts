// Browser end-to-end flow: create a Cycle, add a work item to it, and see the progress.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { check, launchBrowser, newPage, startApi, startWeb, waitFor } from "./harness";
import type { Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3108);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5208);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const auditAfter = "/tmp/weft-ui-audit/after/cycles";
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const page = await newPage(browser);
  const call = async <T>(name: string, body: unknown) => { const response = await page.context().request.post(`${api}/actions/${name}`, { data: body }); if (!response.ok()) throw new Error(`${name} failed: ${response.status()}`); return await response.json() as T; };
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Cycles Tester");
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
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();

  // An empty project shows the empty state, so its Add work item button creates the first item in the modal.
  await page.getByRole("status").filter({ hasText: translate("workItems.emptyHint") }).getByRole("button", { name: translate("workItems.addNew"), exact: true }).click();
  const modal = page.getByRole("dialog", { name: translate("workItems.modal.title") });
  await modal.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Alpha");
  await modal.getByRole("button", { name: translate("workItems.modal.submit"), exact: true }).click();
  await page.getByRole("link", { name: /Alpha/ }).waitFor();

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const shots = reviewShots("12-cycles-ui");
  await mkdir(shots, { recursive: true });
  await mkdir(auditAfter, { recursive: true });
  page.on("dialog", (dialog) => void dialog.accept());
  const addCycle = async (name: string, start: string, end: string) => {
    const trigger = page.getByRole("button", { name: translate("cycles.new"), exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: translate("cycles.newTitle") });
    check(await dialog.evaluate((element) => element.contains(document.activeElement)), "Cycle dialog did not receive focus when opened");
    await page.getByLabel(translate("cycles.name")).fill(name);
    await page.getByLabel(translate("cycles.start")).fill(start);
    await page.getByLabel(translate("cycles.end")).fill(end);
    const toolbar = page.getByRole("toolbar", { name: translate("wiki.toolbar") });
    await toolbar.getByRole("button", { name: translate("editor.sourceMode") }).click();
    await page.getByRole("textbox", { name: translate("editor.sourceText") }).fill("**Initial cycle purpose**");
    await toolbar.getByRole("button", { name: translate("editor.sourceMode") }).click();
    return page.getByRole("button", { name: translate("cycles.create"), exact: true });
  };
  const tab = (status: string) => page.getByRole("tab", { name: new RegExp(`^${translate(`cycles.status.${status}`)}`) });
  await page.getByRole("link", { name: translate("cycles.title"), exact: true }).click();
  await page.getByText(translate("cycles.empty")).waitFor();

  // Create (modal), with an Upcoming Cycle whose dates overlap Sprint 1: a warning shows and saving is still allowed.
  const create1 = await addCycle("Sprint 1", day(-1), day(6));
  const cycleDialog = page.getByRole("dialog", { name: translate("cycles.newTitle") });
  const cycleDialogBounds = await cycleDialog.boundingBox();
  if (!cycleDialogBounds) throw new Error("Cycle dialog has no rendered bounds");
  await page.mouse.click(cycleDialogBounds.x + 6, cycleDialogBounds.y + 6);
  check(await cycleDialog.isVisible(), "clicking blank Cycle dialog padding dismissed it");
  await page.getByLabel(translate("cycles.name")).focus();
  await page.keyboard.press("Shift+Tab");
  check(await cycleDialog.evaluate((element) => element.contains(document.activeElement)), "keyboard focus escaped the Cycle dialog");
  await create1.click();
  await page.getByRole("dialog", { name: translate("cycles.newTitle") }).waitFor({ state: "detached" });
  check(await page.getByRole("button", { name: translate("cycles.new"), exact: true }).evaluate((element) => element === document.activeElement), "focus did not return to the Cycle dialog trigger");
  await page.getByRole("button", { name: translate("cycles.new"), exact: true }).click();
  await page.mouse.click(8, 8);
  await page.getByRole("dialog", { name: translate("cycles.newTitle") }).waitFor({ state: "detached" });
  check(await page.getByRole("button", { name: translate("cycles.new"), exact: true }).evaluate((element) => element === document.activeElement), "backdrop dismissal did not return focus to the Cycle dialog trigger");
  await page.getByRole("link", { name: "Sprint 1" }).waitFor();
  const create2 = await addCycle("Sprint 2", day(3), day(10));
  await page.getByTestId("cycle-overlap").waitFor();
  check(await create2.isEnabled(), "overlap warning must not block saving");
  await create2.click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await tab("upcoming").click();
  await page.getByRole("link", { name: "Sprint 2" }).waitFor();
  check(!(await page.getByRole("link", { name: "Sprint 1" }).isVisible()), "Upcoming tab must not list the active Cycle");
  await tab("active").click();

  // Screenshots of the list at both widths.
  await page.setViewportSize({ width: 1440, height: 900 });
  await saveShot(page, { path: `${shots}/cycles-1440.png` });
  await saveShot(page, { path: `${auditAfter}/cycles-1440-light.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await saveShot(page, { path: `${auditAfter}/cycles-1440-dark.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.setViewportSize({ width: 390, height: 844 });
  await saveShot(page, { path: `${shots}/cycles-390.png` });
  const ringFont = await page.getByRole("img", { name: /^Progress \d+%$/ }).first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  check(ringFont >= 11, `progress ring text is ${ringFont}px at 390px`);
  check(await page.getByRole("link", { name: "Sprint 1" }).getAttribute("title") === "Sprint 1", "truncated Cycle name has no full-text title");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Detail: add a work item, see progress and the state breakdown.
  await page.getByRole("link", { name: "Sprint 1" }).click();
  const detailsToggle = page.getByRole("button", { name: translate("detailsPanel.hide") });
  const cycleDetails = page.getByRole("complementary", { name: translate("cycles.details"), exact: true });
  check(await detailsToggle.getAttribute("aria-expanded") === "true", "Cycle details toggle must expose its expanded state");
  check(await detailsToggle.getAttribute("aria-controls") === "cycle-details-panel", "Cycle details toggle must control its panel");
  await detailsToggle.click();
  await page.getByRole("button", { name: translate("detailsPanel.show") }).waitFor();
  check(await page.getByRole("complementary", { name: translate("cycles.details"), exact: true }).count() === 0, "a hidden Cycle details panel must leave the accessibility tree");
  await page.keyboard.press("Control+i");
  await cycleDetails.waitFor();
  await mkdir(".local/shots/09", { recursive: true });
  await page.reload();
  await page.getByRole("button", { name: translate("detailsPanel.hide") }).waitFor();
  check(await cycleDetails.isVisible(), "Cycle details must reopen after reload when the stored state is open");
  await page.getByRole("button", { name: translate("detailsPanel.hide") }).click();
  await page.reload();
  await page.getByRole("button", { name: translate("detailsPanel.show") }).waitFor();
  check(await page.getByRole("complementary", { name: translate("cycles.details"), exact: true }).count() === 0, "the hidden Cycle details state must survive reload");
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `hidden Cycle panel causes horizontal page scroll at ${width}px`);
  }
  await page.keyboard.press("Control+i");
  await cycleDetails.waitFor();
  await page.evaluate(() => { try { localStorage.setItem("weft.theme", "light"); document.documentElement.dataset.theme = "light"; } catch { /* screenshot still uses the active theme */ } });
  await saveShot(page, { path: ".local/shots/09/cycle-details-1440-light-open.png" });
  await page.getByRole("button", { name: translate("detailsPanel.hide") }).click();
  await saveShot(page, { path: ".local/shots/09/cycle-details-1440-light-hidden.png" });
  await page.evaluate(() => { try { localStorage.setItem("weft.theme", "dark"); document.documentElement.dataset.theme = "dark"; } catch { /* screenshot still uses the active theme */ } });
  await page.getByRole("button", { name: translate("detailsPanel.show") }).click();
  await saveShot(page, { path: ".local/shots/09/cycle-details-1440-dark-open.png" });
  await page.getByRole("button", { name: translate("detailsPanel.hide") }).click();
  await saveShot(page, { path: ".local/shots/09/cycle-details-1440-dark-hidden.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  check(await cycleDetails.isVisible(), "Cycle details remain stacked and visible on mobile");
  await saveShot(page, { path: ".local/shots/09/cycle-details-390-dark-stacked.png" });
  await page.evaluate(() => { try { localStorage.setItem("weft.theme", "light"); document.documentElement.dataset.theme = "light"; } catch { /* screenshot still uses the active theme */ } });
  await saveShot(page, { path: ".local/shots/09/cycle-details-390-light-stacked.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.getByRole("button", { name: translate("detailsPanel.show") }).isVisible() === false, "the Details toggle is hidden below lg");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: translate("detailsPanel.show") }).click();
  const descriptionEditor = page.locator('[data-testid="description-editor"] [contenteditable="true"]');
  await page.context().route("**/actions/update_cycle", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "temporary save failure" }) }));
  const descriptionToolbar = page.getByRole("toolbar", { name: translate("wiki.toolbar") });
  await descriptionToolbar.getByRole("button", { name: translate("editor.sourceMode") }).click();
  await page.getByRole("textbox", { name: translate("editor.sourceText") }).fill("**Preserved after an error**");
  await descriptionToolbar.getByRole("button", { name: translate("editor.sourceMode") }).click();
  await page.getByTestId("entity-description-save-status").getByText(translate("workItems.descriptionSave.failed")).waitFor();
  check(await descriptionEditor.locator("strong").filter({ hasText: "Preserved after an error" }).count() === 1, "failed description save discarded the editor contents");
  await page.context().unroute("**/actions/update_cycle");
  await page.getByRole("button", { name: translate("workItems.descriptionSave.retry") }).click();
  await page.getByTestId("entity-description-save-status").getByText(translate("workItems.descriptionSave.saved")).waitFor();
  await page.getByRole("toolbar", { name: translate("wiki.toolbar") }).getByRole("button", { name: translate("editor.sourceMode") }).click();
  const currentMe = await (await page.context().request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [currentProject] = await call<Array<{ id: string }>>("list_projects", { workspaceId: currentMe.workspaces[0]!.id, archived: false });
  const workItems = await call<Array<{ id: string; displayId: string }>>("list_work_items", { projectId: currentProject!.id });
  const people = await call<Array<{ userId: string; name: string }>>("list_project_members", { projectId: currentProject!.id });
  const cycleDescriptionMarkdown = `**Updated cycle purpose** with [[MOB-1|work-item:${workItems[0]!.id}]] and @{Cycles Tester|${people.find(({ name }) => name === "Cycles Tester")!.userId}}.`;
  await page.getByRole("textbox", { name: translate("editor.sourceText") }).fill(cycleDescriptionMarkdown);
  await page.getByRole("toolbar", { name: translate("wiki.toolbar") }).getByRole("button", { name: translate("editor.sourceMode") }).click();
  await page.getByRole("heading", { name: translate("cycles.workItems") }).click();
  await page.getByTestId("entity-description-save-status").getByText(translate("workItems.descriptionSave.saving")).waitFor();
  await page.getByTestId("entity-description-save-status").getByText(translate("workItems.descriptionSave.saved")).waitFor();
  const cycleDescription = await call<{ descriptionMarkdown: string }>("get_cycle", { cycleId: (await call<Array<{ id: string; name: string }>>("list_cycles", { projectId: currentProject!.id })).find(({ name }) => name === "Sprint 1")!.id });
  check(cycleDescription.descriptionMarkdown.includes(`work-item:${workItems[0]!.id}`) && cycleDescription.descriptionMarkdown.includes(`@{Cycles Tester|${people.find(({ name }) => name === "Cycles Tester")!.userId}}`), "Cycle description references did not round-trip");
  check(await descriptionEditor.locator("strong").filter({ hasText: "Updated cycle purpose" }).count() === 1, "Cycle rich formatting did not render safely");
  await page.getByRole("button", { name: translate("cycles.addItems"), exact: true }).click();
  await page.getByRole("checkbox", { name: `${translate("cycles.selectCandidate")} MOB-1` }).click();
  await page.getByRole("button", { name: translate("cycles.addSelected").replace("{count}", "1"), exact: true }).click();
  await page.getByRole("dialog", { name: translate("cycles.addTitle") }).waitFor({ state: "detached" });
  const itemRow = page.getByTestId("row-MOB-1");
  const rowAction = itemRow.getByRole("button", { name: `${translate("cycles.menu")}: MOB-1` });
  await rowAction.waitFor();
  check(await itemRow.getByRole("button", { name: translate("cycles.remove"), exact: true }).count() === 0, "Cycle removal must stay inside the row action menu");
  const rowHeights = await page.getByTestId(/^row-MOB-/).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  check(rowHeights.every((height) => height === rowHeights[0]), `Cycle work item rows have unequal heights: ${rowHeights.join(", ")}`);
  await rowAction.click();
  await page.getByRole("menuitem", { name: translate("cycles.remove"), exact: true }).waitFor();
  await page.keyboard.press("Escape");
  // Search finds a work item already in another Cycle, shows its membership, and requires opting into the move.
  await page.getByRole("link", { name: translate("cycles.title"), exact: true }).click();
  await tab("upcoming").click();
  await page.getByRole("link", { name: "Sprint 2" }).click();
  await page.getByRole("button", { name: translate("cycles.addItems"), exact: true }).click();
  const search = page.getByRole("dialog", { name: translate("cycles.addTitle") }).getByLabel(translate("cycles.searchCandidates"));
  await search.fill("Alpha");
  await page.getByText(translate("cycles.currentCycle").replace("{name}", "Sprint 1"), { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.getByRole("dialog", { name: translate("cycles.addTitle") }).evaluate((element) => element.scrollWidth <= element.clientWidth), "add-items dialog scrolls sideways at 390px");
  await page.setViewportSize({ width: 1440, height: 900 });
  const candidate = page.getByRole("checkbox", { name: `${translate("cycles.selectCandidate")} MOB-1` });
  check(!(await candidate.isEnabled()), "an item in another Cycle must not be selectable without the move choice");
  await page.getByRole("checkbox", { name: translate("cycles.allowMove") }).click();
  await candidate.click();
  await page.getByRole("button", { name: translate("cycles.addSelected").replace("{count}", "1"), exact: true }).click();
  await page.getByRole("dialog", { name: translate("cycles.addTitle") }).waitFor({ state: "detached" });
  await page.getByRole("link", { name: translate("cycles.title"), exact: true }).click();
  await tab("active").click();
  await page.getByRole("link", { name: "Sprint 1" }).click();
  await page.getByRole("button", { name: translate("cycles.addItems"), exact: true }).click();
  await page.getByRole("checkbox", { name: translate("cycles.allowMove") }).click();
  await page.getByRole("checkbox", { name: `${translate("cycles.selectCandidate")} MOB-1` }).click();
  await page.getByRole("button", { name: translate("cycles.addSelected").replace("{count}", "1"), exact: true }).click();
  await page.getByRole("dialog", { name: translate("cycles.addTitle") }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: `${translate("cycles.menu")}: MOB-1` }).waitFor();
  const progress = await page.getByTestId("cycle-progress").first().getAttribute("title");
  if (progress !== translate("cycles.progressOf").replace("{done}", "0").replace("{total}", "1")) throw new Error(`unexpected progress: ${progress}`);
  await page.getByTestId("cycle-breakdown").waitFor();
  await saveShot(page, { path: `${auditAfter}/cycle-detail-1440-light.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await saveShot(page, { path: `${auditAfter}/cycle-detail-1440-dark.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.setViewportSize({ width: 820, height: 1180 });
  await saveShot(page, { path: `${auditAfter}/cycle-detail-820-light.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  // Creation starts history coverage after yesterday's Cycle start, so this range has no EOD observation yet.
  await page.getByTestId("cycle-burndown").getByRole("status").filter({ hasText: translate("cycles.history.noCoverage") }).waitFor();
  // The item entered this Cycle twice and left it once in the move round-trip above.
  await page.getByText(/Scope added \/ removed:.*\+2 \/ −1/).waitFor();
  const today = day(0);
  const yesterday = day(-1);
  const twoDaysAgo = day(-2);
  await page.context().route("**/actions/get_cycle_burndown", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    cycleId: "rendered-burndown-fixture", unit: "items", startDate: twoDaysAgo, endDate: today, total: 3, initialScope: 3,
    finalOutcome: null, outcomeDate: null, initialPoints: null, unestimated: null, coverageStart: `${twoDaysAgo}T00:00:00.000Z`, dateChanges: [], scopeChanges: [],
    days: [
      { date: twoDaysAgo, open: 3, ideal: 3, unknown: false },
      { date: yesterday, open: 2, ideal: 2, unknown: false },
      { date: today, open: 1, ideal: 1, unknown: false },
    ],
  }) }));
  await page.reload();
  await page.getByTestId("cycle-burndown").locator("svg").waitFor();
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    const colors = await page.getByTestId("cycle-burndown").locator("svg").evaluate((svg) => {
      const labels = [...svg.querySelectorAll("text")];
      const actualLine = svg.querySelector("polyline:not([stroke-dasharray])");
      const tokenColor = (property: string) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${property})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      return { labels: labels.map((label) => getComputedStyle(label).fill), expectedLabel: tokenColor("--muted-foreground"), actualLine: actualLine ? getComputedStyle(actualLine).stroke : null, expectedLine: tokenColor("--primary") };
    });
    check(colors.labels.length > 0 && colors.labels.every((color) => color === colors.expectedLabel), `${theme} Cycle burndown labels do not use the readable secondary text token: ${JSON.stringify(colors)}`);
    check(colors.actualLine === colors.expectedLine, `${theme} Cycle burndown actual line does not use the accent token: ${JSON.stringify(colors)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await saveShot(page, { path: `${shots}/cycle-detail-1440-${theme}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await saveShot(page.getByTestId("cycle-burndown"), { path: `${shots}/cycle-detail-390-${theme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().unroute("**/actions/get_cycle_burndown");
  await page.reload();
  await page.getByTestId("cycle-burndown").getByRole("status").filter({ hasText: translate("cycles.history.noCoverage") }).waitFor();

  // Edit: move Sprint 1 into the past so it is Completed, then transfer its unfinished work to Sprint 2.
  await page.getByRole("button", { name: `${translate("cycles.menu")}: Sprint 1` }).click();
  await page.getByRole("menuitem", { name: translate("cycles.edit") }).click();
  await page.getByLabel(translate("cycles.start")).fill(day(-5));
  await page.getByLabel(translate("cycles.end")).fill(day(-2));
  await page.getByRole("button", { name: translate("cycles.save"), exact: true }).click();
  await page.getByTestId("cycle-burndown").getByText(/Reporting dates changed/).waitFor();
  await page.getByTestId("cycle-burndown").getByText(translate("cycles.history.noCoverage")).waitFor();
  await page.getByTestId("cycle-transfer").waitFor();
  const transferItem = page.getByRole("checkbox", { name: `${translate("cycles.selectTransferItem")} MOB-1` });
  check(await transferItem.getAttribute("aria-checked") === "true", "eligible unfinished work must start selected in the closeout preview");
  await transferItem.click();
  check(!(await page.getByRole("button", { name: translate("cycles.transfer"), exact: true }).isEnabled()), "closeout must require at least one selected item");
  await transferItem.click();
  await page.getByLabel(translate("cycles.transferTarget")).selectOption({ label: "Sprint 2" });
  await page.getByRole("button", { name: translate("cycles.transfer"), exact: true }).click();
  await page.getByText(translate("cycles.transferred").replace("{count}", "1")).waitFor();

  // Archive the completed Cycle, then it leaves the list until "show archived" is ticked.
  await page.getByRole("button", { name: `${translate("cycles.menu")}: Sprint 1` }).click();
  await page.getByRole("menuitem", { name: translate("cycles.archive") }).click();
  await page.getByText(translate("cycles.archived")).waitFor();
  await page.getByRole("link", { name: translate("cycles.title"), exact: true }).click();
  await tab("completed").click();
  check(!(await page.getByRole("link", { name: "Sprint 1" }).isVisible()), "archived Cycle must leave the list");
  await page.getByRole("checkbox", { name: translate("cycles.showArchived") }).click();
  await page.getByRole("link", { name: "Sprint 1" }).waitFor();
  await page.getByRole("link", { name: "Sprint 1" }).click();
  await page.getByRole("button", { name: `${translate("cycles.menu")}: Sprint 1` }).click();
  check(await page.getByRole("menuitem", { name: translate("cycles.edit") }).count() === 0, "archived Cycle still offers Edit");
  check(await page.getByRole("button", { name: translate("cycles.remove"), exact: true }).count() === 0, "archived Cycle still offers membership removal");
  check(await page.locator('[data-testid="description-editor"] [contenteditable="true"]').count() === 0, "archived Cycle description must be read-only");
  await page.getByRole("menuitem", { name: translate("cycles.unarchive") }).click();
  await page.getByText(translate("cycles.archived")).waitFor({ state: "detached" });
  await page.getByRole("button", { name: `${translate("cycles.menu")}: Sprint 1` }).click();
  await page.getByRole("menuitem", { name: translate("cycles.edit") }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: translate("cycles.delete") }).click();
  await page.waitForURL("**/cycles");

  // Delete Sprint 2 from its row menu.
  await tab("upcoming").click();
  await page.getByRole("button", { name: `${translate("cycles.menu")}: Sprint 2` }).click();
  await page.getByRole("menuitem", { name: translate("cycles.delete") }).click();
  // Sprint 2 was the last live Cycle, so the whole project shows the empty state, not the per-tab one.
  await page.getByText(translate("cycles.empty"), { exact: true }).waitFor();

  // Workspace active cycles page.
  await (await addCycle("Sprint 3", day(-1), day(2))).click();
  await tab("active").click();
  await page.getByRole("link", { name: "Sprint 3" }).waitFor();
  await page.getByRole("link", { name: translate("cycles.activeTitle"), exact: true }).click();
  await page.getByRole("link", { name: "Sprint 3" }).waitFor();
  await saveShot(page, { path: `${shots}/active-cycles-1440.png` });
  console.log("e2e cycles: ok");
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
