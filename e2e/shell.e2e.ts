// Browser end-to-end flow: the app shell (rail, sidebar, top bar), workspace switcher, search, notifications, theme, feature toggles, phone drawer.
// Run with `bun e2e/shell.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database). Screenshots go to .local/visual/review/03-app-shell.
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31037);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52037);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("03-app-shell");
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
let failurePage: Page | undefined;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  failurePage = page;
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
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
  const captureDesktopSidebarStates = async (prefix: string) => {
    await assertOneSidebarToggle(`${prefix} expanded`);
    await assertFirstTextIsNotCovered(page.getByRole("link", { name: translate("projects.back"), exact: true }), `${prefix} breadcrumb`);
    check(await page.getByRole("navigation", { name: translate("shell.rail") }).isVisible(), `${prefix} expanded: app rail is missing`);
    await page.waitForTimeout(300); // the sidebar slides in over 200ms; a screenshot taken mid-slide covers the rail labels
    await page.screenshot({ path: `${shots}/${prefix}-expanded.png` });
    await page.getByRole("button", { name: translate("shell.collapseSidebar") }).click();
    await page.waitForTimeout(250);
    await assertOneSidebarToggle(`${prefix} collapsed`);
    await assertFirstTextIsNotCovered(page.getByRole("link", { name: translate("projects.back"), exact: true }), `${prefix} collapsed breadcrumb`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${prefix}: collapsed layout overflows horizontally`);
    await assertRailHitTest(`${prefix} collapsed`);
    await page.screenshot({ path: `${shots}/${prefix}-collapsed.png` });
    await page.mouse.move(65, 400);
    await page.waitForTimeout(250);
    await assertOneSidebarToggle(`${prefix} peeking`);
    await assertFirstTextIsNotCovered(page.getByRole("link", { name: translate("nav.home"), exact: true }), `${prefix} peek menu item`);
    await assertRailHitTest(`${prefix} peek`);
    check((await page.getByRole("navigation", { name: translate("shell.sidebar") }).boundingBox())!.x >= 64, `${prefix}: edge peek did not open`);
    await page.screenshot({ path: `${shots}/${prefix}-peek.png` });
    await page.mouse.move(600, 400);
    await page.waitForTimeout(250);
    check((await page.getByRole("navigation", { name: translate("shell.sidebar") }).boundingBox())!.x < 0, `${prefix}: edge peek did not close`);
    await page.getByRole("button", { name: translate("shell.expandSidebar") }).click();
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
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
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
  check((await sidebarToggle.getAttribute("title"))?.includes("Ctrl/⌘+\\"), "sidebar shortcut is missing from the toggle tooltip");
  check(await sidebarToggle.getAttribute("aria-expanded") === "true", "sidebar does not start expanded");
  await sidebar.getByRole("navigation", { name: new RegExp(translate("projectNav.label")) }).waitFor();
  await sidebar.getByRole("link", { name: translate("cycles.title"), exact: true }).waitFor();
  for (const label of [translate("workspace.switch"), translate("topbar.help"), translate("profile.menu")]) await page.getByRole("button", { name: label }).waitFor();
  check(await page.getByRole("link", { name: translate("app.title"), exact: true }).count() === 0, "brand link remains in the signed-in app shell");
  check(await page.getByRole("button", { name: translate("workspace.switch") }).isVisible(), "workspace switcher is missing from the top-left");
  check((await page.getByRole("button", { name: translate("workspace.switch") }).innerText()).includes("E2E team"), "workspace switcher does not identify the current workspace");
  const desktopSwitcher = page.getByRole("button", { name: translate("workspace.switch") });
  await page.getByRole("link", { name: translate("shell.skipToMain") }).focus();
  await page.keyboard.press("Tab");
  check(await sidebarToggle.evaluate((element) => element === document.activeElement), "desktop sidebar toggle is not in the Tab order after skip link");
  await page.keyboard.press("Tab");
  check(await desktopSwitcher.evaluate((element) => element === document.activeElement), "workspace switcher is not in the desktop Tab order");
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: "E2E team" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: translate("topbar.notifications") }).waitFor();
  const searchBox = await page.getByRole("searchbox", { name: translate("search.label") }).boundingBox();
  check(Boolean(searchBox) && Math.abs(searchBox!.x + searchBox!.width / 2 - 720) < 60, `search not centered: ${JSON.stringify(searchBox)}`);
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.light") }).click();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/shell-1440-light.png` });
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
  await page.waitForTimeout(250);
  check((await sidebar.boundingBox())!.x >= 64, "keyboard focus on the labelled top-bar toggle did not peek the sidebar");
  await assertOneSidebarToggle("1440 focus peek");
  await assertFirstTextIsNotCovered(sidebar.getByRole("link", { name: translate("nav.home"), exact: true }), "1440 focus peek menu item");
  await page.screenshot({ path: `${shots}/shell-1440-focus-peek-light.png` });
  await focusSearchInput.focus();
  await page.waitForTimeout(250);
  check((await sidebar.boundingBox())!.x < 0, "sidebar focus peek stayed open after focus left");
  await page.screenshot({ path: `${shots}/shell-1440-collapsed-light.png` });
  await page.mouse.move(65, 400);
  await page.waitForTimeout(250);
  await assertOneSidebarToggle("1440 pointer peek");
  await assertFirstTextIsNotCovered(sidebar.getByRole("link", { name: translate("nav.home"), exact: true }), "1440 pointer peek menu item");
  await assertRailHitTest("1440 pointer peek");
  check((await sidebar.boundingBox())!.x >= 64, "edge hover did not peek the sidebar");
  await page.screenshot({ path: `${shots}/shell-1440-peek-light.png` });
  await page.mouse.move(600, 400);
  await page.waitForTimeout(250);
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
  await page.getByRole("tab", { name: translate("layout.board") }).click();
  await page.getByTestId("column-Backlog").waitFor();
  check(page.url().includes("layout=board"), "collapsed sidebar board selection was not applied");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "collapsed sidebar causes a horizontal jump on a board");
  check((await page.locator("main").boundingBox())!.x === 64, "collapsed board does not use the content width after the app rail");
  await page.getByRole("tab", { name: translate("layout.list") }).click();
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
  await page.getByLabel(translate("workspace.name")).fill("Second team");
  await page.getByLabel(translate("workspace.slug")).fill(second);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${second}`);
  await page.getByRole("button", { name: translate("workspace.switch") }).click();
  await page.getByRole("menuitemradio", { name: "Second team" }).waitFor();
  await page.getByRole("menuitemradio", { name: "E2E team" }).click();
  await page.waitForURL(`${web}/${slug}`);
  console.log("shell ok: workspace switcher");

  // Search opens the work item and wiki results.
  const searchInput = page.getByRole("searchbox", { name: translate("search.label") });
  await searchInput.fill("Alpha");
  const results = page.getByRole("list", { name: translate("search.results") });
  await results.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  await results.getByRole("link", { name: /Alpha handbook/ }).waitFor();
  await results.getByRole("link", { name: /Alpha handbook/ }).click();
  await page.waitForURL(new RegExp(`/${slug}/wiki/`));
  await searchInput.fill("Alpha");
  await results.getByRole("link", { name: /Alpha shell item/ }).click();
  await page.waitForURL(`${web}/${slug}/browse/MOB-1`);
  console.log("shell ok: search");

  // Notifications icon opens the inbox.
  await page.getByRole("link", { name: translate("topbar.notifications") }).click();
  await page.waitForURL(`${web}/${slug}/notifications`);
  await page.getByRole("heading", { name: new RegExp(translate("inbox.title")) }).waitFor();
  console.log("shell ok: notifications");

  // Theme persists across reload; dark theme screenshot.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark") }).click();
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "dark theme not applied");
  await captureDesktopSidebarStates("shell-1440-dark");
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  check(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "theme did not persist");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark"), checked: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/shell-1440-dark.png` });
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.system") }).click();
  await page.keyboard.press("Escape");
  console.log("shell ok: theme");

  // Intermediate desktop width uses the same sidebar states without a content gap.
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  await captureDesktopSidebarStates("shell-1024-light");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark") }).click();
  await page.keyboard.press("Escape");
  await captureDesktopSidebarStates("shell-1024-dark");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.system") }).click();
  await page.keyboard.press("Escape");

  // Tablet width keeps the workspace switcher directly beside the drawer button.
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.reload();
  await page.getByRole("link", { name: /Alpha shell item/ }).waitFor();
  check(await page.getByRole("link", { name: translate("app.title"), exact: true }).count() === 0, "brand link remains in the tablet shell");
  check(await page.getByRole("button", { name: translate("workspace.switch") }).isVisible(), "workspace switcher is missing at tablet width");
  check((await page.getByRole("button", { name: translate("workspace.switch") }).innerText()).includes("E2E team"), "tablet workspace switcher does not identify the current workspace");
  await captureDesktopSidebarStates("shell-768-light");
  await page.screenshot({ path: `${shots}/shell-768-tablet.png` });
  check(await page.getByRole("button", { name: translate("shell.collapseSidebar") }).isVisible(), "desktop sidebar toggle missing at tablet breakpoint");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark") }).click();
  await page.keyboard.press("Escape");
  await captureDesktopSidebarStates("shell-768-dark");
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
  await page.getByRole("button", { name: translate("shell.openMenu") }).focus();
  await page.keyboard.press("Tab");
  check(await page.getByRole("button", { name: translate("workspace.switch") }).evaluate((element) => element === document.activeElement), "workspace switcher is not next in the phone Tab order");
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: "E2E team" }).waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/shell-390-closed.png` });
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
  await page.screenshot({ path: `${shots}/shell-390-drawer.png` });
  await page.getByRole("navigation", { name: `${translate("projectNav.label")} MOB` }).getByRole("link", { name: translate("projectNav.views") }).click();
  await page.waitForURL(`${web}/${slug}/projects/MOB/views`);
  await page.getByRole("dialog", { name: translate("shell.sidebar") }).waitFor({ state: "detached" });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal page scroll at 390px");
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.dark") }).click();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/shell-390-dark-closed.png` });
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  await page.getByRole("dialog", { name: translate("shell.sidebar") }).waitFor();
  await page.screenshot({ path: `${shots}/shell-390-dark-drawer.png` });
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
