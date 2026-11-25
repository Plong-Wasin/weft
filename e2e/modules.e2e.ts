// Browser end-to-end flow: Modules pages (list and grid, create, edit, properties sidebar, add and remove work items, archive, delete).
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31137);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52137);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true", VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); if (!response.ok()) throw new Error(`${name} failed: ${response.status()}`); return await response.json() as T; };
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Modules Tester");
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
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  for (const title of ["Alpha", "Beta"]) await call("create_work_item", { projectId: project!.id, title });

  const t = (key: string) => translate(key as never);
  const shots = reviewShots("13-modules-ui");
  page.on("dialog", (dialog) => void dialog.accept());
  const base = `${web}/${slug}/projects/MOB`;
  await page.goto(`${base}/modules`);
  await page.getByText(t("modules.empty")).waitFor();

  // Create (modal): name, status, lead, members, dates.
  const addNew = page.getByRole("button", { name: t("modules.addNew") });
  await addNew.click();
  const modal = page.getByRole("dialog", { name: t("modules.addTitleModal") });
  check(await modal.evaluate((element) => element instanceof HTMLDialogElement && element.matches(":modal")), "Create Module should use a native modal dialog");
  await page.keyboard.press("Tab");
  const focusStayedInDialog = await modal.evaluate((element) => element.contains(document.activeElement));
  check(focusStayedInDialog, "Keyboard focus should stay inside the Module dialog");
  const statusTrigger = modal.getByRole("button", { name: new RegExp(`^${t("modules.status")}:`) });
  for (const viewport of [{ width: 1440, height: 1080 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await statusTrigger.click();
    const menu = page.getByRole("menu").last();
    await menu.waitFor({ state: "visible" });
    const geometry = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 16));
      return {
        insideDialog: Boolean(element.closest("dialog")?.contains(element)),
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: window.innerWidth, height: window.innerHeight,
        visible: getComputedStyle(element).visibility === "visible",
        receivesPointer: hit === element || element.contains(hit),
      };
    });
    check(geometry.insideDialog, "Module popover should remain inside the modal focus boundary");
    check(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height, `Module popover should fit the ${viewport.width}px viewport`);
    check(geometry.visible && geometry.receivesPointer, "Module popover should not be clipped by the scrollable dialog");
    await page.keyboard.press("Escape");
    check(await page.getByRole("dialog", { name: t("modules.addTitleModal") }).count() === 1, "Escape should close the popover without closing the Module dialog");
    check(await page.getByRole("menu").count() === 0, "Escape should dismiss the open Module popover");
    check(await statusTrigger.evaluate((element) => document.activeElement === element), "Escape should return focus to the Module popover trigger");
  }
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached" });
  check(await addNew.evaluate((element) => document.activeElement === element), "Closing the Module dialog should restore focus to its opener");
  await addNew.click();
  const reopenedModal = page.getByRole("dialog", { name: t("modules.addTitleModal") });
  check(await reopenedModal.evaluate((element) => element.matches(":modal")), "Module dialog should reopen after Escape");
  check(await reopenedModal.evaluate((element) => element.scrollHeight <= element.clientHeight), "Create Module dialog should fit without a scrollbar at 1080p");
  await reopenedModal.getByLabel(t("modules.name")).fill("Auth");
  await reopenedModal.getByRole("toolbar", { name: t("wiki.toolbar") }).getByRole("button", { name: t("editor.sourceMode") }).click();
  await reopenedModal.getByRole("textbox", { name: t("editor.sourceText") }).fill("**Initial module purpose**");
  await reopenedModal.getByRole("toolbar", { name: t("wiki.toolbar") }).getByRole("button", { name: t("editor.sourceMode") }).click();
  const status = reopenedModal.getByRole("button", { name: new RegExp(`^${t("modules.status")}:`) });
  await status.click();
  const dates = await reopenedModal.getByLabel(t("modules.start")).evaluate((element) => {
    const row = element.closest("div.flex");
    return row?.getBoundingClientRect().toJSON();
  });
  const statusMenu = await page.locator('[role="menu"]').last().boundingBox();
  check(Boolean(dates && statusMenu && (statusMenu.y + statusMenu.height <= dates.top || statusMenu.y >= dates.bottom)), "Status options should not cover the date row");
  check(await reopenedModal.evaluate((element) => element.scrollHeight <= element.clientHeight), "Opening Status should not add a dialog scrollbar");
  await page.getByRole("menuitemradio", { name: t("modules.status.in-progress") }).click();
  await reopenedModal.getByRole("button", { name: new RegExp(`^${t("modules.lead")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "Modules Tester" }).click();
  await reopenedModal.getByRole("button", { name: new RegExp(`^${t("modules.members")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Modules Tester" }).click();
  await page.keyboard.press("Escape");
  await reopenedModal.getByLabel(t("modules.start")).fill("2026-01-01");
  await reopenedModal.getByLabel(t("modules.end")).fill("2026-03-01");
  await reopenedModal.getByRole("button", { name: t("modules.create"), exact: true }).click();
  await reopenedModal.waitFor({ state: "detached" });
  const row = page.getByTestId("module-row-Auth");
  await row.waitFor();
  check((await row.innerText()).includes(t("modules.status.in-progress")), "status badge missing in list");
  check((await row.innerText()).includes("0"), "progress missing");
  const createdModule = (await call<Array<{ id: string; name: string; descriptionMarkdown: string }>>("list_modules", { projectId: project!.id })).find(({ name }) => name === "Auth")!;
  check(createdModule.descriptionMarkdown.includes("**Initial module purpose**"), "Module description formatting was not written as Markdown");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/modules-390.png` });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!mobileOverflow, "Modules list should not scroll horizontally at 390px");
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: `${shots}/modules-list-1440.png` });

  // Grid display.
  await page.getByRole("button", { name: t("modules.display.grid"), exact: true }).click();
  await page.getByTestId("module-card-Auth").waitFor();
  await page.screenshot({ path: `${shots}/modules-grid-1440.png` });
  await page.getByRole("button", { name: t("modules.display.list"), exact: true }).click();
  await row.waitFor();

  // Edit from the menu.
  await row.getByRole("button", { name: t("modules.actions") }).click();
  await page.getByRole("menuitem", { name: t("modules.edit") }).click();
  const edit = page.getByRole("dialog", { name: t("modules.editTitle") });
  await edit.getByLabel(t("modules.name")).fill("Authentication");
  await edit.getByRole("button", { name: t("modules.save"), exact: true }).click();
  await edit.waitFor({ state: "detached" });
  await page.getByTestId("module-row-Authentication").waitFor();
  // Search and combined filters produce the same result in list and grid.
  await page.getByRole("searchbox", { name: t("modules.searchModules") }).fill("auth");
  await page.getByLabel(t("modules.statusFilter")).selectOption("in-progress");
  await page.getByLabel(t("modules.leadFilter")).selectOption({ label: "Modules Tester" });
  await page.getByLabel(t("modules.memberFilter")).selectOption({ label: "Modules Tester" });
  await page.locator('input[type="date"]').nth(0).fill("2026-02-01");
  await page.locator('input[type="date"]').nth(1).fill("2026-02-28");
  await page.getByTestId("module-row-Authentication").waitFor();
  await page.getByRole("button", { name: t("modules.display.grid"), exact: true }).click();
  await page.getByTestId("module-card-Authentication").waitFor();
  await page.getByRole("searchbox", { name: t("modules.searchModules") }).fill("nothing matches");
  await page.getByText(t("modules.noMatches")).waitFor();
  await page.getByRole("searchbox", { name: t("modules.searchModules") }).fill("auth");
  await page.getByRole("button", { name: t("modules.display.list"), exact: true }).click();
  await page.getByRole("button", { name: t("modules.clearFilters") }).click();
  console.log("modules: create, grid/list, edit");

  // Detail: add work items from the module page.
  await page.getByRole("link", { name: "Authentication" }).click();
  await page.getByRole("heading", { name: "Authentication" }).waitFor();
  const moduleDescriptionEditor = page.locator('[data-testid="description-editor"] [contenteditable="true"]');
  await page.getByRole("toolbar", { name: t("wiki.toolbar") }).getByRole("button", { name: t("editor.sourceMode") }).click();
  const itemsForDescription = await call<Array<{ id: string; displayId: string }>>("list_work_items", { projectId: project!.id });
  const modulePeople = await call<Array<{ userId: string; name: string }>>("list_project_members", { projectId: project!.id });
  const moduleDescriptionMarkdown = `**Module scope and goal** with [[MOB-1|work-item:${itemsForDescription[0]!.id}]] and @{Modules Tester|${modulePeople.find(({ name }) => name === "Modules Tester")!.userId}}.`;
  await page.getByRole("textbox", { name: t("editor.sourceText") }).fill(moduleDescriptionMarkdown);
  await page.getByRole("toolbar", { name: t("wiki.toolbar") }).getByRole("button", { name: t("editor.sourceMode") }).click();
  await page.getByRole("heading", { name: "Authentication" }).click();
  await page.getByTestId("entity-description-save-status").getByText(t("workItems.descriptionSave.saving")).waitFor();
  await page.getByTestId("entity-description-save-status").getByText(t("workItems.descriptionSave.saved")).waitFor();
  const savedModule = await call<{ descriptionMarkdown: string }>("get_module", { moduleId: createdModule.id });
  check(savedModule.descriptionMarkdown.includes(`work-item:${itemsForDescription[0]!.id}`) && savedModule.descriptionMarkdown.includes(`@{Modules Tester|${modulePeople.find(({ name }) => name === "Modules Tester")!.userId}}`), "Module description references did not round-trip");
  check(await moduleDescriptionEditor.locator("strong").filter({ hasText: "Module scope and goal" }).count() === 1, "Module rich formatting did not render safely");
  await page.getByRole("button", { name: t("modules.addWorkItems") }).click();
  const add = page.getByRole("dialog", { name: t("modules.addItemsTitle") });
  await add.getByLabel(/Alpha/).check();
  await add.getByLabel(/Beta/).check();
  await add.getByRole("button", { name: t("modules.add"), exact: true }).click();
  await add.waitFor({ state: "detached" });
  await page.getByTestId("row-MOB-1").getByRole("link", { name: "Alpha" }).waitFor();
  await page.getByTestId("row-MOB-2").getByRole("link", { name: "Beta" }).waitFor();
  check((await page.getByTestId("module-items-count").innerText()) === "0/2", "count should be 0/2");
  await page.getByText(`${t("modules.blocked")} · 0`, { exact: true }).waitFor();
  await page.getByText(`${t("modules.overdue")} · 0`, { exact: true }).waitFor();
  await page.getByLabel(t("modules.breakdown"), { exact: true }).selectOption("assignee");
  await page.getByText("Unassigned", { exact: true }).waitFor();
  await page.getByLabel(t("modules.breakdown"), { exact: true }).selectOption("state");

  // Module details panel: click, Mod+I, reload persistence, and full-width reflow without horizontal page scroll.
  const moduleToggle = () => page.getByRole("button", { name: t("detailsPanel.hide") });
  const moduleAside = () => page.getByRole("complementary", { name: t("modules.properties"), exact: true });
  check(await moduleToggle().getAttribute("aria-expanded") === "true", "Module details toggle must expose its expanded state");
  check(await moduleToggle().getAttribute("aria-controls") === "module-details-panel", "Module details toggle must control its panel");
  await moduleToggle().click();
  check(await page.getByRole("complementary", { name: t("modules.properties"), exact: true }).count() === 0, "a hidden Module details panel must leave the accessibility tree");
  await page.keyboard.press("Control+i");
  await moduleAside().waitFor();
  await page.keyboard.press("Control+i");
  await page.reload();
  await page.getByRole("button", { name: t("detailsPanel.show") }).waitFor();
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `hidden Module panel causes horizontal page scroll at ${width}px`);
    check(await page.getByRole("complementary", { name: t("modules.properties"), exact: true }).count() === 0, `hidden Module panel is in the accessibility tree at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.getByRole("button", { name: t("detailsPanel.show") }).isVisible() === false, "Module details toggle must be hidden below lg");
  check(await page.getByRole("complementary", { name: t("modules.properties"), exact: true }).count() === 1, "Module details remain stacked on mobile");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "Module page scrolls horizontally at 390px");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: t("detailsPanel.show") }).click();

  // Properties sidebar: status, dates, lead, members are editable inline.
  const side = moduleAside();
  await side.getByRole("button", { name: new RegExp(`^${t("modules.status")}:`) }).click();
  await page.getByRole("menuitemradio", { name: t("modules.status.completed") }).click();
  await side.getByRole("button", { name: `${t("modules.status")}: ${t("modules.status.completed")}` }).waitFor();
  await side.getByLabel(t("modules.end")).fill("2026-04-01");
  await side.getByLabel(t("modules.end")).evaluate((el) => el.blur());
  await page.reload();
  check((await page.getByRole("complementary", { name: t("modules.properties") }).getByLabel(t("modules.end")).inputValue()) === "2026-04-01", "end date not saved");
  await page.getByRole("button", { name: new RegExp(`^${t("modules.lead")}:`) }).click();
  await page.getByRole("menuitemradio", { name: t("modules.noLead") }).click();
  await page.getByRole("button", { name: `${t("modules.lead")}: ${t("modules.noLead")}` }).waitFor();
  await page.getByRole("button", { name: new RegExp(`^${t("modules.members")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Modules Tester" }).click();
  await page.getByRole("button", { name: `${t("modules.members")}: —` }).waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/module-detail-1440.png` });

  // Remove a work item from the module page.
  await page.getByRole("button", { name: t("modules.remove") }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="module-items-count"]')?.textContent === "0/1");
  console.log("modules: add/remove work items, properties sidebar");

  // Archive (completed Module), see it under archived, unarchive, delete.
  await page.getByRole("button", { name: t("modules.actions") }).click();
  await page.getByRole("menuitem", { name: t("modules.archive") }).click();
  await page.getByText(t("modules.archivedNote")).waitFor();
  check(await page.getByRole("button", { name: t("modules.remove") }).count() === 0, "archived module must be read-only");
  check(await page.getByRole("complementary", { name: t("modules.properties") }).locator('[data-testid="description-editor"] [contenteditable="true"]').count() === 0, "archived Module description must be read-only");
  await page.getByRole("button", { name: t("modules.actions") }).click();
  check(await page.getByRole("menuitem", { name: t("modules.edit") }).count() === 0, "archived Module still offers Edit");
  await page.keyboard.press("Escape");
  await page.goto(`${base}/modules`);
  await page.getByText(t("modules.empty")).waitFor();
  await page.getByLabel(t("modules.showArchived")).check();
  await page.getByTestId("module-row-Authentication").waitFor();
  await page.getByTestId("module-row-Authentication").getByRole("button", { name: t("modules.actions") }).click();
  await page.getByRole("menuitem", { name: t("modules.unarchive") }).click();
  await page.getByText(t("modules.empty")).waitFor();
  await page.getByLabel(t("modules.showArchived")).uncheck();
  await page.getByTestId("module-row-Authentication").getByRole("button", { name: t("modules.actions") }).click();
  await page.getByRole("menuitem", { name: t("modules.delete") }).click();
  await page.getByText(t("modules.empty")).waitFor();
  console.log("modules: archive, unarchive, delete");

  console.log("e2e modules: ok");
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
