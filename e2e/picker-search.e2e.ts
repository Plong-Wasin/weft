// Browser check for the searchable pickers: the search field appears only above six options, it is focused on open,
// it filters by name, a message shows when nothing matches, and ArrowUp, ArrowDown, Enter and Escape work without the mouse.
// Small pickers (Priority) keep no search field; the Assignee picker (eight People and Agents) searches, labels its groups and keeps a disabled Agent's reason. Run with `bun e2e/picker-search.e2e.ts`.
import { check, launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { like } from "drizzle-orm";
import { createDatabase, projectMembers, users, workspaceMembers, workspaces } from "../packages/db/src";
import { createAgentActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31430);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52430);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const acceptanceShotPhase = Bun.env.SHADCN_SCREENSHOT_PHASE ?? "after";
const acceptanceShots = join(Bun.env.SHADCN_SCREENSHOT_ROOT ?? process.cwd(), ".local/shots/shadcn-05", acceptanceShotPhase);
mkdirSync(acceptanceShots, { recursive: true });
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

let failed = false;
const { client, db } = createDatabase();
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const t = (key: string) => translate(key as never);
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByRole("button", { name: t("auth.signUp"), exact: true }).click();
  await page.getByLabel(t("auth.name")).fill("Picker Tester");
  await page.getByLabel(t("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(t("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(t("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: t("auth.signUp") }).click();
  await page.getByLabel(t("workspace.name")).fill("Picker team");
  await page.getByLabel(t("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: t("workspace.create") }).click();
  await page.getByRole("button", { name: t("projects.new"), exact: true }).click();
  await page.getByLabel(t("projects.name")).fill("Picker");
  await page.getByLabel(t("projects.key"), { exact: true }).fill("POP");
  await page.getByText(t("projects.shapeFull"), { exact: true }).click(); // Cycles, Modules and Intake are needed for the Cycle and Modules pickers
  await page.getByRole("button", { name: t("projects.create") }).click();
  await page.getByRole("link", { name: /POP · Picker/ }).waitFor();

  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "POP" });
  await call("create_work_item", { projectId: project.id, title: "Search target" });
  for (let index = 1; index <= 8; index += 1) await call("create_work_item", { projectId: project.id, title: `Candidate ${index}` });
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"]) await call("create_label", { projectId: project.id, name });

  // Assignees: five more People (Person 5 owns the Agent "Rita Bot", which the viewer may not use) and two Agents of the viewer, eight in all.
  const people: Array<{ id: string; name: string }> = [];
  for (let index = 1; index <= 5; index += 1) {
    const person = { id: crypto.randomUUID(), name: `Person ${index}` };
    await db.insert(users).values({ id: person.id, name: person.name, email: `e2e-${slug}-p${index}@example.test` });
    await db.insert(projectMembers).values({ workspaceId, projectId: project.id, userId: person.id, role: "Member" });
    people.push(person);
  }
  const rita = people[4]!;
  await db.insert(workspaceMembers).values({ workspaceId, userId: rita.id, role: "Admin" });
  const agentActions = createAgentActions(db);
  const ritaAgent = await agentActions.createAgent.handler({ userId: rita.id }, { workspaceId, name: "Rita Bot", model: "default" });
  await agentActions.setAgentProjectAccess.handler({ userId: rita.id }, { agentId: ritaAgent.id, allProjects: true, projectIds: [] });
  // Without a Runtime every project member starts with access; narrow it to Rita, so the viewer sees Rita Bot disabled.
  await agentActions.setAgentAccess.handler({ userId: rita.id }, { agentId: ritaAgent.id, userIds: [rita.id] });
  const helperAgent = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Helper Bot", model: "default" });
  await agentActions.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: helperAgent.id, allProjects: true, projectIds: [] });

  await page.goto(`${web}/${slug}/browse/POP-1`);
  const sidebar = page.getByRole("complementary", { name: t("workItems.properties") });
  const panel = page.locator("[data-popover-panel]");
  const searchField = panel.getByRole("searchbox", { name: t("picker.search") });
  const activeIndex = () => panel.locator("[role=menuitemcheckbox]").evaluateAll((items) => items.findIndex((item) => item.hasAttribute("data-active")));

  // Labels: seven options, so the field appears, takes focus on open and filters.
  const labelsTrigger = sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.labels")}:`) });
  await labelsTrigger.click();
  await searchField.waitFor();
  check(await searchField.evaluate((element) => element === document.activeElement), "search field should be focused when the picker opens");
  check(await panel.getByRole("menuitemcheckbox").count() === 7, "all seven labels should be listed before typing");
  // Acceptance screenshots show a searchable property popover at every specified viewport and theme.
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 1180], [768, 1024], [844, 390], [667, 375], [390, 844]] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => { localStorage.setItem("weft.theme", value); document.documentElement.setAttribute("data-theme", value); }, theme);
      if (await labelsTrigger.isVisible()) {
        if (!(await panel.isVisible())) await labelsTrigger.click();
      } else {
        await page.goto(`${web}/${slug}/projects/POP/intake`);
        await page.getByRole("button", { name: t("intake.add"), exact: true }).click();
        const intakeDialog = page.getByRole("dialog");
        await intakeDialog.getByRole("button", { name: new RegExp(`^${t("workItems.labels")}:`) }).click();
      }
      await searchField.waitFor();
      const pageWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      check(pageWidth.scrollWidth <= pageWidth.innerWidth, `horizontal page scroll at ${width}x${height} ${theme}: ${JSON.stringify(pageWidth)}`);
      await saveShot(page, { path: join(acceptanceShots, `property-popover-${width}x${height}-${theme}.png`) });
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { localStorage.setItem("weft.theme", "light"); document.documentElement.setAttribute("data-theme", "light"); });
  await page.goto(`${web}/${slug}/browse/POP-1`);
  await sidebar.waitFor();
  await labelsTrigger.click();
  await searchField.waitFor();
  await page.keyboard.type("char");
  await panel.getByRole("menuitemcheckbox").first().waitFor();
  check(await panel.getByRole("menuitemcheckbox").count() === 1, "typing should leave only the matching label");
  check(await panel.getByRole("menuitemcheckbox", { name: "Charlie", exact: true }).count() === 1, "the remaining label should be Charlie");

  // Enter picks the highlighted label and the panel stays open for more picks.
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]') !== null);
  check(await panel.isVisible(), "Enter should keep a multi-select picker open");
  await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.labels")}: .*Charlie`) }).waitFor();

  // A query with no match shows the empty message.
  await searchField.fill("zzz");
  await panel.getByText(t("picker.noMatches"), { exact: true }).waitFor();
  check(await panel.getByRole("menuitemcheckbox").count() === 0, "a query with no match should list no labels");
  await searchField.fill("");

  // ArrowDown moves the highlight through the list and ArrowUp moves it back; Enter toggles the highlighted row.
  await panel.getByRole("menuitemcheckbox").nth(1).waitFor();
  check(await activeIndex() === 0, "the first label should be highlighted when the list opens");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  check(await activeIndex() === 2, `ArrowDown should highlight the third label, got ${await activeIndex()}`);
  // The search field names the highlighted option, so a screen reader announces it while focus stays in the field.
  const highlighted = await panel.locator("[data-active]").getAttribute("id");
  check(!!highlighted && await searchField.getAttribute("aria-activedescendant") === highlighted, "the search field does not name the highlighted label in aria-activedescendant");
  await page.keyboard.press("ArrowUp");
  check(await activeIndex() === 1, `ArrowUp should highlight the second label, got ${await activeIndex()}`);
  const second = panel.getByRole("menuitemcheckbox").nth(1);
  const before = await second.getAttribute("aria-checked");
  await page.keyboard.press("Enter");
  await page.waitForFunction((value) => document.querySelectorAll('[role="menuitemcheckbox"]')[1]?.getAttribute("aria-checked") !== value, before);
  check(await second.getAttribute("aria-checked") !== before, "Enter should toggle the highlighted label");

  // Escape closes the picker and hands focus back to its trigger.
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  check(await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.labels")}:`) }).evaluate((element) => element === document.activeElement), "Escape should return focus to the Labels trigger");

  // Parent: a single-select picker with nine options also searches, and Enter picks the highlighted item and closes.
  await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.parent")}:`) }).click();
  await searchField.waitFor();
  await searchField.fill("candidate 3");
  await panel.getByRole("menuitemradio").nth(1).waitFor({ state: "detached" });
  await panel.getByRole("menuitemradio", { name: /Candidate 3/ }).waitFor();
  check(await panel.getByRole("menuitemradio").count() === 1, "typing should leave only the matching parent");
  await page.keyboard.press("Enter");
  await panel.waitFor({ state: "detached" });
  await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.parent")}: .*Candidate 3`) }).waitFor();

  // Priority is a small picker: five options and no search field.
  await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.priority")}:`) }).click();
  await panel.waitFor();
  check(await searchField.count() === 0, "a small picker such as Priority should not show a search field");
  await page.keyboard.press("Escape");

  // Assignee: eight options (People, then Agents) so the field appears; both group headings show; a disabled Agent keeps its reason and cannot be assigned.
  await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.assignees")}:`) }).click();
  await searchField.waitFor();
  check(await searchField.evaluate((element) => element === document.activeElement), "Assignee search should be focused on open");
  check(await panel.getByText(t("members.group"), { exact: true }).count() === 1, "the People heading should show once");
  check(await panel.getByText(t("agents.group"), { exact: true }).count() === 1, "the Agents heading should show once");
  check(await panel.getByRole("menuitemcheckbox").count() === 8, "all eight assignees should be listed before typing");
  await page.keyboard.type("bot");
  await panel.getByRole("menuitemcheckbox", { name: /Helper Bot/ }).waitFor();
  check(await panel.getByRole("menuitemcheckbox").count() === 2, "typing bot should leave only the two Agents");
  await searchField.fill("rita");
  const ritaOption = panel.getByRole("menuitemcheckbox", { name: /Rita Bot/ });
  await ritaOption.waitFor();
  check(await ritaOption.getAttribute("aria-disabled") === "true", "Rita Bot should be disabled for the viewer");
  await ritaOption.getByText(t("agents.askableAskAdmin"), { exact: true }).waitFor();
  await page.keyboard.press("Enter");
  check(await ritaOption.getAttribute("aria-checked") === "false", "Enter on a disabled Agent should not assign it");
  check(await panel.isVisible(), "Enter on a disabled Agent should keep the picker open");

  // ArrowDown then Enter assigns the second person without the mouse.
  await searchField.fill("");
  await panel.getByRole("menuitemcheckbox").nth(1).waitFor();
  const target = panel.getByRole("menuitemcheckbox").nth(1);
  const targetLabel = (await target.textContent() ?? "").trim(); // the avatar letter comes first, then the name
  const targetName = targetLabel.slice(1);
  check(!targetName.includes("Bot"), `the second assignee should be a person, got "${targetName}"`);
  await page.keyboard.press("ArrowDown");
  check(await activeIndex() === 1, `ArrowDown should highlight the second assignee, got ${await activeIndex()}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction((label) => [...document.querySelectorAll('[data-popover-panel] [role="menuitemcheckbox"]')].some((item) => item.textContent?.trim() === label && item.getAttribute("aria-checked") === "true"), targetLabel);
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.assignees")}: .*${targetName}`) }).waitFor();

  // Large label sets remain searchable, and filtering does not clear selections made before the query changed.
  for (let index = 1; index <= 243; index++) await call("create_label", { projectId: project.id, name: `Long-tail ${String(index).padStart(3, "0")}` });
  await page.reload();
  const refreshedLabelsTrigger = sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.labels")}:`) });
  await refreshedLabelsTrigger.click();
  await searchField.fill("Long-tail 243");
  check(await panel.getByRole("menuitemcheckbox").count() === 1, "a 250-label picker should narrow to one matching option");
  await page.keyboard.press("Escape");
  await refreshedLabelsTrigger.click();
  await searchField.fill("Charlie");
  check(await panel.getByRole("menuitemcheckbox", { name: "Charlie", exact: true }).getAttribute("aria-checked") === "true", "filtering a selected label should keep it selected");
  mkdirSync("/home/plong/workspace/weft/.local/continuous-improvements/labels-keyboard", { recursive: true });
  await saveShot(page, { path: "/home/plong/workspace/weft/.local/continuous-improvements/labels-keyboard/labels-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/projects/POP/intake`);
  await page.getByRole("button", { name: t("intake.add"), exact: true }).click();
  const intakeDialog = page.getByRole("dialog");
  await intakeDialog.getByRole("button", { name: new RegExp(`^${t("workItems.labels")}:`) }).click();
  await page.getByRole("searchbox", { name: t("picker.search"), exact: true }).fill("Long-tail 243");
  await panel.getByRole("menuitemcheckbox", { name: /Long-tail 243/ }).waitFor();
  await saveShot(page, { path: "/home/plong/workspace/weft/.local/continuous-improvements/labels-keyboard/labels-390.png", fullPage: false });
  await page.keyboard.press("Escape");

  const touchContext = await newContext(browser, { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(`${web}/${slug}/browse/POP-1`);
  const touchSidebar = touchPage.getByRole("complementary", { name: t("workItems.properties") });
  const touchLabelsTrigger = touchSidebar.getByRole("button", { name: new RegExp(`^${t("workItems.labels")}:`) });
  await touchLabelsTrigger.tap();
  const touchPanel = touchPage.locator("[data-popover-panel]");
  const touchSearch = touchPanel.getByRole("searchbox", { name: t("picker.search") });
  await touchSearch.waitFor();
  const touchTargets = await touchPage.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { width: rect.width, height: rect.height } : null;
    };
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      trigger: bounds('button[aria-label^="Labels:"]'),
      search: bounds('[data-popover-panel] input[type="search"]'),
      option: bounds('[data-popover-panel] [role="menuitemcheckbox"]'),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  check(touchTargets.coarse, `phone landscape did not use a coarse pointer: ${JSON.stringify(touchTargets)}`);
  const targetSizes = [touchTargets.trigger, touchTargets.search, touchTargets.option];
  check(targetSizes.every((target) => target !== null && target.width >= 44 && target.height >= 44), `a property picker touch target is under 44px: ${JSON.stringify(touchTargets)}`);
  check(touchTargets.scrollWidth <= touchTargets.innerWidth, `horizontal page scroll in touch property picker: ${JSON.stringify(touchTargets)}`);
  await saveShot(touchPage, { path: join(acceptanceShots, "property-popover-844x390-touch-light.png") });
  await touchPage.keyboard.press("Escape");
  await touchContext.close();
  console.log("e2e picker-search: search above six options, focus, filter, empty message, arrows, Enter, Escape, Assignee People/Agents, disabled Agent reason and no field on Priority ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
