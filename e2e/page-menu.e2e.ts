// Page and Wiki page header (ticket 03, with the header Share and Publish buttons): one breadcrumb on a Page, no project Settings button in the editor,
// a Locked badge by the title instead of the large Lock button, and one page menu holding Lock or Unlock, Add subpage,
// Archive or Restore, Markdown source and Delete (last, after a line, with its confirmation).
import { chromium, type Browser } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "../packages/db/src";
import { createProjectActions, createWikiActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31268);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52268);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 33268);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];
const { client, db } = createDatabase();
let browser: Browser | null = null;
async function waitFor(url: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US", hasTouch: true });
  const slug = `pagemenu-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name} failed (${response.status()}): ${await response.text()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Menu Writer");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Menu review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const ownerId = me.user.id;
  const projects = createProjectActions(db);
  const wiki = createWikiActions(db);
  const project = await projects.createProject.handler({ userId: ownerId }, { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  const handbook = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Handbook", contentMarkdown: "Intro paragraph for the menu." });
  const releasePlan = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, projectId: project.id, title: "Release plan", contentMarkdown: "Project page body." });
  await page.evaluate(() => localStorage.clear());

  const menuButton = () => page.getByRole("button", { name: translate("wiki.exports", "en"), exact: true });
  const menu = () => page.getByRole("menu");
  const item = (key: Parameters<typeof translate>[0]) => menu().getByRole("menuitem", { name: translate(key, "en"), exact: true });
  const switchItem = (key: Parameters<typeof translate>[0]) => menu().getByRole("menuitemcheckbox", { name: translate(key, "en"), exact: true });

  // Wiki page: header has no large Lock button; the page menu holds the moved actions in order, Delete last after a line.
  await page.goto(`${web}/${slug}/wiki/${handbook.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Intro paragraph for the menu.").waitFor();
  check(await page.getByTestId("wiki-page-lock").count() === 0, "the large Lock button is still on the Wiki page");
  check(await page.getByText("Lock the page so nobody can edit it until someone unlocks it.", { exact: true }).count() === 0, "the Lock help line is still on the Wiki page");
  check(await page.getByTestId("wiki-editor").getByRole("button", { name: translate("editor.sourceMode", "en"), exact: true }).count() === 0, "Markdown source still floats inside the writing area");
  check(await page.getByRole("navigation", { name: translate("wiki.breadcrumb", "en") }).count() === 1, "Wiki page does not show exactly one breadcrumb");
  await menuButton().click();
  await menu().waitFor();
  const shots = join(process.cwd(), ".local/shots/shadcn-03/after");
  mkdirSync(shots, { recursive: true });
  const viewports = [
    ["1440x900", 1440, 900], ["1024x768", 1024, 768], ["820x1180", 820, 1180],
    ["768x1024", 768, 1024], ["844x390", 844, 390], ["667x375", 667, 375], ["390x844", 390, 844],
  ] as const;
  for (const [name, width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(({ width: viewportWidth, height: viewportHeight }) => {
      const panel = document.querySelector<HTMLElement>("[role=menu]");
      if (!panel) return false;
      const bounds = panel.getBoundingClientRect();
      return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= viewportWidth && bounds.bottom <= viewportHeight;
    }, { width, height }, { timeout: 1500 });
    const panelBounds = await menu().boundingBox();
    const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    check(panelBounds !== null && panelBounds.x >= 0 && panelBounds.y >= 0 && panelBounds.x + panelBounds.width <= width && panelBounds.y + panelBounds.height <= height, `menu overflows viewport ${name}: ${JSON.stringify(panelBounds)}`);
    check(bounds.scrollWidth <= width, `page scrolls horizontally at ${name}`);
    const touchTargets = await menu().locator("[role^=menuitem]").evaluateAll((items) => items.every((element) => { const box = element.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; }));
    check(touchTargets, `a menu item is smaller than 44px at ${name}`);
    await page.screenshot({ path: join(shots, `light-${name}.png`) });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.screenshot({ path: join(shots, `dark-${name}.png`) });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const lastItem = menu().getByRole("menuitem").last();
  check(await lastItem.textContent() === translate("wiki.delete", "en"), "Delete is not the last menu item");
  check(await item("wiki.delete").evaluate((element) => element.previousElementSibling?.previousElementSibling?.getAttribute("role") === "separator"), "Delete is not in the Danger group after a line");
  check(await item("wiki.delete").evaluate((element) => element.className.includes("text-destructive")), "Delete is not styled as danger");
  const colorOf = (key: Parameters<typeof translate>[0]) => item(key).evaluate((element) => getComputedStyle(element).color);
  check(await colorOf("wiki.delete") !== await colorOf("wiki.newChild"), "Delete renders in the same colour as a normal item");
  for (const key of ["wiki.newChild", "pages.archive"] as const) check(await item(key).count() === 1, `page menu is missing ${key}`);
  for (const key of ["editor.sourceMode", "wiki.lock"] as const) check(await menu().getByRole("menuitemcheckbox", { name: translate(key, "en"), exact: true }).count() === 1, `page menu is missing the switch ${key}`);
  console.log("PASS Wiki page header has no large Lock button and the page menu holds the moved actions, Delete last after a line");

  // Layout (ticket 17): about 18 rem wide, five groups separated by lines, an icon on every item, the long help text kept out of view.
  const panel = page.locator("[data-popover-panel][role=menu]");
  const panelBox = await panel.boundingBox();
  check(panelBox !== null && panelBox.width <= 288.5, `page menu is wider than about 18 rem at 1440px: ${panelBox?.width}`);
  const shape = await panel.evaluate((element) => [...element.children].map((child) => child.getAttribute("role") === "separator" ? "|" : child.firstElementChild?.textContent?.trim()));
  check(JSON.stringify(shape) === JSON.stringify([translate("wiki.exportMarkdown", "en"), translate("wiki.importMarkdown", "en"), translate("wiki.exportPdf", "en"), "|", translate("wiki.fullWidth", "en"), translate("editor.sourceMode", "en"), "|", translate("wiki.history", "en"), "|", translate("wiki.lock", "en"), translate("wiki.newChild", "en"), "|", translate("pages.archive", "en"), translate("wiki.delete", "en")]), `page menu groups are wrong: ${JSON.stringify(shape)}`);
  check(await panel.getByRole("menuitem").evaluateAll((items) => items.every((element) => element.querySelector("svg"))) && await panel.getByRole("menuitemcheckbox").evaluateAll((items) => items.every((element) => element.querySelector("svg"))), "a page menu item has no icon");
  check(await panel.getByText(translate("wiki.markdownHint", "en"), { exact: true }).isVisible() === false, "the Markdown help text is visible in the page menu");
  check(await panel.getByRole("menuitem", { name: translate("wiki.exportMarkdown", "en"), exact: true }).getAttribute("title") === translate("wiki.markdownHint", "en"), "Export Markdown has no tooltip with the help text");
  const described = await panel.getByRole("menuitem", { name: translate("wiki.exportMarkdown", "en"), exact: true }).evaluate((element) => document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent ?? "");
  check(described === translate("wiki.markdownHint", "en"), "Export Markdown is not described by the help text");
  check(!(await panel.textContent())?.includes("![[asset:") && !described.includes("![[asset:"), "the internal ![[asset: token is shown in the page menu");
  check(await panel.getByRole("menuitemcheckbox", { name: translate("wiki.fullWidth", "en"), exact: true }).getAttribute("aria-checked") === "false", "Full width does not expose aria-checked=false");
  console.log("PASS page menu is about 18 rem wide with five grouped sections, an icon per item, the help text as a described-by tooltip and no asset token");

  // Markdown source works from the menu and switches back the same way; it is a switch, so aria-checked follows it.
  check(await switchItem("editor.sourceMode").getAttribute("aria-checked") === "false", "Markdown source is not off before it is turned on");
  await switchItem("editor.sourceMode").click();
  await page.getByTestId("editor-source-text").waitFor();
  await menuButton().click();
  check(await switchItem("editor.sourceMode").getAttribute("aria-checked") === "true", "Markdown source does not show on in the menu");
  await switchItem("editor.sourceMode").click();
  await page.getByTestId("editor-source-text").waitFor({ state: "detached" });
  console.log("PASS Markdown source toggles from the page menu and exposes aria-checked");

  // Lock from the menu: a small Locked badge beside the title; the switch shows on and a second click unlocks it.
  await menuButton().click();
  check(await switchItem("wiki.lock").getAttribute("aria-checked") === "false", "Lock page is not off before locking");
  await switchItem("wiki.lock").click();
  await page.getByTestId("wiki-locked-badge").waitFor();
  check(await page.getByTestId("wiki-locked-badge").textContent() === translate("wiki.locked", "en"), "Locked badge text is wrong");
  await menuButton().click();
  check(await switchItem("wiki.lock").getAttribute("aria-checked") === "true", "Lock page does not show on while locked");
  await switchItem("wiki.lock").click();
  await page.getByTestId("wiki-locked-badge").waitFor({ state: "detached" });
  console.log("PASS lock from the page menu shows a Locked badge and the switch clears it");

  // Keyboard (ticket 17): ArrowDown/ArrowUp move between items, Home/End jump, Escape closes and returns focus to the "..." button.
  await menuButton().focus();
  await page.keyboard.press("Enter");
  const focusedLabel = () => page.evaluate(() => document.activeElement?.firstElementChild?.textContent?.trim() ?? ""); // a menu item's first child holds its visible name; the hidden help text is outside it
  // The menu moves focus a tick after the key press, so each check waits for the expected row before it reads it.
  const expectFocus = async (key: Parameters<typeof translate>[0], message: string) => {
    await page.waitForFunction((name) => document.activeElement?.firstElementChild?.textContent?.trim() === name, translate(key, "en"), { timeout: 5_000 }).catch(() => undefined);
    check(await focusedLabel() === translate(key, "en"), message);
  };
  await expectFocus("wiki.exportMarkdown", "opening the page menu does not focus its first item");
  await page.keyboard.press("ArrowDown");
  await expectFocus("wiki.importMarkdown", "ArrowDown does not move to the next item");
  await page.keyboard.press("End");
  await expectFocus("wiki.delete", "End does not jump to the last item");
  await page.keyboard.press("ArrowDown");
  await expectFocus("wiki.exportMarkdown", "ArrowDown on the last item does not wrap to the first");
  await page.keyboard.press("ArrowUp");
  await expectFocus("wiki.delete", "ArrowUp on the first item does not wrap to the last");
  await page.keyboard.press("Home");
  await expectFocus("wiki.exportMarkdown", "Home does not jump to the first item");
  await page.keyboard.press("Escape");
  await menu().waitFor({ state: "detached" });
  check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === translate("wiki.exports", "en"), "Escape does not return focus to the page menu button");
  console.log("PASS page menu keyboard: ArrowUp/Down wrap, Home/End jump, Escape closes and focuses the trigger");

  const children = async () => (await wiki.listWikiPages.handler({ userId: ownerId }, { workspaceId }))
    .filter((candidate) => candidate.parentId === handbook.id);
  const expectOneChild = async (activate: () => Promise<void>, name: string) => {
    const before = new Set((await children()).map(({ id }) => id));
    const createRequests = new Set<string>();
    let requestCount = 0;
    const onRequest = (request: import("playwright").Request) => {
      if (request.method() !== "POST" || request.url() !== `${api}/actions/create_wiki_page`) return;
      requestCount += 1;
      createRequests.add(request.postDataJSON().parentId);
    };
    page.on("request", onRequest);
    try {
      await menuButton().click();
      await activate();
      await page.waitForURL((url) => url.origin === web && url.pathname.startsWith(`/${slug}/wiki/`) && !url.pathname.endsWith(handbook.id), { timeout: 10_000 });
      await page.getByTestId("wiki-editor").locator(".ProseMirror").waitFor();
      const added = (await children()).filter(({ id }) => !before.has(id));
      check(requestCount === 1 && createRequests.has(handbook.id), `${name}: expected one create request with Handbook as parent, saw ${requestCount}`);
      check(added.length === 1, `${name}: expected one new persisted child under Handbook, saw ${added.length}`);
      check(page.url() === `${web}/${slug}/wiki/${added[0]!.id}`, `${name}: did not navigate to the persisted child`);
    } finally {
      page.off("request", onRequest);
    }
  };
  await expectOneChild(async () => {
    await item("wiki.newChild").focus();
    await page.keyboard.press("Enter");
  }, "Enter on Add subpage");
  await page.goto(`${web}/${slug}/wiki/${handbook.id}`);
  await expectOneChild(() => item("wiki.newChild").click(), "Click on Add subpage");
  console.log("PASS keyboard and click each send one request, persist one Handbook child and navigate to it");

  // Archive and restore from the menu.
  await page.goto(`${web}/${slug}/wiki/${handbook.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Intro paragraph for the menu.").waitFor();
  await menuButton().click();
  await item("pages.archive").click();
  await page.getByText(translate("pages.archivedReadOnly", "en"), { exact: true }).waitFor();
  await menuButton().click();
  await item("pages.unarchive").click();
  await page.getByText(translate("pages.archivedReadOnly", "en"), { exact: true }).waitFor({ state: "detached" });
  console.log("PASS Archive and Restore work from the page menu");

  // Delete from the menu keeps its confirmation: dismissing keeps the page, accepting deletes it.
  const scratch = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Scratch", contentMarkdown: "To delete." });
  await page.goto(`${web}/${slug}/wiki/${scratch.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("To delete.").waitFor();
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void (dialogs.length === 1 ? dialog.dismiss() : dialog.accept()); });
  await menuButton().click();
  await item("wiki.delete").click();
  await Bun.sleep(500);
  check(page.url().endsWith(scratch.id), "dismissing the delete confirmation still left the page");
  await menuButton().click();
  await item("wiki.delete").click();
  await page.waitForURL((url) => url.pathname === `/${slug}/wiki`, { timeout: 10_000 });
  check(dialogs.length === 2 && dialogs.every((message) => message === translate("wiki.deleteConfirm", "en")), `delete did not ask the confirmation (${dialogs.join(" | ")})`);
  console.log("PASS Delete from the page menu asks for confirmation and deletes only when accepted");

  // Header Share and Publish: Share opens the Details panel on its Share section; Publish opens its Published link section.
  // The header shows Published while a link exists, and hides Publish for a private Wiki page; a Lock or an archive does not hide it.
  const shared = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Shared notes", contentMarkdown: "Shared body." });
  await call("set_wiki_page_access", { pageId: shared.id, access: "public" });
  const headerShare = page.getByTestId("wiki-header-share");
  const headerPublish = page.getByTestId("wiki-header-publish");
  const detailsPressed = async () => await page.getByTestId("wiki-details-toggle").getAttribute("aria-pressed");
  const inView = async (selector: string) => await page.evaluate((query) => { const box = document.querySelector(query)?.getBoundingClientRect(); return !!box && box.top >= 0 && box.bottom <= window.innerHeight; }, selector);
  await page.goto(`${web}/${slug}/wiki/${shared.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Shared body.").waitFor();
  check(await headerShare.count() === 1 && await headerPublish.count() === 1, "public Wiki page header is missing Share or Publish");
  check((await headerPublish.textContent())?.trim() === translate("wiki.publish", "en"), "header Publish is not labelled Publish before a link exists");
  await headerShare.click();
  await page.locator("#wiki-share-members").waitFor();
  check(await detailsPressed() === "true", "header Share did not open the Details panel");
  check(await inView("#wiki-share-members") && await page.evaluate(() => !!document.activeElement?.closest("#wiki-share-members")), "header Share did not land on and focus the Share with members section");
  console.log("PASS header Share opens the Details panel on the Share with members section");
  await headerPublish.click();
  await page.locator("#wiki-published-link").waitFor();
  check(await inView("#wiki-published-link"), "header Publish did not scroll to the Published link section");
  await page.locator("#wiki-published-link").getByRole("button", { name: translate("wiki.publishLink", "en"), exact: true }).click();
  await headerPublish.filter({ hasText: translate("wiki.published", "en") }).waitFor();
  await page.reload();
  await headerPublish.filter({ hasText: translate("wiki.published", "en") }).waitFor();
  await headerPublish.click();
  await page.locator("#wiki-published-link").getByRole("button", { name: translate("wiki.revokePublishedLink", "en"), exact: true }).click();
  await headerPublish.filter({ hasText: translate("wiki.publish", "en") }).waitFor();
  console.log("PASS header Publish shows Published while a link exists and revoking returns it to Publish");

  // A locked page can still be published (GLOSSARY: Lock), and so can an archived one; only a private page cannot. Share stays for the owner.
  await call("lock_wiki_page", { pageId: shared.id });
  await page.reload(); await page.getByTestId("wiki-locked-badge").waitFor();
  check(await headerPublish.count() === 1 && await headerShare.count() === 1, "locked Wiki page lost Publish or Share");
  await call("unlock_wiki_page", { pageId: shared.id });
  await call("archive_wiki_page", { pageId: shared.id });
  await page.reload(); await page.getByText(translate("pages.archivedReadOnly", "en"), { exact: true }).waitFor();
  check(await headerPublish.count() === 1, "archived Wiki page lost Publish");
  await call("unarchive_wiki_page", { pageId: shared.id });
  await call("set_wiki_page_access", { pageId: shared.id, access: "private" });
  await page.reload(); await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Shared body.").waitFor();
  check(await headerPublish.count() === 0 && await headerShare.count() === 1, "private Wiki page offers Publish, or lost Share");
  console.log("PASS header Publish stays for locked and archived Wiki pages and is hidden for private ones; Share stays");

  // Narrow screen: both buttons are on screen and Share opens the drawer on its section.
  await call("set_wiki_page_access", { pageId: shared.id, access: "public" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/wiki/${shared.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Shared body.").waitFor();
  for (const button of [headerShare, headerPublish]) {
    const box = await button.boundingBox();
    check(Boolean(box) && box!.x >= 0 && box!.x + box!.width <= 390, "a header Share or Publish button is cut off at 390px");
  }
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "header overflows sideways at 390px");
  await headerShare.click();
  await page.locator("#wiki-share-members").waitFor();
  check(await page.locator("#wiki-share-members").isVisible(), "drawer did not show the Share with members section at 390px");
  console.log("PASS header Share and Publish fit at 390px and Share opens the drawer");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Page (inside a project): one breadcrumb, no project header or Settings button, and the title is the page's own heading.
  await page.goto(`${web}/${slug}/projects/MOB/pages/${releasePlan.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Project page body.").waitFor();
  check(await page.getByRole("navigation", { name: translate("wiki.breadcrumb", "en") }).count() === 1, "Page does not show exactly one breadcrumb");
  check(await page.getByRole("link", { name: translate("projects.back", "en"), exact: true }).count() === 0, "Page still repeats the project header");
  check(await page.locator(`a[href="/${slug}/projects/MOB/settings"]`).count() === 0, "Page still shows the project Settings button");
  check(await page.getByRole("heading", { level: 1, name: "Release plan", exact: true }).count() === 1, "Page has no single level-1 heading for its title");
  check(await page.getByTestId("wiki-header-share").count() === 0 && await page.getByTestId("wiki-header-publish").count() === 0, "a Page header offers Share or Publish");
  console.log("PASS a Page shows one breadcrumb with no project header or Settings button");

  // Narrow screen: the header, menu and writing area fit without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/projects/MOB/pages/${releasePlan.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Project page body.").waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the Page overflows sideways at 390px");
  await page.getByRole("button", { name: translate("wiki.exports", "en"), exact: true }).click();
  await menu().waitFor();
  check(await item("wiki.delete").isVisible(), "Delete is not reachable from the page menu at 390px");
  const narrowBox = await menu().boundingBox();
  check(narrowBox !== null && narrowBox.x >= 0 && narrowBox.x + narrowBox.width <= 390, `page menu does not fit 390px: ${JSON.stringify(narrowBox)}`);
  console.log("PASS the page menu opens and fits at 390px");

  console.log("page menu e2e: ok");
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
  await client.end?.();
}
process.exit(0);
