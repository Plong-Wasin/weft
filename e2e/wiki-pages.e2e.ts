// Browser end-to-end flow: live Wiki updates, Wiki and Pages list controls, and the page editor.
// Run with `bun e2e/wiki-pages.e2e.ts` (set DATABASE_URL to an isolated test database). Screenshots go to .local/visual/review/15-wiki-and-pages.
import { chromium } from "playwright";
import { eq, like } from "drizzle-orm";
import { createDatabase, users, workspaceMembers, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31157);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52157);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31159);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const liveHttp = `http://localhost:${livePort}`;
const shots = reviewShots("15-wiki-and-pages");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true", VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

let failed = false;
const { client, db } = createDatabase();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") console.error(`browser console: ${message.text()}`); });
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  async function waitForStoredText(pageId: string, text: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const stored = await call<{ content: unknown } | null>("get_wiki_page", { pageId });
      if (JSON.stringify(stored?.content).includes(text)) return;
      await Bun.sleep(250);
    }
    throw new Error(`page content did not persist: ${text}`);
  }

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Wiki Tester");
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
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const project = (await call<Array<{ id: string; key: string }>>("list_projects", { workspaceId, archived: false })).find((candidate) => candidate.key === "MOB")!;
  await call("create_wiki_page", { workspaceId, title: "Handbook" });
  await call("create_wiki_page", { workspaceId, title: "Runbook" });

  // Scope moves show their impact before changing the page or its subtree.
  const moveRoot = await call<{ id: string }>("create_wiki_page", { workspaceId, projectId: project.id, title: "Move guide" });
  await call("create_wiki_page", { workspaceId, projectId: project.id, parentId: moveRoot.id, title: "Move child" });
  const moveCollection = await call<{ id: string }>("create_collection", { workspaceId, name: "Move destination" });
  await page.goto(`${web}/${slug}/projects/MOB/pages/${moveRoot.id}`);
  await page.getByRole("complementary", { name: translate("wiki.details") }).waitFor();
  const moveScope = page.getByRole("combobox", { name: translate("wiki.linkProject") });
  let moveWarning = "";
  page.once("dialog", async (dialog) => { moveWarning = dialog.message(); await dialog.dismiss(); });
  await moveScope.selectOption(`collection:${moveCollection.id}`);
  await page.waitForTimeout(250);
  check(moveWarning.includes("Move 2 pages") && moveWarning.includes("0 page shares") && moveWarning.includes("0 work-item links"), `move warning must state exact impact counts: ${moveWarning}`);
  check((await call<{ projectId: string | null }>("get_wiki_page", { pageId: moveRoot.id }))?.projectId === project.id, "dismissing the warning must leave the page in its source project");
  page.once("dialog", async (dialog) => { check(dialog.message() === moveWarning, "confirmation must repeat the move warning"); await dialog.accept(); });
  await moveScope.selectOption(`collection:${moveCollection.id}`);
  await page.waitForURL(new RegExp(`/${slug}/wiki/${moveRoot.id}$`));
  check((await call<{ collectionId: string | null }>("get_wiki_page", { pageId: moveRoot.id }))?.collectionId === moveCollection.id, "confirmed move must place the subtree in the selected Collection");
  check((await call<{ collectionId: string | null }>("get_wiki_page", { pageId: (await call<Array<{ id: string; parentId: string | null }>>("list_wiki_pages", { workspaceId })).find((candidate) => candidate.parentId === moveRoot.id)!.id }))?.collectionId === moveCollection.id, "the child must move with its parent");
  console.log("wiki-pages ok: move warning and confirmed subtree move");

  // Drag a Wiki page onto another page; the indicator names the result before release and the parent persists.
  const dragSource = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Drag source" });
  const dragTarget = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Drag target" });
  await page.goto(`${web}/${slug}/wiki`);
  const sourceRow = page.locator(`[data-wiki-drop-id="page:${dragSource.id}"]`);
  const targetRow = page.locator(`[data-wiki-drop-id="page:${dragTarget.id}"]`);
  await sourceRow.waitFor(); await targetRow.waitFor();
  const sourceBox = await page.locator(`[data-wiki-drag-handle="${dragSource.id}"]`).boundingBox(); const targetBox = await targetRow.boundingBox();
  check(!!sourceBox && !!targetBox, "drag rows must be visible");
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + 80, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.getByText(translate("wikiSidebar.dropNest"), { exact: true }).waitFor();
  await page.mouse.up();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await call<{ parentId: string | null }>("get_wiki_page", { pageId: dragSource.id }))?.parentId === dragTarget.id) break;
    await Bun.sleep(100);
  }
  await page.reload();
  check((await call<{ parentId: string | null }>("get_wiki_page", { pageId: dragSource.id }))?.parentId === dragTarget.id, "drag nesting must persist after reload");
  console.log("wiki-pages ok: drag indicator and persisted nesting");

  // Wiki lists every page; Pages of the project lists none yet.
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("main").getByRole("link", { name: "Handbook" }).waitFor();
  await page.getByRole("main").getByRole("link", { name: "Runbook" }).waitFor();
  // List state is addressable, so refreshing preserves the selected tab, filters, and order.
  await page.getByRole("tab", { name: translate("pages.tab.all") }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "all");
  await page.getByLabel(translate("pages.filter.owner")).selectOption({ label: "Wiki Tester" });
  await page.waitForFunction(() => Boolean(new URLSearchParams(location.search).get("owner")));
  await page.getByLabel(translate("pages.order")).selectOption("name");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("order") === "name");
  check(page.url().includes("tab=all") && page.url().includes("owner=") && page.url().includes("order=name"), "Wiki list controls must be reflected in the URL");
  await page.reload();
  await page.getByRole("main").getByRole("link", { name: "Handbook" }).waitFor();
  check(await page.getByRole("tab", { name: translate("pages.tab.all") }).getAttribute("aria-selected") === "true", "Wiki tab must survive reload");
  check(await page.getByLabel(translate("pages.filter.owner")).inputValue() !== "", "Wiki owner filter must survive reload");
  check(await page.getByLabel(translate("pages.order")).inputValue() === "name", "Wiki order must survive reload");
  await page.getByLabel(translate("pages.filter.owner")).selectOption("");

  // A different workspace member creates a Wiki page; the open list refreshes from its SSE signal.
  const secondaryEmail = `e2e-collab-${slug}@example.test`;
  const secondaryContext = await browser.newContext();
  const secondary = await secondaryContext.newPage();
  const secondarySlug = `${slug}-collab`;
  await secondary.goto(web);
  await secondary.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await secondary.getByLabel(translate("auth.name")).fill("Wiki Collaborator");
  await secondary.getByLabel(translate("auth.email")).fill(secondaryEmail);
  await secondary.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await secondary.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await secondary.getByRole("button", { name: translate("auth.signUp") }).click();
  await secondary.getByLabel(translate("workspace.name")).fill("Collaborator team");
  await secondary.getByLabel(translate("workspace.slug")).fill(secondarySlug);
  await secondary.getByRole("button", { name: translate("workspace.create") }).click();
  const [collaborator] = await db.select().from(users).where(eq(users.email, secondaryEmail));
  await db.insert(workspaceMembers).values({ workspaceId, userId: collaborator!.id, role: "Admin" });
  await secondary.waitForTimeout(1_200);
  const createResponse = await secondary.request.post(`${api}/actions/create_wiki_page`, { data: { workspaceId, title: "Created by collaborator" } });
  check(createResponse.ok, "a second workspace member must be able to create a Wiki page");
  await page.getByRole("main").getByRole("link", { name: "Created by collaborator" }).waitFor({ timeout: 10_000 });
  await page.getByLabel(translate("pages.filter.owner")).selectOption({ label: "Wiki Collaborator" });
  await page.getByRole("main").getByRole("link", { name: "Created by collaborator" }).waitFor();
  await page.getByRole("main").getByRole("link", { name: "Handbook" }).waitFor({ state: "detached" });
  check(await page.getByRole("main").getByRole("link", { name: "Handbook" }).count() === 0, "Owner filter must hide pages owned by other people");
  await page.getByLabel(translate("pages.filter.owner")).selectOption("");
  await page.getByLabel(translate("pages.filter.createdAfter")).fill("2999-01-01");
  await page.getByRole("main").getByRole("link", { name: "Handbook" }).waitFor({ state: "detached" });
  await page.getByText(translate("wiki.empty")).waitFor();
  await page.getByLabel(translate("pages.filter.createdAfter")).fill("");
  await page.getByRole("main").getByRole("link", { name: "Handbook" }).waitFor();
  await secondaryContext.close();
  console.log("wiki-pages ok: collaborator list updates without reload");
  await page.goto(`${web}/${slug}/projects/MOB/pages`);
  await page.getByText(translate("pages.empty")).waitFor();
  check(await page.getByRole("main").getByRole("link", { name: "Handbook" }).count() === 0, "Pages must start empty");
  await page.screenshot({ path: `${shots}/pages-empty-1440.png` });

  // Pages and Wiki lists are separate scopes; seed shared and private Pages for list controls.
  const sharedPage = await call<{ id: string }>("create_wiki_page", { workspaceId, projectId: project.id, title: "A Project draft" });
  await call("create_wiki_page", { workspaceId, projectId: project.id, title: "Z Private draft", access: "private" });
  await Bun.sleep(1_100);
  await call("update_wiki_page", { pageId: sharedPage.id, title: "A Project handbook" });
  await page.getByRole("main").getByRole("link", { name: "A Project handbook" }).waitFor();
  await page.getByRole("tab", { name: translate("pages.tab.all") }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "all");
  await page.getByLabel(translate("pages.filter.owner")).selectOption({ label: "Wiki Tester" });
  await page.waitForFunction(() => Boolean(new URLSearchParams(location.search).get("owner")));
  await page.getByLabel(translate("pages.filter.createdAfter")).fill("2020-01-01");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("createdAfter") === "2020-01-01");
  await page.getByLabel(translate("pages.filter.updatedAfter")).fill("2020-01-01");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("updatedAfter") === "2020-01-01");
  await page.getByLabel(translate("pages.order")).selectOption("updated");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("order") === "updated");
  check(page.url().includes("tab=all") && page.url().includes("createdAfter=2020-01-01") && page.url().includes("updatedAfter=2020-01-01") && page.url().includes("order=updated"), "Pages filters and order must be reflected in the URL");
  await page.reload();
  await page.getByRole("main").getByRole("link", { name: "A Project handbook" }).waitFor();
  check(await page.getByLabel(translate("pages.filter.owner")).inputValue() !== "", "Pages owner filter must survive reload");
  check(await page.getByLabel(translate("pages.filter.createdAfter")).inputValue() === "2020-01-01", "Pages created date filter must survive reload");
  check(await page.getByLabel(translate("pages.filter.updatedAfter")).inputValue() === "2020-01-01", "Pages updated date filter must survive reload");
  check(await page.getByLabel(translate("pages.order")).inputValue() === "updated", "Pages order must survive reload");
  const projectPageList = page.getByRole("region", { name: translate("projectNav.pages") });
  const listedPages = () => projectPageList.locator("ul.grid > li a").allTextContents();
  check((await listedPages())[0] === "A Project handbook", "Updated order must put the most recently edited Page first");
  await page.getByLabel(translate("pages.order")).selectOption("created");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("order") === "created");
  check((await listedPages())[0] === "Z Private draft", "Created order must put the newest Page first");
  await page.getByLabel(translate("pages.order")).selectOption("name");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("order") === "name");
  check((await listedPages())[0] === "A Project handbook", "Name order must sort Pages alphabetically");
  await page.getByLabel(translate("pages.filter.createdAfter")).fill("2999-01-01");
  await page.getByRole("main").getByRole("link", { name: "A Project handbook" }).waitFor({ state: "detached" });
  check(await page.getByRole("main").getByRole("link", { name: "A Project handbook" }).count() === 0, "Created date filter must hide older Pages");
  await page.getByLabel(translate("pages.filter.createdAfter")).fill("2020-01-01");
  await page.getByRole("main").getByRole("link", { name: "A Project handbook" }).waitFor();
  await page.goto(`${web}/${slug}/projects/MOB/pages`);
  await page.getByRole("main").getByRole("link", { name: "A Project handbook" }).waitFor();
  await page.getByRole("tab", { name: translate("pages.tab.private") }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "private");
  // "Z Private draft" is also listed on the All tab, so wait for the public page to leave before asserting.
  await page.getByRole("main").getByRole("link", { name: "A Project handbook" }).waitFor({ state: "detached" });
  await page.getByRole("main").getByRole("link", { name: "Z Private draft" }).waitFor();
  check(await page.getByRole("main").getByRole("link", { name: "A Project handbook" }).count() === 0, "Private tab must hide public pages");
  await page.getByRole("tab", { name: translate("pages.tab.public") }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "public");
  await page.getByRole("main").getByRole("link", { name: "A Project handbook" }).waitFor();
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("main").getByRole("link", { name: "Runbook" }).waitFor();
  await page.getByRole("main").getByRole("link", { name: "Handbook" }).waitFor();
  console.log("wiki-pages ok: Wiki and Pages list tabs, filters, and order");
  await page.goto(`${web}/${slug}/projects/MOB/pages`);
  // Move Handbook from the Wiki into the project's Pages: it leaves the Wiki because each document has one scope.
  await page.getByLabel(translate("pages.linkExisting")).selectOption({ label: "Handbook" });
  await page.getByRole("main").getByRole("link", { name: "Handbook" }).waitFor();
  check(await page.getByRole("main").getByRole("link", { name: "Runbook" }).count() === 0, "Pages must show only linked pages");
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("main").getByRole("link", { name: "Runbook" }).waitFor();
  check(await page.getByRole("main").getByRole("link", { name: "Handbook" }).count() === 0, "a Page must leave the Wiki after moving to a project");
  console.log("wiki-pages ok: Wiki and project Pages follow document scope");

  // Add page from Pages creates and links; the editor opens in project context.
  await page.goto(`${web}/${slug}/projects/MOB/pages`);
  await page.getByRole("button", { name: translate("pages.add") }).click();
  await page.waitForURL(new RegExp(`/${slug}/projects/MOB/pages/[0-9a-f-]+$`));
  await page.locator(".ProseMirror").waitFor();
  const toolbar = page.getByRole("toolbar", { name: translate("wiki.toolbar") });
  await toolbar.waitFor();
  await page.screenshot({ path: `${shots}/page-editor-1440.png` });
  // Toolbar: type, select all, bold, heading; saved and persisted after reload.
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("Hello toolbar");
  await page.keyboard.press("Control+a");
  await toolbar.getByRole("button", { name: translate("wiki.tool.bold") }).click();
  await toolbar.getByRole("button", { name: translate("wiki.tool.bulletList") }).click();
  await page.getByText(translate("wiki.saved")).waitFor({ timeout: 10_000 });
  const pageId = page.url().match(/([0-9a-f-]{36})$/)?.[1];
  check(Boolean(pageId), "page URL must include its id");
  await waitForStoredText(pageId!, "Hello toolbar");
  await page.reload();
  await page.locator(".ProseMirror ul li strong", { hasText: "Hello toolbar" }).waitFor();
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  // A slash typed inside a word stays in the text and opens no menu.
  await page.keyboard.type("a/b");
  check((await editor.innerText()).includes("a/b"), "a typed slash inside text must stay in the page");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const slash = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await slash.waitFor();
  for (const key of ["wiki.tool.h1", "wiki.tool.h2", "wiki.tool.h3", "wiki.tool.h4", "wiki.tool.h5", "wiki.tool.h6", "wiki.tool.bulletList", "wiki.tool.orderedList", "wiki.insert.todo", "wiki.insert.table", "wiki.tool.quote", "wiki.tool.codeBlock", "wiki.insert.callout", "wiki.insert.divider", "wiki.insert.emoji", "wiki.insert.color", "wiki.insert.image"] as const) {
    await slash.getByRole("option", { name: translate(key), exact: true }).waitFor();
  }
  // Keyboard: typing filters, Enter picks; Escape keeps the typed slash.
  await page.keyboard.type("quo");
  check(await slash.getByRole("option").count() === 1, "slash menu did not filter by the typed query");
  await page.keyboard.press("Enter");
  await slash.waitFor({ state: "detached" });
  check(await editor.locator("blockquote").count() === 1, "Enter must insert the highlighted block");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await slash.waitFor();
  await page.keyboard.press("Escape");
  await slash.waitFor({ state: "detached" });
  check((await editor.innerText()).includes("/"), "Escape must close the slash menu and keep the typed slash");
  await page.keyboard.press("Backspace");
  // Pointer: a real mouse click on an option inserts it.
  await page.keyboard.type("/");
  await slash.waitFor();
  // Image opens the file chooser (a programmatic click from the menu must count as a user gesture).
  await page.keyboard.type("imag");
  // Wait until the filter settled on the single Image option, or Enter would pick whichever option is highlighted.
  await page.waitForFunction((count) => document.querySelectorAll(".slash-menu [role=option]").length === count, 1);
  // Playwright turns on file chooser interception asynchronously; a key press is fast enough to beat it, so take one round trip first.
  const chooser = page.waitForEvent("filechooser", { timeout: 5_000 });
  await page.evaluate(() => undefined);
  await page.keyboard.press("Enter");
  await chooser;
  await slash.waitFor({ state: "detached" });
  check(!(await editor.innerText()).includes("/imag"), "picking Image must remove the typed slash command text");
  await page.keyboard.type("/");
  await slash.waitFor();
  const option = await slash.getByRole("option", { name: translate("wiki.tool.h2"), exact: true }).boundingBox();
  await page.mouse.click(option!.x + option!.width / 2, option!.y + option!.height / 2);
  await page.keyboard.type("Outline section");
  await page.getByRole("tab", { name: translate("wiki.outline") }).click();
  const outline = page.getByRole("navigation", { name: translate("wiki.outline") });
  const heading = outline.getByRole("button", { name: "Outline section" });
  await heading.waitFor();
  await heading.click();
  check(await page.locator(".ProseMirror h2").filter({ hasText: "Outline section" }).count() === 1, "outline entry must navigate to its heading");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("@Wiki");
  const mentions = page.getByRole("listbox", { name: translate("wiki.mentionMembers") });
  await mentions.waitFor();
  await mentions.getByRole("option", { name: "Wiki Tester" }).click();
  await page.keyboard.type(" mentioned");
  await page.getByText(translate("wiki.saved")).waitFor({ timeout: 10_000 });
  await waitForStoredText(pageId!, "Outline section");
  await waitForStoredText(pageId!, "Wiki Tester");
  await page.reload();
  await page.locator(".ProseMirror h2", { hasText: "Outline section" }).waitFor();
  await page.locator(".ProseMirror .mention", { hasText: "Wiki Tester" }).waitFor();
  console.log("wiki-pages ok: slash menu, outline navigation and persisted heading");
  await page.getByRole("tab", { name: translate("wiki.activity") }).click();
  await page.getByRole("region", { name: translate("wiki.activity") }).getByText(new RegExp(translate("wiki.activity.created"))).waitFor();
  console.log("wiki-pages ok: toolbar, autosave, activity");

  // Link/unlink from the page's details.
  const details = page.getByRole("complementary", { name: translate("wiki.details") });
  await details.getByRole("tab", { name: translate("wiki.details") }).click();
  // The panel must fit its column and every control inside must stay within it, at a phone width and just above the lg breakpoint (where the 18rem column applies).
  // A long project or collection name widens the scope select; the panel must absorb it, not grow past its column.
  await details.getByRole("combobox", { name: translate("wiki.linkProject") }).evaluate((select: HTMLSelectElement) => { select.add(new Option(`LONG · ${"Very long project name ".repeat(6)}`, "collection:long")); });
  for (const width of [320, 1024]) {
    await page.setViewportSize({ width, height: 740 });
    for (const pane of [translate("wiki.details"), translate("wiki.outline")]) {
      await details.getByRole("tab", { name: pane }).click();
      const fit = await details.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const outside = [...element.querySelectorAll("*")].filter((child) => { const rect = child.getBoundingClientRect(); return rect.width > 0 && (rect.right > box.right + 1 || rect.left < box.left - 1); }).map((child) => child.tagName + "." + String(child.getAttribute("class")).slice(0, 40));
        return { client: element.clientWidth, scroll: element.scrollWidth, right: Math.round(box.right), viewport: window.innerWidth, document: document.documentElement.scrollWidth, outside };
      });
      check(fit.scroll <= fit.client && fit.right <= fit.viewport && fit.document <= fit.viewport && fit.outside.length === 0, `Page details panel (${pane}) overflows at ${width}px: ${JSON.stringify(fit)}`);
    }
    await details.getByRole("tab", { name: translate("wiki.details") }).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const scope = details.getByRole("combobox", { name: translate("wiki.linkProject") });
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await scope.selectOption("collection:");
  await page.waitForURL(new RegExp(`/${slug}/wiki/[0-9a-f-]+$`));
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("main").getByRole("link", { name: "Untitled" }).waitFor();
  check(await page.getByRole("main").getByRole("link", { name: "Handbook" }).count() === 0, "the Page remains in its project when another Page moves back to Wiki");
  console.log("wiki-pages ok: Page and Wiki page keep their scopes");

  // Deleting a Page asks first: dismissing keeps it, accepting removes it.
  await call("create_wiki_page", { workspaceId, title: "Disposable" });
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("main").getByRole("link", { name: "Disposable" }).click();
  await page.getByRole("complementary", { name: translate("wiki.details") }).getByRole("tab", { name: translate("wiki.details") }).click();
  const deleteButton = page.getByRole("complementary", { name: translate("wiki.details") }).getByRole("button", { name: translate("wiki.delete"), exact: true });
  let deleteAsked = "";
  page.once("dialog", (dialog) => { deleteAsked = dialog.message(); void dialog.dismiss(); });
  await deleteButton.click();
  check(deleteAsked === translate("wiki.deleteConfirm"), `Page delete did not ask for confirmation (${deleteAsked})`);
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("main").getByRole("link", { name: "Disposable" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await deleteButton.click();
  await page.waitForURL(`${web}/${slug}/wiki`);
  await page.getByRole("main").getByRole("link", { name: "Untitled" }).waitFor();
  await page.getByRole("main").getByRole("link", { name: "Disposable" }).waitFor({ state: "detached", timeout: 5_000 }); // accepting the confirmation deletes the Page
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("main").getByRole("link", { name: "Runbook" }).click();
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("Public words for logged out readers");
  const runbookId = page.url().match(/([0-9a-f-]{36})$/)?.[1];
  check(Boolean(runbookId), "Runbook URL must include its id");
  await waitForStoredText(runbookId!, "Public words for logged out readers");
  await page.getByRole("button", { name: translate("wiki.publishLink") }).click();
  const publishedLink = page.getByRole("complementary", { name: translate("wiki.details") }).getByRole("link");
  await publishedLink.waitFor();
  const publishedUrl = await publishedLink.getAttribute("href");
  check(Boolean(publishedUrl?.startsWith(`${web}/p/`)), `share dialog should show the public web URL: ${publishedUrl}`);
  const publicApiUrl = `${api}/published/${publishedUrl!.split("/").at(-1)}`;
  const publicApi = await (await page.request.get(publicApiUrl)).json() as { content: unknown };
  check(JSON.stringify(publicApi.content).includes("Public words for logged out readers"), "public API should include the saved Wiki page content");
  const loggedOutContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const publishedPage = await loggedOutContext.newPage();
  await publishedPage.goto(publishedUrl!);
  await publishedPage.getByTestId("published-wiki-page").getByText("Public words for logged out readers").waitFor();
  check(await publishedPage.getByTestId("published-wiki-page").getByText("Wiki Tester").count() === 0, "published page must not expose the member mention name");
  await loggedOutContext.close();
  console.log("wiki-pages ok: published link opens read-only content when logged out");

  await page.goto(`${web}/${slug}/wiki`);
  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("main").getByRole("link", { name: "Untitled" }).waitFor();
  await page.screenshot({ path: `${shots}/wiki-list-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${shots}/wiki-list-1440.png` });

  console.log("e2e wiki-pages: ok");
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
