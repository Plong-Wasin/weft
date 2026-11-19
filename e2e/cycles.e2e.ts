// Browser end-to-end flow: create a Cycle, add a work item to it, and see the progress.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3108);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5208);
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

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage();
  const call = async <T>(name: string, body: unknown) => { const response = await page.context().request.post(`${api}/actions/${name}`, { data: body }); if (!response.ok()) throw new Error(`${name} failed: ${response.status()}`); return await response.json() as T; };
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
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
  page.on("dialog", (dialog) => void dialog.accept());
  const addCycle = async (name: string, start: string, end: string) => {
    await page.getByRole("button", { name: translate("cycles.new"), exact: true }).click();
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
  await (await addCycle("Sprint 1", day(-1), day(6))).click();
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
  await page.screenshot({ path: `${shots}/cycles-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/cycles-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Detail: add a work item, see progress and the state breakdown.
  await page.getByRole("link", { name: "Sprint 1" }).click();
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
  await page.getByLabel(`${translate("cycles.selectCandidate")} MOB-1`).check();
  await page.getByRole("button", { name: translate("cycles.addSelected").replace("{count}", "1"), exact: true }).click();
  await page.getByRole("dialog", { name: translate("cycles.addTitle") }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: translate("cycles.remove"), exact: true }).waitFor();
  // Search finds a work item already in another Cycle, shows its membership, and requires opting into the move.
  await page.getByRole("link", { name: translate("cycles.back") }).click();
  await tab("upcoming").click();
  await page.getByRole("link", { name: "Sprint 2" }).click();
  await page.getByRole("button", { name: translate("cycles.addItems"), exact: true }).click();
  const search = page.getByRole("dialog", { name: translate("cycles.addTitle") }).getByLabel(translate("cycles.searchCandidates"));
  await search.fill("Alpha");
  await page.getByText(translate("cycles.currentCycle").replace("{name}", "Sprint 1"), { exact: true }).waitFor();
  const candidate = page.getByLabel(`${translate("cycles.selectCandidate")} MOB-1`);
  check(!(await candidate.isEnabled()), "an item in another Cycle must not be selectable without the move choice");
  await page.getByLabel(translate("cycles.allowMove")).check();
  await candidate.check();
  await page.getByRole("button", { name: translate("cycles.addSelected").replace("{count}", "1"), exact: true }).click();
  await page.getByRole("dialog", { name: translate("cycles.addTitle") }).waitFor({ state: "detached" });
  await page.getByRole("link", { name: translate("cycles.back") }).click();
  await tab("active").click();
  await page.getByRole("link", { name: "Sprint 1" }).click();
  await page.getByRole("button", { name: translate("cycles.addItems"), exact: true }).click();
  await page.getByLabel(translate("cycles.allowMove")).check();
  await page.getByLabel(`${translate("cycles.selectCandidate")} MOB-1`).check();
  await page.getByRole("button", { name: translate("cycles.addSelected").replace("{count}", "1"), exact: true }).click();
  await page.getByRole("dialog", { name: translate("cycles.addTitle") }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: translate("cycles.remove"), exact: true }).waitFor();
  const progress = await page.getByTestId("cycle-progress").first().getAttribute("title");
  if (progress !== translate("cycles.progressOf").replace("{done}", "0").replace("{total}", "1")) throw new Error(`unexpected progress: ${progress}`);
  await page.getByTestId("cycle-breakdown").waitFor();
  await page.getByTestId("cycle-burndown").getByRole("status").filter({ hasText: "Initial scope: unknown" }).waitFor();
  // The item entered this Cycle twice and left it once in the move round-trip above.
  await page.getByText(/Scope added \/ removed:.*\+2 \/ −1/).waitFor();
  await page.screenshot({ path: `${shots}/cycle-detail-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/cycle-detail-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Edit: move Sprint 1 into the past so it is Completed, then transfer its unfinished work to Sprint 2.
  await page.getByRole("button", { name: `${translate("cycles.menu")}: Sprint 1` }).click();
  await page.getByRole("menuitem", { name: translate("cycles.edit") }).click();
  await page.getByLabel(translate("cycles.start")).fill(day(-5));
  await page.getByLabel(translate("cycles.end")).fill(day(-2));
  await page.getByRole("button", { name: translate("cycles.save"), exact: true }).click();
  await page.getByTestId("cycle-burndown").getByText(/Reporting dates changed/).waitFor();
  await page.getByTestId("cycle-burndown").getByText(translate("cycles.history.noCoverage")).waitFor();
  await page.getByTestId("cycle-transfer").waitFor();
  await page.getByLabel(translate("cycles.transferTarget")).selectOption({ label: "Sprint 2" });
  await page.getByRole("button", { name: translate("cycles.transfer"), exact: true }).click();
  await page.getByText(translate("cycles.transferred").replace("{count}", "1")).waitFor();

  // Archive the completed Cycle, then it leaves the list until "show archived" is ticked.
  await page.getByRole("button", { name: `${translate("cycles.menu")}: Sprint 1` }).click();
  await page.getByRole("menuitem", { name: translate("cycles.archive") }).click();
  await page.getByText(translate("cycles.archived")).waitFor();
  await page.getByRole("link", { name: translate("cycles.back") }).click();
  await tab("completed").click();
  check(!(await page.getByRole("link", { name: "Sprint 1" }).isVisible()), "archived Cycle must leave the list");
  await page.getByLabel(translate("cycles.showArchived")).check();
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
  await page.screenshot({ path: `${shots}/active-cycles-1440.png` });
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
