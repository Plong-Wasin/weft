// Browser end-to-end flow: the app shell (rail, sidebar, top bar), workspace switcher, search, notifications, theme, feature toggles, phone drawer.
// Run with `bun e2e/shell.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database). Screenshots go to .local/visual/review/03-app-shell.
import { check, launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import type { Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
import { saveShot } from "./shots";
// AI is on only with a provider key: a placeholder keeps the AI rail entry shown here, and no model is called.
Bun.env.OPENAI_API_KEY ??= "sk-e2e-placeholder-no-call";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31037);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52037);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("03-app-shell");
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

let failed = false;
let failurePage: Page | undefined;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  failurePage = page;
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  // Project menu state is saved on the server, so a reload right after a click must wait for the save.
  const clickAndSave = async (locator: ReturnType<typeof page.getByRole>) => {
    await Promise.all([page.waitForResponse((response) => response.url().endsWith("/actions/set_project_preference")), locator.click()]);
  };
  // Every button whose accessible name mentions "sidebar" is a sidebar toggle; a second one (the old floating peek button) fails here.
  const assertOneSidebarToggle = async (state: string) => {
    const toggles = page.getByRole("button", { name: /sidebar/i });
    const count = await toggles.count();
    check(count === 1, `${state}: expected exactly one sidebar toggle, found ${count}`);
  };
  // Hit test on the first glyph: a covering element at the centre of the first character fails the check.
  const assertFirstTextIsNotCovered = async (locator: ReturnType<typeof page.getByRole>, description: string) => {
    check(await locator.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node && !/\S/.test(node.textContent ?? "")) node = walker.nextNode() as Text | null;
      if (!node) return false;
      const index = (node.textContent ?? "").search(/\S/);
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const box = range.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(hit && (hit === element || element.contains(hit)));
    }), `${description} first text character is covered or missing`);
  };
  const assertRailHitTest = async (state: string) => {
    const rail = page.getByRole("navigation", { name: translate("shell.rail") });
    check(await rail.evaluate((element) => document.elementFromPoint(32, 90)?.closest("nav") === element), `${state}: sidebar covers the app rail`);
  };
  const assertCompactSidebar = async (width: number) => {
    check(await page.getByRole("button", { name: translate("shell.expandSidebar") }).getAttribute("aria-expanded") === "false", `${width}px should start with the secondary sidebar collapsed`);
    check(await page.locator("#desktop-sidebar").evaluate((element) => element.parentElement?.getBoundingClientRect().width === 0), `${width}px should reserve no width for the collapsed sidebar`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px collapsed shell overflows horizontally`);
    await saveShot(page, { path: `${shots}/shell-${width}-auto-collapsed.png` });
  };
  const assertPageHeaderGeometry = async () => {
    check(await page.getByTestId("page-header").evaluate((header) => {
      const children = [...header.children] as HTMLElement[];
      const boxes = children.map((element) => element.getBoundingClientRect());
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!; const b = boxes[j]!;
        if (a.width && b.width && a.height && b.height && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) return false;
      }
      for (const element of children) {
        const bounds = element.getBoundingClientRect();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          if (!/\S/.test(node.textContent ?? "")) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const glyph of [...range.getClientRects()]) if (glyph.left < bounds.left - 1 || glyph.right > bounds.right + 1 || glyph.top < bounds.top - 1 || glyph.bottom > bounds.bottom + 1) return false;
        }
      }
      return true;
    }), "page header siblings overlap or text glyphs escape their measured row boxes");
  };
  // The sidebar and the rail slide over CSS transitions: wait until no transition runs, then take the screenshot.
  const sidebarTransitionsDone = () => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  // Peeking opens the sidebar on pointer or focus; wait until its position reads open (x >= 64) or closed (x < 0), the same reads the checks make.
  const waitForSidebarPeek = async (open: boolean, description: string) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const box = await sidebar.boundingBox();
      if (box && (open ? box.x >= 64 : box.x < 0)) return;
      await Bun.sleep(50);
    }
    throw new Error(`${description}: sidebar did not ${open ? "open" : "close"} within 3 s`);
  };
  const captureDesktopSidebarStates = async (prefix: string) => {
    const expandButton = page.getByRole("button", { name: translate("shell.expandSidebar") });
    if (await expandButton.count()) {
      await expandButton.click();
      await sidebarTransitionsDone();
    }
    await assertOneSidebarToggle(`${prefix} expanded`);
    await assertFirstTextIsNotCovered(page.getByRole("link", { name: translate("projects.back"), exact: true }), `${prefix} breadcrumb`);
    check(await page.getByRole("navigation", { name: translate("shell.rail") }).isVisible(), `${prefix} expanded: app rail is missing`);
    await sidebarTransitionsDone(); // a screenshot taken mid-slide covers the rail labels
    await saveShot(page, { path: `${shots}/${prefix}-expanded.png` });
    await page.getByRole("button", { name: translate("shell.collapseSidebar") }).click();
    await sidebarTransitionsDone();
    await assertOneSidebarToggle(`${prefix} collapsed`);
    await assertFirstTextIsNotCovered(page.getByRole("link", { name: translate("projects.back"), exact: true }), `${prefix} collapsed breadcrumb`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${prefix}: collapsed layout overflows horizontally`);
    await assertRailHitTest(`${prefix} collapsed`);
    await saveShot(page, { path: `${shots}/${prefix}-collapsed.png` });
    await page.mouse.move(65, 400);
    await waitForSidebarPeek(true, `${prefix} peek`);
    await assertOneSidebarToggle(`${prefix} peeking`);
    await assertFirstTextIsNotCovered(page.getByRole("link", { name: translate("nav.home"), exact: true }), `${prefix} peek menu item`);
    await assertRailHitTest(`${prefix} peek`);
    check((await page.getByRole("navigation", { name: translate("shell.sidebar") }).boundingBox())!.x >= 64, `${prefix}: edge peek did not open`);
    await saveShot(page, { path: `${shots}/${prefix}-peek.png` });
    await page.mouse.move(600, 400);
    await waitForSidebarPeek(false, `${prefix} peek close`);
    check((await page.getByRole("navigation", { name: translate("shell.sidebar") }).boundingBox())!.x < 0, `${prefix}: edge peek did not close`);
    await page.getByRole("button", { name: translate("shell.expandSidebar") }).click();
    await sidebarTransitionsDone();
    await assertOneSidebarToggle(`${prefix} re-expanded`);
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Shell Tester");
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
  await assertPageHeaderGeometry();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  await call("create_work_item", { projectId: project.id, title: "Alpha shell item" });
  await call("create_wiki_page", { workspaceId, title: "Alpha handbook" });

  // Rail, sidebar, and top bar are all there at 1440px, light theme.
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  const rail = page.getByRole("navigation", { name: translate("shell.rail") });
  for (const label of [translate("rail.work"), translate("wiki.title"), translate("rail.ai"), translate("nav.settings")]) await rail.getByRole("link", { name: label }).waitFor();
  const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });
  const sidebarToggle = page.getByRole("button", { name: translate("shell.collapseSidebar") });
  await assertOneSidebarToggle("1440 expanded initial state");
  await assertFirstTextIsNotCovered(page.getByRole("link", { name: translate("projects.back"), exact: true }), "1440 expanded breadcrumb");
  check(await sidebarToggle.isVisible(), "desktop sidebar toggle is missing");
  await sidebarToggle.hover();
  const sidebarTooltip = page.locator('[data-slot="tooltip-content"]');
  await sidebarTooltip.waitFor();
  check((await sidebarTooltip.textContent())?.includes("Ctrl/⌘+\\"), "sidebar shortcut is missing from the toggle tooltip");
  check(await sidebarToggle.getAttribute("aria-expanded") === "true", "sidebar does not start expanded");
  await sidebar.getByRole("navigation", { name: new RegExp(translate("projectNav.label")) }).waitFor();
  await sidebar.getByRole("link", { name: translate("cycles.title"), exact: true }).waitFor();
  for (const label of [translate("workspace.switch"), translate("topbar.help"), translate("profile.menu")]) await page.getByRole("button", { name: label }).waitFor();
  check(await page.getByRole("link", { name: translate("app.title"), exact: true }).count() === 0, "brand link remains in the signed-in app shell");
  check(await page.getByRole("button", { name: translate("workspace.switch") }).isVisible(), "workspace switcher is missing from the top-left");
  check((await page.getByRole("button", { name: translate("workspace.switch") }).innerText()).includes("E2E team"), "workspace switcher does not identify the current workspace");
  const desktopSwitcher = page.getByRole("button", { name: translate("workspace.switch") });
  check(await desktopSwitcher.getAttribute("aria-label") === `${translate("workspace.switch")}: E2E team`, "workspace switcher accessible name omits the current workspace");
  await page.getByRole("link", { name: translate("shell.skipToMain") }).focus();
  await page.keyboard.press("Tab");
  check(await sidebarToggle.evaluate((element) => element === document.activeElement), "desktop sidebar toggle is not in the Tab order after skip link");
  await page.keyboard.press("Tab");
  check(await desktopSwitcher.evaluate((element) => element === document.activeElement), "workspace switcher is not in the desktop Tab order");
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: "E2E team" }).waitFor();
  await saveShot(page, { path: `${shots}/workspace-switcher-1440.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: translate("topbar.notifications") }).waitFor();
  const searchBox = await page.getByRole("searchbox", { name: translate("search.label") }).boundingBox();
  check(Boolean(searchBox) && Math.abs(searchBox!.x + searchBox!.width / 2 - 720) < 60, `search not centered: ${JSON.stringify(searchBox)}`);
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.light") }).click();
  await page.keyboard.press("Escape");
  await saveShot(page, { path: `${shots}/shell-1440-light.png` });
  console.log("shell ok: rail, sidebar, top bar");

  // Desktop sidebar collapses without moving the app rail and persists per browser.
  await sidebarToggle.focus();
  await page.keyboard.press("Enter");
  check(await page.getByRole("button", { name: translate("shell.expandSidebar") }).getAttribute("aria-expanded") === "false", "keyboard focus could not collapse the sidebar");
  await assertOneSidebarToggle("1440 collapsed state");
  const breadcrumb = page.getByRole("link", { name: translate("projects.back"), exact: true });
  await assertFirstTextIsNotCovered(breadcrumb, "1440 collapsed breadcrumb");
  await assertRailHitTest("1440 collapsed");
  check(await rail.isVisible(), "app rail disappeared when the sidebar collapsed");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "collapsed sidebar leaves horizontal overflow");
  const focusSearchInput = page.getByRole("searchbox", { name: translate("search.label") });
  await focusSearchInput.focus();
  await page.getByRole("button", { name: translate("shell.expandSidebar") }).focus();
  await waitForSidebarPeek(true, "1440 focus peek");
  check((await sidebar.boundingBox())!.x >= 64, "keyboard focus on the labelled top-bar toggle did not peek the sidebar");
  await assertOneSidebarToggle("1440 focus peek");
  await assertFirstTextIsNotCovered(sidebar.getByRole("link", { name: translate("nav.home"), exact: true }), "1440 focus peek menu item");
  await saveShot(page, { path: `${shots}/shell-1440-focus-peek-light.png` });
  await focusSearchInput.focus();
  await waitForSidebarPeek(false, "1440 focus peek closed");
  check((await sidebar.boundingBox())!.x < 0, "sidebar focus peek stayed open after focus left");
  await saveShot(page, { path: `${shots}/shell-1440-collapsed-light.png` });
  await page.mouse.move(65, 400);
  await waitForSidebarPeek(true, "1440 pointer peek");
  await assertOneSidebarToggle("1440 pointer peek");
  await assertFirstTextIsNotCovered(sidebar.getByRole("link", { name: translate("nav.home"), exact: true }), "1440 pointer peek menu item");
  await assertRailHitTest("1440 pointer peek");
  check((await sidebar.boundingBox())!.x >= 64, "edge hover did not peek the sidebar");
  await saveShot(page, { path: `${shots}/shell-1440-peek-light.png` });
  await page.mouse.move(600, 400);
  await waitForSidebarPeek(false, "1440 pointer peek closed");
  check((await sidebar.boundingBox())!.x < 0, "sidebar peek stayed open after the pointer left");
  await rail.getByRole("link", { name: translate("rail.work") }).focus();
  await page.keyboard.press("Control+\\");
  check(await page.getByRole("button", { name: translate("shell.collapseSidebar") }).getAttribute("aria-expanded") === "true", "keyboard shortcut did not expand the sidebar");
  await page.keyboard.press("Control+\\");
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  check(await page.getByRole("button", { name: translate("shell.expandSidebar") }).getAttribute("aria-expanded") === "false", "collapsed preference did not survive reload");
  await rail.getByRole("link", { name: translate("wiki.title") }).click();
  await page.waitForURL(new RegExp(`/${slug}/wiki`));
  check(await page.getByRole("button", { name: translate("shell.expandSidebar") }).getAttribute("aria-expanded") === "false", "sidebar state was lost on a wiki page");
  await rail.getByRole("link", { name: translate("nav.settings") }).click();
  await page.waitForURL(new RegExp(`/${slug}/settings`));
  check(await page.getByRole("button", { name: translate("shell.expandSidebar") }).getAttribute("aria-expanded") === "false", "sidebar state was lost in settings");
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  await page.getByRole("button", { name: translate("layout.board") }).click();
  await page.getByTestId("column-Backlog").waitFor();
  check(page.url().includes("layout=board"), "collapsed sidebar board selection was not applied");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "collapsed sidebar causes a horizontal jump on a board");
  check((await page.locator("main").boundingBox())!.x === 64, "collapsed board does not use the content width after the app rail");
  await page.getByRole("button", { name: translate("layout.list") }).click();
  await page.getByTestId("column-Backlog").waitFor({ state: "detached" });
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  await page.getByRole("button", { name: translate("shell.expandSidebar") }).click();
  check(await page.getByRole("button", { name: translate("shell.collapseSidebar") }).getAttribute("aria-expanded") === "true", "mouse click could not expand the sidebar");
  console.log("shell ok: desktop sidebar toggle, keyboard shortcut, peek, persistence");

  // Project menu expansion belongs to this member and survives reloads on desktop and in the phone drawer.
  await call("create_project", { workspaceId, name: "Second project", key: "SEC", visibility: "public" });
  await page.reload();
  const secondProjectToggle = sidebar.getByRole("button", { name: `${translate("sidebar.toggleProject")}: Second project` });
  await secondProjectToggle.waitFor();
  check(await secondProjectToggle.getAttribute("aria-expanded") === "false", "a new non-current project should start collapsed");
  await clickAndSave(secondProjectToggle);
  await page.reload();
  const expandedSecondProjectToggle = sidebar.getByRole("button", { name: `${translate("sidebar.toggleProject")}: Second project` });
  await expandedSecondProjectToggle.waitFor();
  await page.waitForFunction((projectId) => document.querySelector<HTMLButtonElement>(`[data-project-toggle="${projectId}"]`)?.getAttribute("aria-expanded") === "true", project.id);
  check(await expandedSecondProjectToggle.getAttribute("aria-expanded") === "true", "expanded project menu did not survive reload");
  await clickAndSave(sidebar.getByRole("button", { name: `${translate("sidebar.toggleProject")}: Second project` }));
  await page.reload();
  const collapsedSecondProjectToggle = sidebar.getByRole("button", { name: `${translate("sidebar.toggleProject")}: Second project` });
  await collapsedSecondProjectToggle.waitFor();
  check(await collapsedSecondProjectToggle.getAttribute("aria-expanded") === "false", "collapsed project menu did not survive reload");

  // Project menus follow the feature toggles (the sidebar updates without a reload).
  await call("set_project_features", { projectId: project.id, features: { cycles: false, modules: false, intake: false } });
  await page.reload();
  await sidebar.getByRole("navigation", { name: `${translate("projectNav.label")} MOB` }).getByRole("link", { name: translate("projectNav.views") }).waitFor();
  check(await sidebar.getByRole("link", { name: translate("cycles.title"), exact: true }).count() === 0, "Cycles menu still shown with the feature off");
  check(await sidebar.getByRole("link", { name: translate("modules.title") }).count() === 0, "Modules menu still shown with the feature off");
  check(await sidebar.getByRole("link", { name: translate("intake.title") }).count() === 0, "Intake menu still shown with the feature off");
  await call("set_project_features", { projectId: project.id, features: { cycles: true, modules: true, intake: true } });
  await page.reload();
  await sidebar.getByRole("link", { name: translate("intake.title") }).waitFor();
  console.log("shell ok: feature toggles");

  // Workspace switcher: lists workspaces, creates a new one.
  const second = `${slug}-b`;
  await page.getByRole("button", { name: translate("workspace.switch") }).click();
  await page.getByRole("menuitemradio", { name: "E2E team" }).waitFor();
  await page.getByRole("menuitem", { name: translate("workspace.new") }).click();
  const createWorkspaceDialog = page.getByRole("dialog", { name: translate("workspace.new") });
  await createWorkspaceDialog.waitFor();
  check(await page.getByLabel(translate("workspace.name")).evaluate((element) => element === document.activeElement), "workspace name input is not focused when the create form opens");
  await createWorkspaceDialog.getByRole("button", { name: translate("workspace.close") }).click();
  const newWorkspaceItem = page.getByRole("menuitem", { name: translate("workspace.new") });
  await newWorkspaceItem.waitFor();
  await page.waitForFunction((label) => document.activeElement?.getAttribute("role") === "menuitem" && document.activeElement.textContent?.includes(label), translate("workspace.new"));
  check(await newWorkspaceItem.evaluate((element) => element === document.activeElement), "workspace switcher does not restore focus to New workspace after cancel");
  await newWorkspaceItem.click();
  await page.getByLabel(translate("workspace.name")).fill("Second team");
  await page.getByLabel(translate("workspace.slug")).fill(second);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${second}`);
  await page.getByRole("button", { name: translate("workspace.switch") }).click();
  await page.getByRole("menuitemradio", { name: "Second team" }).waitFor();
  await page.getByRole("menuitemradio", { name: "E2E team" }).click();
  await page.waitForURL(`${web}/${slug}`);
  console.log("shell ok: workspace switcher");

  // Verify the create dialog and focus recovery at phone width before unrelated search checks.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: translate("workspace.switch") }).click();
  await page.getByRole("menuitemradio", { name: "E2E team" }).waitFor();
  await saveShot(page, { path: `${shots}/workspace-switcher-390.png` });
  await page.getByRole("menuitem", { name: translate("workspace.new") }).click();
  const phoneCreateDialog = page.getByRole("dialog", { name: translate("workspace.new") });
  await phoneCreateDialog.waitFor();
  const phoneWorkspaceName = phoneCreateDialog.getByLabel(translate("workspace.name"));
  await phoneWorkspaceName.and(page.locator(":focus")).waitFor();
  check(await phoneWorkspaceName.evaluate((element) => element === document.activeElement), "phone workspace name input is not focused when the create form opens");
  await phoneCreateDialog.getByRole("button", { name: translate("workspace.close") }).click();
  const phoneNewWorkspaceItem = page.getByRole("menuitem", { name: translate("workspace.new") });
  await phoneNewWorkspaceItem.waitFor();
  await page.waitForFunction((label) => document.activeElement?.getAttribute("role") === "menuitem" && document.activeElement.textContent?.includes(label), translate("workspace.new"));
  check(await phoneNewWorkspaceItem.evaluate((element) => element === document.activeElement), "phone workspace switcher does not restore focus to New workspace after cancel");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("shell ok: workspace creation dialog on desktop and phone");

  // Search opens the work item and wiki results.
  // The work item and handbook belong to E2E team; switch back after the workspace-switcher checks.
  await page.getByRole("button", { name: translate("workspace.switch") }).click();
  await page.getByRole("menuitemradio", { name: "E2E team" }).click();
  await page.waitForURL(`${web}/${slug}`);
  const searchInput = page.getByRole("searchbox", { name: translate("search.label") });
  await searchInput.fill("Alpha");
  const results = page.getByRole("list", { name: translate("search.results") });
  await results.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  await results.getByRole("link", { name: /Alpha handbook/ }).waitFor();
  await results.getByRole("link", { name: /Alpha handbook/ }).click();
  await page.waitForURL(new RegExp(`/${slug}/wiki/`));
  await results.waitFor({ state: "detached" });
  await searchInput.fill("");
  await searchInput.fill("Alpha");
  const workItemResult = results.getByRole("link", { name: /Alpha shell item/ });
  await workItemResult.waitFor();
  await workItemResult.click();
  await page.waitForURL(`${web}/${slug}/browse/MOB-1`);
  await results.waitFor({ state: "detached" });
  console.log("shell ok: search");

  // Notifications icon opens the inbox.
  await page.getByRole("link", { name: translate("topbar.notifications") }).click();
  await page.waitForURL(`${web}/${slug}/notifications`);
  await page.getByRole("heading", { name: new RegExp(translate("inbox.title")) }).waitFor();
  await saveShot(page, { path: `${shots}/page-header-inbox-1440-light.png` });
  console.log("shell ok: notifications");

  // Theme persists across reload; dark theme screenshot.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark") }).click();
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "dark theme not applied");
  await page.goto(`${web}/${slug}/notifications`);
  await page.getByRole("heading", { name: new RegExp(translate("inbox.title")) }).waitFor();
  await saveShot(page, { path: `${shots}/page-header-inbox-1440-dark.png` });
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  await captureDesktopSidebarStates("shell-1440-dark");
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  check(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "theme did not persist");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark"), checked: true }).waitFor();
  await page.keyboard.press("Escape");
  await saveShot(page, { path: `${shots}/shell-1440-dark.png` });
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.system") }).click();
  await page.keyboard.press("Escape");
  console.log("shell ok: theme");

  // Intermediate desktop width uses the same sidebar states without a content gap.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  await assertCompactSidebar(1024);
  await page.getByRole("button", { name: translate("shell.expandSidebar") }).click();
  await sidebarTransitionsDone();
  await captureDesktopSidebarStates("shell-1024-light");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark") }).click();
  await page.keyboard.press("Escape");
  await captureDesktopSidebarStates("shell-1024-dark");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.system") }).click();
  await page.keyboard.press("Escape");

  for (const viewport of [{ width: 820, height: 1180, name: "820x1180" }, { width: 844, height: 390, name: "844x390" }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.reload();
    await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
    await assertCompactSidebar(viewport.width);
    await saveShot(page, { path: `${shots}/shell-${viewport.name}-light.png` });
  }

  // Tablet width keeps the workspace switcher directly beside the drawer button.
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  await assertCompactSidebar(768);
  await page.getByRole("button", { name: translate("shell.expandSidebar") }).click();
  await sidebarTransitionsDone();
  check(await page.getByRole("link", { name: translate("app.title"), exact: true }).count() === 0, "brand link remains in the tablet shell");
  check(await page.getByRole("button", { name: translate("workspace.switch") }).isVisible(), "workspace switcher is missing at tablet width");
  check((await page.getByRole("button", { name: translate("workspace.switch") }).innerText()).includes("E2E team"), "tablet workspace switcher does not identify the current workspace");
  await saveShot(page, { path: `${shots}/shell-768-light-expanded.png` });
  await page.getByRole("button", { name: translate("shell.collapseSidebar") }).click();
  await sidebarTransitionsDone();
  check(await page.locator("#desktop-sidebar").evaluate((element) => element.parentElement?.getBoundingClientRect().width === 0), "768px manual collapse did not release sidebar width");
  await saveShot(page, { path: `${shots}/shell-768-light-collapsed.png` });
  await page.getByRole("button", { name: translate("shell.expandSidebar") }).click();
  await sidebarTransitionsDone();
  await saveShot(page, { path: `${shots}/shell-768-tablet.png` });
  check(await page.getByRole("button", { name: translate("shell.collapseSidebar") }).isVisible(), "desktop sidebar toggle missing at tablet breakpoint");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark") }).click();
  await page.keyboard.press("Escape");
  await saveShot(page, { path: `${shots}/shell-768-dark-expanded.png` });
  await page.getByRole("button", { name: translate("shell.collapseSidebar") }).click();
  await sidebarTransitionsDone();
  await saveShot(page, { path: `${shots}/shell-768-dark-collapsed.png` });
  await page.getByRole("button", { name: translate("shell.expandSidebar") }).click();
  await sidebarTransitionsDone();
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.system") }).click();
  await page.keyboard.press("Escape");

  // 390px: rail and sidebar collapse into a drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  check(await sidebar.count() === 0, "sidebar visible at 390px without opening the drawer");
  check(await page.getByRole("button", { name: translate("shell.expandSidebar") }).count() === 0, "desktop toggle leaked into the phone shell");
  check(await page.getByRole("link", { name: translate("app.title"), exact: true }).count() === 0, "brand link remains in the phone shell");
  check(await page.getByRole("button", { name: translate("workspace.switch") }).isVisible(), "workspace switcher is missing at 390px");
  check((await page.getByRole("button", { name: translate("workspace.switch") }).innerText()).includes("E2E team"), "phone workspace switcher does not identify the current workspace");
  check(await page.getByRole("button", { name: translate("workspace.switch") }).getAttribute("aria-label") === `${translate("workspace.switch")}: E2E team`, "phone workspace switcher accessible name omits the current workspace");
  await page.getByRole("button", { name: translate("shell.openMenu") }).focus();
  await page.keyboard.press("Tab");
  check(await page.getByRole("button", { name: translate("workspace.switch") }).evaluate((element) => element === document.activeElement), "workspace switcher is not next in the phone Tab order");
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: "E2E team" }).waitFor();
  await page.keyboard.press("Escape");
  await saveShot(page, { path: `${shots}/shell-390-closed.png` });
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  await page.getByRole("dialog", { name: translate("shell.sidebar") }).waitFor();
  await page.getByRole("navigation", { name: `${translate("projectNav.label")} MOB` }).getByRole("link", { name: translate("projectNav.views") }).waitFor();
  const phoneSecondProjectToggle = page.getByRole("dialog", { name: translate("shell.sidebar") }).getByRole("button", { name: `${translate("sidebar.toggleProject")}: Second project` });
  check(await phoneSecondProjectToggle.getAttribute("aria-expanded") === "false", "phone drawer did not restore collapsed project menu state");
  await clickAndSave(phoneSecondProjectToggle);
  await page.reload();
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  const reopenedPhoneSecondProjectToggle = page.getByRole("dialog", { name: translate("shell.sidebar") }).getByRole("button", { name: `${translate("sidebar.toggleProject")}: Second project` });
  await reopenedPhoneSecondProjectToggle.waitFor();
  check(await reopenedPhoneSecondProjectToggle.getAttribute("aria-expanded") === "true", "phone drawer did not preserve expanded project menu state on reload");
  await clickAndSave(reopenedPhoneSecondProjectToggle);
  await page.reload();
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  const collapsedPhoneSecondProjectToggle = page.getByRole("dialog", { name: translate("shell.sidebar") }).getByRole("button", { name: `${translate("sidebar.toggleProject")}: Second project` });
  await collapsedPhoneSecondProjectToggle.waitFor();
  check(await collapsedPhoneSecondProjectToggle.getAttribute("aria-expanded") === "false", "phone drawer did not preserve collapsed project menu state on reload");
  await saveShot(page, { path: `${shots}/shell-390-drawer.png` });
  await page.getByRole("navigation", { name: `${translate("projectNav.label")} MOB` }).getByRole("link", { name: translate("projectNav.views") }).click();
  await page.waitForURL(`${web}/${slug}/projects/MOB/views`);
  await page.getByRole("dialog", { name: translate("shell.sidebar") }).waitFor({ state: "detached" });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal page scroll at 390px");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark") }).click();
  await page.keyboard.press("Escape");
  await saveShot(page, { path: `${shots}/shell-390-dark-closed.png` });
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  await page.getByRole("dialog", { name: translate("shell.sidebar") }).waitFor();
  await saveShot(page, { path: `${shots}/shell-390-dark-drawer.png` });
  await page.getByRole("button", { name: translate("shell.closeMenu") }).last().click();
  await page.getByRole("dialog", { name: translate("shell.sidebar") }).waitFor({ state: "detached" });
  console.log("shell ok: drawer at 390px");

  // The skip link moves focus to the main content.
  await page.getByRole("link", { name: translate("shell.skipToMain") }).focus();
  await page.keyboard.press("Enter");
  check(await page.evaluate(() => document.activeElement?.id === "main-content"), "the skip link did not move focus to main");
  console.log("shell ok: skip link focuses main");

  console.log("e2e shell: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
  await failurePage?.screenshot({ path: `${shots}/failure.png` }).catch(() => {});
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
