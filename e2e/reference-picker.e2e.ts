// Browser check for the "[[" reference picker in the Wiki, Work item description and comment editors: the popup opens, narrows by
// key and title, groups rows by kind, keeps the highlight in view, picks by keyboard and mouse, shows empty, loading and failed states,
// inserts an internal link that saves as `[[label|kind:id]]`, and feeds the Links and Backlinks panels. "@" keeps its mention list.
import { check, createSignedInContext, launchBrowser, startApi, startLive, startWeb, waitFor } from "./harness";
import { type Locator, type Page } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31480);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52480);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31481);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startLive(livePort, web),
  startWeb(webPort, { api, live: `ws://localhost:${livePort}`, env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true" } }),
];

const picker = (page: Page) => page.getByRole("listbox", { name: translate("reference.picker"), exact: true });

/** Whether the selected option sits fully inside the popup's visible area. */
const selectedInView = (list: Locator) => list.evaluate((element) => {
  const selected = element.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!selected) return false;
  const box = element.getBoundingClientRect();
  const row = selected.getBoundingClientRect();
  return row.top >= box.top && row.bottom <= box.bottom;
});

/** Waits until the editor's saved Written form holds the text, so the link is checked after the save, not before. */
async function waitForSaved(read: () => Promise<string>, text: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await read()).includes(text)) return;
    await Bun.sleep(200);
  }
  throw new Error(`saved Written form never held ${text}; it holds ${await read()}`);
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  const browser = await launchBrowser();
  const slug = `ref-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 } }, api, web, {
    account: { name: "Reference Tester", email: `${slug}@example.test` },
    workspace: { name: "Reference team", slug },
    project: { name: "Mobile", key: "MOB", visibility: "public", shape: "simple" },
  });
  const page = await context.newPage();
  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();

  const call = async <T>(name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name} failed (${response.status()}): ${await response.text()}`);
    return await response.json() as T;
  };
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const projects = await call<Array<{ id: string; key: string }>>("list_projects", { workspaceId });
  const project = projects.find((row) => row.key === "MOB")!;
  const target = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Dark mode toggle" });
  // Ten matches for "Dark mode", so the list overflows and the highlight has to scroll.
  for (let index = 2; index <= 9; index += 1) await call("create_work_item", { projectId: project.id, title: `Dark mode variant ${index}` });
  const projectPage = await call<{ id: string }>("create_wiki_page", { workspaceId, projectId: project.id, title: "Dark mode handbook", access: "public", content: { type: "doc", content: [{ type: "paragraph" }] } });
  const wikiPage = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Dark mode notes", access: "public", content: { type: "doc", content: [{ type: "paragraph" }] } });
  const source = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Picker source", content: { type: "doc", content: [{ type: "paragraph" }] } });

  // Wiki editor: "[[" opens the picker; narrowing by key and by title; groups; keyboard and mouse picks; empty and failed states.
  await page.goto(`${web}/${slug}/wiki/${source.id}`);
  const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await wikiEditor.click();
  await page.keyboard.type("[[");
  const list = picker(page);
  await list.waitFor();
  check(await list.evaluate((element) => element.classList.contains("suggest-menu")), "the picker must use the shared suggest-menu look");
  check(await list.evaluate((element) => getComputedStyle(element).boxShadow !== "none"), "the picker needs the theme shadow");
  // The search waits out its debounce first, so the loading row comes before the hint.
  await list.locator(".suggest-notice").filter({ hasText: translate("reference.hint") }).waitFor();

  await page.keyboard.type("dark");
  await list.getByRole("option").first().waitFor();
  const headings = await list.locator(".suggest-group").allTextContents();
  check(JSON.stringify(headings) === JSON.stringify([translate("reference.groupWorkItems"), translate("reference.groupProjectPages"), translate("reference.groupWikiPages")]), `rows must group as Work items, Project pages, Wiki pages; got ${JSON.stringify(headings)}`);
  check(await list.getByRole("option").count() === 8 + 1 + 1, "each kind shows at most 8 Work items (search limit) and one page of each Project and Wiki kind");
  check(await list.getByRole("option").filter({ hasText: "MOB-1" }).count() === 1, "a Work item row shows its key");
  check(await list.getByRole("option").filter({ hasText: translate("palette.inProject") + " MOB" }).count() === 1, "a Project Page row shows its project");
  check(await list.locator("svg").count() >= 10, "each row carries a kind icon");

  // ArrowDown past the visible rows keeps the highlight inside the popup, and wraps.
  const rowCount = await list.getByRole("option").count();
  for (let step = 0; step < rowCount + 2; step += 1) {
    await page.keyboard.press("ArrowDown");
    check(await selectedInView(list), `ArrowDown step ${step} left the highlighted row outside the popup`);
  }

  // Dark theme: the popup shadow and the highlight keep their theme tokens.
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  check(await list.evaluate((element) => getComputedStyle(element).boxShadow !== "none"), "dark theme: the picker lost its shadow");
  check(await list.locator('[aria-selected="true"]').evaluate((element) => getComputedStyle(element).backgroundColor) !== "rgba(0, 0, 0, 0)", "dark theme: the highlighted row lost its background");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  // Narrowing by key: "MOB-1" finds the first item; Enter inserts the link with its key and title.
  for (let erase = 0; erase < "dark".length; erase += 1) await page.keyboard.press("Backspace");
  await page.keyboard.type("MOB-1");
  await list.getByRole("option").filter({ hasText: "Dark mode toggle" }).first().waitFor();
  await page.keyboard.press("Enter");
  await list.waitFor({ state: "detached" });
  // The editor renders an internal link with an empty href (its scheme is not a web scheme); the stored mark keeps the stable id.
  const link = (editor: Locator, label: string) => editor.locator("a", { hasText: label });
  check(await link(wikiEditor, "MOB-1 Dark mode toggle").count() === 1, `Enter did not insert the Work item link as "MOB-1 Dark mode toggle": ${(await wikiEditor.innerHTML()).slice(0, 600)}`);

  // Mouse pick of a Project Page, narrowed by title.
  await page.keyboard.type(" [[Handbook");
  await list.waitFor();
  await list.getByRole("option", { name: "Dark mode handbook", exact: false }).click();
  await list.waitFor({ state: "detached" });
  check(await link(wikiEditor, "Dark mode handbook").count() === 1, "a mouse pick did not insert the Project Page link");

  // Escape closes and keeps the typed text; an empty search shows the empty row.
  await page.keyboard.type(" [[zzz-no-such-thing");
  await list.waitFor();
  await list.locator(".suggest-notice").filter({ hasText: translate("reference.empty") }).waitFor();
  const emptyBeforeTab = await wikiEditor.innerText();
  const emptyTabPrevented = await wikiEditor.evaluate((element) => {
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  check(!emptyTabPrevented && await wikiEditor.innerText() === emptyBeforeTab, "Tab in a no-result menu must remain unhandled and keep the typed query");
  const linksBeforeEmptyTab = await wikiEditor.locator("a").count();
  await page.keyboard.press("Tab");
  check(await wikiEditor.locator("a").count() === linksBeforeEmptyTab && await wikiEditor.evaluate((element) => document.activeElement !== element), "native Tab from a no-result menu must leave the editor without inserting a reference");
  await wikiEditor.focus();
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  check((await wikiEditor.innerText()).includes("[[zzz-no-such-thing"), "Escape must keep the typed [[ and text");
  await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");

  // Loading state and a failed search (both answered by the route, not the server). After an Escape the picker stays dismissed until a space is typed, so each new "[[" follows one.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/actions/search_work_items", async (route) => { await held; await route.continue(); });
  await page.keyboard.type(" [[dark");
  await list.waitFor();
  await list.locator(".suggest-notice").filter({ hasText: translate("reference.loading") }).waitFor();
  const loadingTabPrevented = await wikiEditor.evaluate((element) => {
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, isComposing: true, keyCode: 229 });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  check(!loadingTabPrevented && await list.locator(".suggest-notice").filter({ hasText: translate("reference.loading") }).count() === 1, "synthetic IME Tab during loading must not accept or consume the key");
  release();
  await page.unroute("**/actions/search_work_items");
  await page.route("**/actions/search_work_items", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  await page.keyboard.type(" [[dark mode");
  await list.waitFor();
  await list.locator(".suggest-notice").filter({ hasText: translate("reference.failed") }).waitFor();
  check(await list.getByRole("option").count() === 0, "a failed search must not show a partial list as complete");
  await page.unroute("**/actions/search_work_items");
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");

  // With no suggestion open, Tab moves through table cells and Shift-Tab returns to the prior cell.
  await wikiEditor.click(); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.table"), exact: true }).click();
  const tabTable = wikiEditor.locator("table").last();
  await tabTable.locator("td, th").nth(0).locator("p").click();
  await page.keyboard.type("Table first");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Table second");
  await page.keyboard.press("Shift+Tab");
  check(await tabTable.locator("td, th").nth(0).innerText() === "Table first" && await tabTable.locator("td, th").nth(1).innerText() === "Table second", "table Tab and Shift-Tab must navigate cells without a suggestion menu");
  await wikiEditor.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");

  // With no suggestion open, Tab nests a list item and Shift-Tab lifts it back out.
  await wikiEditor.click(); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.tool.bulletList"), exact: true }).click();
  await page.keyboard.type("List parent"); await page.keyboard.press("Enter"); await page.keyboard.type("List child");
  await page.keyboard.press("Tab");
  await wikiEditor.locator("ul ul li").filter({ hasText: "List child" }).waitFor();
  await page.keyboard.press("Shift+Tab");
  check(await wikiEditor.locator("ul ul").count() === 0, "Shift-Tab must return a nested list item to the top level");
  await wikiEditor.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");

  // Enter picks the highlighted row by keyboard: the second row of a fresh search.
  await page.keyboard.type(" [[dark mode variant");
  await list.waitFor();
  await page.keyboard.press("ArrowDown");
  const highlighted = list.locator('[aria-selected="true"]');
  const expectedLabel = `${await highlighted.locator(".suggest-option-note").textContent()} ${await highlighted.locator(".suggest-option-name").textContent()}`;
  await page.keyboard.press("Enter");
  await list.waitFor({ state: "detached" });
  check(await link(wikiEditor, expectedLabel).count() === 1, `keyboard Enter did not insert the highlighted row as "${expectedLabel}"`);

  // Tab accepts the selected reference while Shift-Tab retains normal editor navigation.
  await page.keyboard.type(" [[MOB-1");
  await list.getByRole("option", { name: /Dark mode toggle/ }).first().waitFor();
  await page.keyboard.press("Tab");
  await list.waitFor({ state: "detached" });
  const tabLinkCount = await link(wikiEditor, "MOB-1 Dark mode toggle").count();
  check(tabLinkCount === 1, `Tab did not insert the selected Work item reference; found ${tabLinkCount}: ${await wikiEditor.innerText()}`);

  // "@" still opens the mention list only.
  await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  await page.waitForTimeout(400);
  check(await picker(page).count() === 0, "@ must not open the reference picker");
  check((await wikiEditor.innerText()).includes("@"), "@ must stay typed as text when no mention is listed");
  await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");

  // Saved Written form: the link is `[[label|kind:id]]`, and the outlinks follow it.
  await page.keyboard.type("Read [[MOB-1");
  await picker(page).getByRole("option", { name: "Dark mode toggle", exact: false }).first().waitFor();
  await page.keyboard.press("Enter");
  await picker(page).waitFor({ state: "detached" });
  const readWiki = async () => (await call<{ contentMarkdown?: string }>("get_wiki_page", { pageId: source.id })).contentMarkdown ?? "";
  await waitForSaved(readWiki, `[[MOB-1 Dark mode toggle|work-item:${target.id}]]`);
  const outlinks = await call<Array<{ id: string; kind: string }>>("list_outlinks", { kind: "wiki", id: source.id });
  check(outlinks.some((row) => row.id === target.id && row.kind === "work-item"), "the source must list the Work item under Links");
  const backlinks = await call<Array<{ id: string }>>("list_backlinks", { kind: "work-item", id: target.id });
  check(backlinks.some((row) => row.id === source.id), "the Work item must list the source as a Backlink");

  // Reload: the link comes back as the same internal link, and the Links tab lists the Work item.
  await page.goto(`${web}/${slug}/wiki/${source.id}`);
  await page.getByTestId("wiki-editor").locator("a", { hasText: "MOB-1 Dark mode toggle" }).waitFor();
  const toggle = page.getByTestId("wiki-details-toggle");
  await toggle.waitFor();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const panel = page.getByRole("complementary", { name: translate("wiki.details"), exact: true });
  await panel.getByRole("tab", { name: translate("outlinks.title"), exact: true }).click();
  await page.getByRole("region", { name: translate("outlinks.title"), exact: true }).getByText("Dark mode toggle", { exact: false }).waitFor();
  console.log("case passed: wiki editor picker, narrowing, groups, keyboard, mouse, empty, loading, failed, @, save and Links");

  // Comment editor on the Work item: the same picker opens and inserts a link.
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const comment = page.getByTestId("comment-editor").locator(".ProseMirror");
  await comment.click();
  await page.keyboard.type("See [[Dark mode handbook");
  await picker(page).waitFor();
  await picker(page).getByRole("option", { name: "Dark mode handbook", exact: false }).click();
  check(await link(comment, "Dark mode handbook").count() === 1, "the comment picker did not insert the page link");
  console.log("case passed: comment editor picker");

  // Work item description editor opens the same picker.
  const description = page.getByTestId("description-editor").locator(".ProseMirror");
  await description.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" [[Dark mode notes");
  await picker(page).getByRole("option", { name: "Dark mode notes", exact: false }).waitFor();
  await page.keyboard.press("Enter");
  await picker(page).waitFor({ state: "detached" });
  check(await link(description, "Dark mode notes").count() === 1, `the description picker did not insert the wiki page link: ${(await description.innerHTML()).slice(0, 500)}`);
  console.log("case passed: description editor picker");

  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  servers.forEach((server) => server.kill());
}
process.exit(failed ? 1 : 0);
