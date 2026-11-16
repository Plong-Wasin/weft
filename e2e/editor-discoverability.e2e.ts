// Browser cases for ticket 13: a first-time user finds Add image, Table and Link in the comment, description and Wiki editors without being told.
import { chromium, type Browser } from "playwright";
import { translate } from "../packages/shared/src";
import { withShortcut } from "../apps/web/src/shortcuts";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31163);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52163);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31183);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const liveHttp = `http://localhost:${livePort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];
let browser: Browser | null = null;

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(liveHttp)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Discovery Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Discovery team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Discovery");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("DIS");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /DIS · Discovery/ }).waitFor();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId, archived: false });
  const item = await call<{ displayId: string }>("create_work_item", { projectId: project!.id, title: "Discoverable item" });
  await call("create_wiki_page", { workspaceId, title: "Discoverable page", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Wiki anchor" }] }, { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Open task" }] }] }] }] } });
  const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId });
  const wiki = pages.find((row) => row.title === "Discoverable page")!;

  // Comment composer: Table is a labelled toolbar button; clicking it inserts a table.
  await page.goto(`${web}/${slug}/browse/${item.displayId}`);
  const comment = page.getByTestId("comment-editor").last();
  const commentToolbar = page.getByTestId("comment-toolbar");
  const tableButton = commentToolbar.getByRole("button", { name: translate("wiki.insert.table"), exact: true });
  check(await tableButton.getAttribute("title") === translate("wiki.insert.table"), "comment Table button has no tooltip");
  // The footer sits beside the Comment submit button, outside the editor frame.
  const commentFooter = page.getByRole("button", { name: translate("comments.add"), exact: true }).last().locator("xpath=..");
  check(await commentFooter.getByRole("button", { name: translate("wiki.insert.image"), exact: true }).count() === 1, "comment Add image button is not in the composer footer");
  await comment.locator(".ProseMirror").click();
  await tableButton.click();
  check(await comment.locator(".ProseMirror table").count() === 1, "comment Table button did not insert a table");
  console.log("PASS comment toolbar inserts a labelled Table");

  // Description: Table and Link sit in the labelled toolbar under the editor, next to Add image.
  const description = page.getByTestId("description-editor");
  const descriptionToolbar = description.getByRole("toolbar", { name: translate("wiki.toolbar") });
  for (const key of ["wiki.insert.image", "wiki.insert.table", "wiki.tool.link"] as const) {
    check(await descriptionToolbar.getByRole("button", { name: translate(key), exact: true }).count() === 1, `description toolbar has no ${key} button`);
  }
  await description.locator(".ProseMirror").click();
  await descriptionToolbar.getByRole("button", { name: translate("wiki.insert.table"), exact: true }).click();
  check(await description.locator(".ProseMirror table").count() === 1, "description Table button did not insert a table");
  console.log("PASS description toolbar has labelled Add image, Table and Link and Table inserts a table");

  // Table controls are grouped under plain headings, and each action explains itself on hover.
  for (const group of ["table.group.rows", "table.group.columns", "table.group.table", "table.cellColor"] as const) {
    check(await page.getByRole("group", { name: translate(group), exact: true }).count() === 1, `table controls are missing the ${group} group`);
  }
  check(await page.getByRole("button", { name: translate("table.clearRow"), exact: true }).getAttribute("title") === translate("table.clearRow.help"), "Clear row has no tooltip explaining it");
  console.log("PASS table controls are grouped under Rows, Columns, Whole table and Cell background colour, with tooltips");

  // Wiki page: the fixed toolbar offers Table and Link, both labelled.
  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await wikiEditor.waitFor();
  const wikiToolbar = page.getByRole("toolbar", { name: translate("wiki.toolbar") });
  for (const key of ["wiki.insert.table", "wiki.tool.link"] as const) {
    const button = wikiToolbar.getByRole("button", { name: translate(key), exact: true });
    check((await button.getAttribute("title"))?.startsWith(translate(key)) === true, `Wiki ${key} button has no tooltip`);
  }
  // A task item shows its checkbox beside its text, not above it.
  const taskItem = wikiEditor.locator('li[data-checked]').first();
  check(await taskItem.evaluate((node) => getComputedStyle(node).display) === "flex", "Wiki task item stacks its checkbox above its text");
  console.log("PASS task item keeps its checkbox beside its text");
  await wikiEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await wikiToolbar.getByRole("button", { name: translate("wiki.insert.table"), exact: true }).click();
  check(await wikiEditor.locator("table").count() === 1, "Wiki Table button did not insert a table");
  console.log("PASS Wiki toolbar has labelled Table and Link and Table inserts a table");
  // Pages list: the row menu is labelled and its items name what they do.
  await page.goto(`${web}/${slug}/wiki`);
  const rowMenu = page.getByRole("button", { name: `${translate("wiki.collection.actions")}: Wiki`, exact: true });
  check(await rowMenu.getAttribute("title") === `${translate("wiki.collection.actions")}: Wiki`, "Pages list row menu has no tooltip");
  await rowMenu.click();
  await page.getByRole("menuitem", { name: translate("wiki.collection.rename"), exact: true }).waitFor();
  await page.keyboard.press("Escape");
  console.log("PASS Pages list row menu has a labelled trigger and named items");

  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  await wikiEditor.waitFor();
  // Link opens a labelled in-app form (not the browser prompt); Save applies it and the link is clickable in the Wiki page.
  await wikiEditor.getByText("Wiki anchor", { exact: true }).click({ clickCount: 3 });
  await wikiToolbar.getByRole("button", { name: translate("wiki.tool.link"), exact: true }).click();
  const linkDialog = page.getByRole("dialog", { name: translate("wiki.tool.link"), exact: true });
  await linkDialog.getByLabel(translate("wiki.linkUrl"), { exact: true }).fill("https://link-check.example");
  await linkDialog.getByRole("button", { name: translate("wiki.linkSave"), exact: true }).click();
  check(await wikiEditor.locator('a[href="https://link-check.example"]').count() === 1, "Link form did not add the link to the selection");
  console.log("PASS Link opens a labelled form and Save applies the link");

  // Ctrl/Cmd+K opens the Link form from the editor; pasting a URL over selected text makes it a link.
  await wikiEditor.getByText("Wiki anchor", { exact: true }).click({ clickCount: 3 });
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: translate("wiki.tool.link"), exact: true }).waitFor();
  await page.getByRole("dialog", { name: translate("wiki.tool.link"), exact: true }).getByText(translate("wiki.linkHelp"), { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: translate("wiki.tool.link"), exact: true }).waitFor({ state: "detached" });
  console.log("PASS Ctrl/Cmd+K opens the Link form and Escape closes it");

  await wikiEditor.getByText("Wiki anchor", { exact: true }).click({ clickCount: 3 });
  await wikiEditor.evaluate((root) => {
    const data = new DataTransfer();
    data.setData("text/plain", "https://paste-link.example");
    root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  check(await wikiEditor.locator('a[href="https://paste-link.example"]').getByText("Wiki anchor", { exact: true }).count() === 1, "pasting a URL over selected text did not link the selection");
  console.log("PASS pasting a URL over selected text links the selection");

  // Markdown shortcuts: "- " starts a bullet list, "1. " a numbered list, "[] " a task item.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- markdown bullet");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("1. markdown number");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[] markdown task");
  check(await wikiEditor.locator("ul li", { hasText: "markdown bullet" }).count() === 1, "- did not start a bullet list");
  check(await wikiEditor.locator("ol li", { hasText: "markdown number" }).count() === 1, "1. did not start a numbered list");
  check(await wikiEditor.locator('li[data-checked]', { hasText: "markdown task" }).count() === 1, "[] did not start a task item");
  console.log("PASS markdown shortcuts '- ', '1. ' and '[] ' start lists and task items");

  // Shortcut hints: the toolbar tooltips name the keyboard shortcut.
  const boldTip = await wikiToolbar.getByRole("button", { name: translate("wiki.tool.bold"), exact: true }).getAttribute("title");
  check(boldTip === withShortcut(translate("wiki.tool.bold"), "B"), `Bold tooltip has no shortcut hint: ${boldTip}`);
  console.log("PASS toolbar tooltips name the keyboard shortcut");

  // Bulleted and numbered list buttons sit in the description toolbar and make the paragraph a list.
  await page.goto(`${web}/${slug}/browse/${item.displayId}`);
  await description.locator(".ProseMirror").click();
  await descriptionToolbar.getByRole("button", { name: translate("wiki.tool.bulletList"), exact: true }).click();
  check(await description.locator(".ProseMirror ul").count() === 1, "description Bulleted list button did not make a bullet list");
  await descriptionToolbar.getByRole("button", { name: translate("wiki.tool.orderedList"), exact: true }).click();
  check(await description.locator(".ProseMirror ol").count() === 1, "description Numbered list button did not make a numbered list");
  console.log("PASS description toolbar Bulleted list and Numbered list buttons create lists");

  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  // Lock explains itself in plain words; clicking it swaps the help to the unlock action.
  const lockButton = page.getByTestId("wiki-page-lock");
  check(await lockButton.getAttribute("title") === translate("wiki.lock.help"), "Lock button has no tooltip explaining the lock");
  await page.getByText(translate("wiki.lock.help"), { exact: true }).waitFor();
  await lockButton.click();
  await page.getByText(translate("wiki.unlock.help"), { exact: true }).waitFor();
  check(await lockButton.getAttribute("title") === translate("wiki.unlock.help"), "Unlock button has no tooltip");
  await lockButton.click();
  console.log("PASS lock explains itself with helper text and tooltip, and the tooltip changes after locking");

  // Location names where the page lives; the default is the whole workspace Wiki.
  const location = page.getByRole("group", { name: translate("wiki.location"), exact: true });
  await location.getByText(translate("wiki.location.help"), { exact: true }).waitFor();
  check(await location.getByRole("combobox").evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.textContent) === translate("wiki.location.default"), "Location does not show the whole-workspace Wiki by default");
  console.log("PASS Location group names its scope with helper text");

} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
