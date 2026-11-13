// Browser end-to-end check for shared ProseMirror styling and slash commands.
import { chromium, type Browser } from "playwright";
import { mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31158);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52158);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31178);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const liveHttp = `http://localhost:${livePort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];
let slug = "";
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
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: web });
  const page = await context.newPage();
  slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const exitList = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inList = await page.evaluate(() => { const node = window.getSelection()?.anchorNode; return (node instanceof Element ? node : node?.parentElement)?.closest("li") != null; });
      if (!inList) return;
      await page.keyboard.press("Enter");
    }
    const stillInList = await page.evaluate(() => { const node = window.getSelection()?.anchorNode; return (node instanceof Element ? node : node?.parentElement)?.closest("li") != null; });
    check(!stillInList, "could not leave the active list item");
  };
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Editor Tester");
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

  const me = await (await context.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const seededLinkDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Read only link", marks: [{ type: "link", attrs: { href: "https://example.edu" } }] }] }] };
  const descriptionFixture = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Description colour", marks: [{ type: "textStyle", attrs: { color: "#3b82f6" } }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Description task" }] }] }] },
    { type: "callout", attrs: { color: "#f97316", icon: "🚀" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Description callout" }] }] },
    { type: "paragraph", content: [{ type: "mention", attrs: { id: "person-e2e", label: "Mention proof" } }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Description table" }] }] }] }] },
  ] };
  const workItem = await call<{ id: string }>("create_work_item", { projectId: project!.id, title: "Editor parity", description: descriptionFixture });
  await call("update_work_item", { workItemId: workItem.id, description: descriptionFixture });
  const seededTable = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Read only table" }] }] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }] }] }] }] };
  const richComment = { type: "doc", content: [
    ...(seededLinkDoc.content as object[]),
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Comment heading" }] },
    ...seededTable.content,
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Read only list" }] }] }] },
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Read only quote" }] }] },
    { type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: "const readOnly = true" }] },
  ] };
  await call("create_comment", { workItemId: workItem.id, body: richComment });
  await call("create_comment", { workItemId: workItem.id, bodyMarkdown: "| Agent | Result |\n| --- | --- |\n| Markdown | rendered |" });
  await call("create_wiki_page", { workspaceId: me.workspaces[0]!.id, title: "Editor page", content: { type: "doc", content: [...(seededLinkDoc.content as object[]), ...seededTable.content] } });
  const wikiPages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId: me.workspaces[0]!.id });
  const wiki = wikiPages.find((candidate) => candidate.title === "Editor page")!;

  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const description = page.getByTestId("description-editor").locator(".ProseMirror");
  const comment = page.getByTestId("comment-editor").locator(".ProseMirror");
  await description.waitFor();
  await comment.waitFor();
  const markdownComment = page.locator("li[id^='comment-']").filter({ hasText: "Markdown" }).last();
  await markdownComment.locator(".comment-body table").waitFor();
  check(await markdownComment.locator(".comment-body th").count() === 2 && await markdownComment.locator(".comment-body td").count() === 2, "Markdown API comment did not render as a two-column table in the browser");
  console.log("case passed: API Markdown comment table renders in the browser");
  const descriptionText = await description.innerText();
  check(await description.locator("table").count() === 1 && await description.locator("li").count() === 1 && descriptionText.includes("Description table") && descriptionText.includes("Description task"), `Description did not load table and task list nodes: ${descriptionText}; tables=${await description.locator("table").count()}, lis=${await description.locator("li").count()}`);
  check(await description.locator("aside[data-callout]").count() === 1 && descriptionText.includes("@Mention proof") && await description.locator("span[style*='color']").count() === 1 && descriptionText.includes("Description callout"), `Description did not load colour, callout and mention nodes: ${await description.locator("aside[data-callout]").count()} ${await description.locator(".mention").count()} ${await description.locator("span[style*='color']").count()} ${await description.innerHTML()}`);
  console.log("case passed: Description renders table, task list, colour, callout and mention");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  const reloadedDescription = page.getByTestId("description-editor").locator(".ProseMirror");
  await reloadedDescription.getByText("Description task", { exact: true }).waitFor({ timeout: 15000 });
  check(await reloadedDescription.locator("table").count() === 1 && await reloadedDescription.locator("li").count() === 1 && await reloadedDescription.locator("aside[data-callout]").count() === 1 && await reloadedDescription.locator("span[style*='color']").count() === 1 && (await reloadedDescription.innerText()).includes("Mention proof"), "Description rich nodes did not save and reload");
  console.log("case passed: Description table, task list, colour, callout and mention save and reload");
  await comment.waitFor();
  const calloutOptions = page.getByRole("button", { name: translate("callout.options"), exact: true });
  const codeLanguage = page.getByLabel(translate("editor.codeLanguage"), { exact: true });
  check(await calloutOptions.count() === 0 && await codeLanguage.count() === 0, "fresh Description editor shows node-specific controls");
  check(await page.getByTestId("comment-editor").getByRole("button", { name: translate("callout.options"), exact: true }).count() === 0 && await page.getByTestId("comment-editor").getByLabel(translate("editor.codeLanguage"), { exact: true }).count() === 0, "fresh Comment editor shows node-specific controls");
  check(await page.getByTestId("comment-toolbar").locator("button").evaluateAll((buttons) => buttons.every((button) => button.classList.contains("editor-tool")))
    && await page.getByRole("button", { name: translate("wiki.insert.image"), exact: true }).last().evaluate((button) => button.classList.contains("editor-tool"))
    && await page.getByRole("button", { name: translate("comments.add"), exact: true }).evaluate((button) => button.classList.contains("primary")), "Comment toolbar, image, or Comment button is missing its design-system style");
  const commentToolbar = page.getByTestId("comment-toolbar");
  for (const key of ["wiki.tool.bold", "wiki.tool.italic", "wiki.tool.strike", "wiki.tool.bulletList", "wiki.tool.orderedList", "wiki.tool.quote", "wiki.tool.codeBlock", "wiki.tool.link"]) {
    const label = translate(key as never), button = commentToolbar.getByRole("button", { name: label, exact: true });
    check(await button.getAttribute("aria-label") === label && await button.getAttribute("title") === label, `Comment ${label} control needs a visible tooltip and accessible name`);
  }
  check(await commentToolbar.getByRole("button", { name: translate("wiki.tool.link"), exact: true }).locator("svg").count() === 1, "Comment link control does not use a link icon");
  console.log("case passed: Comment toolbar, image and Comment actions use design-system button variants");

  // Comment slash menu and table actions follow the description editor, while mentions and AI assist remain available.
  const commentEditorRoot = page.getByTestId("comment-editor");
  await comment.click(); await page.keyboard.type("@Editor");
  const mentionMenu = page.getByRole("listbox").filter({ has: page.getByRole("option", { name: "Editor Tester", exact: true }) });
  await mentionMenu.getByRole("option", { name: "Editor Tester", exact: true }).click();
  check(await comment.locator(".mention").count() === 1, "Comment mention selection no longer inserts a mention");
  await comment.click(); await page.keyboard.press("End"); await page.keyboard.press("Space"); await page.keyboard.type("Assist retained"); await page.keyboard.press("Shift+Home");
  const commentAssistToolbar = commentEditorRoot.getByRole("toolbar", { name: translate("assist.menu") });
  await commentAssistToolbar.waitFor();
  check(await commentAssistToolbar.getByRole("button", { name: translate("assist.task.rephrase"), exact: true }).count() === 1 || await commentAssistToolbar.getByRole("status").count() === 1, "Comment AI assist options or configured-state message are missing after selecting text");
  await comment.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  const commentSlashMenu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await commentSlashMenu.waitFor();
  await commentSlashMenu.getByRole("option", { name: translate("wiki.insert.table"), exact: true }).waitFor();
  await page.keyboard.type("table");
  await commentSlashMenu.getByRole("option", { name: translate("wiki.insert.table"), exact: true }).waitFor();
  check(await commentSlashMenu.getByRole("option").count() === 1, "Comment slash menu did not filter to the table command");
  await page.keyboard.press("Enter");
  await commentSlashMenu.waitFor({ state: "detached" });
  check(await comment.locator("table").count() === 1, "keyboard selection from the Comment slash menu did not insert a table");
  const insertedCommentTable = comment.locator("table").last();
  check(await insertedCommentTable.locator("th, td").first().evaluate((cell) => getComputedStyle(cell).borderTopWidth) !== "0px", "inserted Comment table has no visible cell borders");
  await insertedCommentTable.locator("td, th").first().click();
  const commentControls = commentEditorRoot.getByLabel(translate("table.controls"), { exact: true });
  const commentTableMenu = commentEditorRoot.locator("details");
  check(await commentTableMenu.locator("summary").innerText() === translate("table.controls") && !await commentTableMenu.evaluate((details) => (details as HTMLDetailsElement).open), "Comment table controls should be grouped under a collapsed, labelled Table controls menu");
  await commentTableMenu.locator("summary").click();
  await commentControls.waitFor();
  check(await commentControls.getByRole("button", { name: translate("table.resetCellColor"), exact: true }).innerText() === translate("table.resetCellColor"), "cell color reset action has no visible label");
  await commentControls.getByRole("button", { name: translate("table.insertRowBelow"), exact: true }).click();
  await commentControls.getByRole("button", { name: translate("table.insertColumnRight"), exact: true }).click();
  check(await insertedCommentTable.locator("tr").count() === 4 && await insertedCommentTable.locator("tr").first().locator("th, td").count() === 4, "Comment table controls did not insert a row and column");
  const firstCommentCell = insertedCommentTable.locator("th, td").first();
  await firstCommentCell.click(); await page.keyboard.type("Inserted Comment table");
  await page.keyboard.press("Control+Home");
  await commentControls.waitFor({ state: "detached" });
  await page.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  const savedTableComment = page.locator("li[id^='comment-']").filter({ hasText: "Inserted Comment table" }).last();
  await savedTableComment.waitFor();
  check(await savedTableComment.locator("table").count() === 1, "submitting a table Comment did not preserve its table");
  await savedTableComment.getByRole("button", { name: translate("comments.edit"), exact: true }).click();
  const editComment = savedTableComment.getByTestId("comment-editor").locator(".ProseMirror");
  await editComment.locator("table").waitFor();
  check(await editComment.locator("table").count() === 1, "editing an existing Comment lost its table");
  await savedTableComment.getByRole("button", { name: translate("comments.save"), exact: true }).click();
  await savedTableComment.locator(".comment-body table").waitFor();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  const reloadedTableComment = page.locator("li[id^='comment-']").filter({ hasText: "Inserted Comment table" }).last();
  await reloadedTableComment.locator(".comment-body table").waitFor();
  console.log("case passed: Comment slash menu, keyboard table insert, table controls, submit, edit and reload");

  // Mouse selection in the Comment slash menu remains available too.
  await comment.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  const mouseCommentMenu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await mouseCommentMenu.getByRole("option", { name: translate("wiki.insert.table"), exact: true }).click();
  check(await comment.locator("table").count() === 1, "mouse selection from the Comment slash menu did not insert a table");
  await comment.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  console.log("case passed: Comment slash menu supports mouse selection");
  await description.getByText("Description callout", { exact: true }).click();
  await calloutOptions.waitFor();
  await page.keyboard.press("Shift+Tab");
  check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === translate("callout.options"), "Callout options is not reachable by keyboard or labelled");
  await description.getByText("Description colour", { exact: true }).click();
  await calloutOptions.waitFor({ state: "detached" });
  console.log("case passed: Callout options stay hidden outside an active callout");
  if (Bun.env.E2E_SCREENSHOT_DIR) {
    mkdirSync(Bun.env.E2E_SCREENSHOT_DIR, { recursive: true });
    for (const [theme, width, height] of [["light", 1440, 900], ["dark", 1440, 900], ["light", 390, 844], ["dark", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: `${Bun.env.E2E_SCREENSHOT_DIR}/03-editor-${theme}-${width}.png`, fullPage: true });
    }
    console.log("case passed: editor chrome screenshots captured in light and dark themes at desktop and phone widths");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  }
  await description.getByText("Description colour").click(); await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
  await page.getByTestId("wiki-bubble-menu").waitFor();
  await description.locator("p").first().hover(); await page.getByLabel(translate("wiki.blockHandle")).waitFor();
  console.log("case passed: editable Description shows the formatting bubble and drag handle");
  check(await page.getByTestId("comment-toolbar").count() === 1, "Comment toolbar is missing");
  for (const key of ["wiki.tool.bold", "wiki.tool.italic", "wiki.tool.strike", "wiki.tool.bulletList", "wiki.tool.orderedList", "wiki.tool.quote", "wiki.tool.codeBlock", "wiki.tool.link"]) await page.getByTestId("comment-toolbar").getByRole("button", { name: translate(key), exact: true }).waitFor();
  check(await page.getByTestId("comment-editor").getByRole("listbox").count() === 0 && await page.getByTestId("comment-editor").getByTestId("wiki-bubble-menu").count() === 0 && await page.getByTestId("comment-editor").getByLabel(translate("wiki.blockHandle")).count() === 0, "Comment has Wiki-only editor controls");
  console.log("case passed: Comment toolbar exposes basic format, list, quote, code, link and image controls without Wiki menus");

  const exercisePlaceholder = async (name: string, editor: typeof description) => {
    const emptyParagraph = editor.locator(":scope > p.is-empty");
    await emptyParagraph.waitFor({ state: "attached" });
    check(await emptyParagraph.getAttribute("data-placeholder") === translate("editor.placeholder"), `${name} placeholder translation is missing`);
    await emptyParagraph.click();
    await page.keyboard.type("placeholder check");
    await emptyParagraph.waitFor({ state: "detached" });
    await editor.press("Control+A");
    await editor.press("Backspace");
    await emptyParagraph.waitFor({ state: "attached" });
    check(await emptyParagraph.getAttribute("data-placeholder") === translate("editor.placeholder"), `${name} placeholder did not return after clearing`);
  };
  await exercisePlaceholder("description", description);
  await exercisePlaceholder("Comment", comment);

  for (const [name, editor] of [["description", description], ["comment", comment]] as const) {
    await editor.click();
    await page.keyboard.type("# Heading ");
    await editor.locator("h1").waitFor();
    const headingSize = await editor.locator("h1").evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    check(headingSize > 15, `${name} heading is not visibly larger than body text (${headingSize}px)`);
    await page.keyboard.press("Enter");
    await page.keyboard.type("- bullet ");
    await editor.locator("ul li").waitFor();
    check(await editor.locator("ul").evaluate((element) => getComputedStyle(element).listStyleType) === "disc", `${name} bullet list has no visible marker`);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("> quoted ");
    await editor.locator("blockquote").waitFor();
    check(await editor.locator("blockquote").evaluate((element) => parseFloat(getComputedStyle(element).borderLeftWidth)) > 0, `${name} quote has no visible rule`);
  }
  await comment.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.getByTestId("comment-toolbar").getByRole("button", { name: translate("wiki.tool.codeBlock"), exact: true }).click(); await page.keyboard.type("Comment code proof");
  check((await comment.locator("pre code").allInnerTexts()).some((value) => value.includes("Comment code proof")), "Comment code button did not format a code block");
  const commentImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aKQAAAAASUVORK5CYII=", "base64");
  const commentImagePicker = page.waitForEvent("filechooser");
  await page.getByTestId("comment-image-input").locator("xpath=preceding-sibling::button[1]").click();
  await (await commentImagePicker).setFiles({ name: "comment.png", mimeType: "image/png", buffer: commentImage });
  await page.getByTestId("comment-editor").locator("img[data-asset-id]").waitFor();
  console.log("case passed: Comment toolbar formats code and its image control uploads an inline image");

  for (const [name, editor] of [["description", description], ["Comment", comment]] as const) {
    await editor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter");
    await page.keyboard.type("undo-proof");
    check((await editor.innerText()).includes("undo-proof"), `${name} did not take the typed text`);
    await page.keyboard.press("Control+z");
    check(!(await editor.innerText()).includes("undo-proof"), `Ctrl+Z did not undo typing in the ${name} editor`);
    await page.keyboard.press("Control+y");
    check((await editor.innerText()).includes("undo-proof"), `Ctrl+Y did not redo typing in the ${name} editor`);
    await page.keyboard.press("Control+z");
  }
  console.log("case passed: Ctrl+Z undoes and Ctrl+Y redoes typing in the description and Comment editors");

  const exerciseSlashMenu = async (editor: typeof description) => {
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const menu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
    await menu.waitFor();
    const menuLabels = ["wiki.tool.text", "wiki.tool.h1", "wiki.tool.h2", "wiki.tool.h3", "wiki.tool.bulletList", "wiki.tool.orderedList", "wiki.tool.quote", "wiki.tool.codeBlock", "wiki.tool.divider", "wiki.insert.table", "wiki.insert.callout", "wiki.insert.emoji", "wiki.insert.todo", "wiki.insert.color"];
    check(await menu.getByRole("option").count() === menuLabels.length, "slash menu is missing a block command");
    for (const label of menuLabels) await menu.getByRole("option", { name: translate(label), exact: true }).waitFor();
    await page.keyboard.type("hea");
    await menu.getByRole("option", { name: translate("wiki.tool.h1"), exact: true }).waitFor();
    check(await menu.getByRole("option").count() === 3, "slash menu did not filter to headings");
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "detached" });
    check(await editor.locator("h1").count() > 0, "slash menu did not insert Heading 1");
    await page.keyboard.type("/");
    await menu.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    check((await editor.innerText()).includes("/"), "Escape should close the slash menu and keep the typed slash");
  };
  await exerciseSlashMenu(description);

  const checkLink = async (root: typeof description, text: string, href: string, open = false) => {
    const link = root.getByRole("link", { name: text, exact: true });
    await link.waitFor();
    check(new URL(await link.getAttribute("href") ?? "", web).href === new URL(href, web).href, `link ${text} has the wrong href`);
    check(await link.getAttribute("target") === "_blank", `link ${text} does not target a new tab`);
    check((await link.getAttribute("rel") ?? "").split(/\s+/).includes("noopener") && (await link.getAttribute("rel") ?? "").split(/\s+/).includes("noreferrer"), `link ${text} is missing noopener noreferrer`);
    const style = await link.evaluate((element) => {
      const reference = document.createElement("span"); reference.style.color = "var(--txt-link-primary)"; document.body.append(reference);
      const expectedColor = getComputedStyle(reference).color; reference.remove();
      return { color: getComputedStyle(element).color, expectedColor, decoration: getComputedStyle(element).textDecorationLine };
    });
    check(style.color === style.expectedColor && style.decoration.includes("underline"), `link ${text} is not visibly styled (${style.color} vs ${style.expectedColor}, ${style.decoration})`);
    if (open) {
      const popup = page.waitForEvent("popup");
      await link.click();
      const opened = await popup;
      await opened.waitForURL(new URL(href, web).href);
      check(opened.url() === new URL(href, web).href, `click on ${text} opened ${opened.url()} instead of ${href}`);
      check(await opened.evaluate(() => window.opener) === null, `click on ${text} opened a tab with an opener`);
      await opened.close();
    }
  };

  await comment.click();
  await page.keyboard.type("[Comment Markdown](https://comment.example)");
  await checkLink(comment, "Comment Markdown", "https://comment.example/");
  await description.click();
  await page.keyboard.press("Control+End");
  await page.evaluate(() => navigator.clipboard.writeText("https://example.com"));
  await page.keyboard.press("Control+V");
  await checkLink(description, "https://example.com", "https://example.com/", true);
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("https://example.org ");
  await checkLink(description, "https://example.org", "https://example.org/");
  await page.keyboard.type("[Markdown](https://example.net)");
  await checkLink(description, "Markdown", "https://example.net/");
  await page.keyboard.press("Enter");
  await page.evaluate(() => navigator.clipboard.writeText("[Pasted Markdown](https://example.dev)"));
  await page.keyboard.press("Control+V");
  await checkLink(description, "Pasted Markdown", "https://example.dev/");
  await page.keyboard.press("Enter");
  await page.keyboard.type("https://example.info");
  await page.keyboard.press("Enter");
  await checkLink(description, "https://example.info", "https://example.info/");
  await page.keyboard.press("Enter");
  await page.keyboard.type("named text");
  await page.keyboard.press("Shift+Home");
  await page.evaluate(() => navigator.clipboard.writeText("https://example.co"));
  await page.keyboard.press("Control+V");
  await checkLink(description, "named text", "https://example.co/");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[unsafe](javascript:alert(1)) ");
  check(await description.locator('a[href^="javascript:"]').count() === 0, "javascript URL became a clickable link");
  const readOnlyComment = page.locator("li[id^='comment-'] .ProseMirror").first();
  await checkLink(readOnlyComment, "Read only link", "https://example.edu/", true);
  check(await readOnlyComment.locator("[aria-label='Table controls']").count() === 0, "read-only Comment shows table controls");
  const readonlyText = await readOnlyComment.innerText();
  check(await readOnlyComment.locator("ul").count() > 0 && await readOnlyComment.locator("blockquote").count() > 0 && await readOnlyComment.locator("pre code").count() === 1 && readonlyText.includes("Read only list") && readonlyText.includes("Read only quote"), "read-only Comment did not render all rich supported nodes");
  const commentTable = readOnlyComment.locator("table");
  const commentTableStyle = await commentTable.locator("th").first().evaluate((el) => getComputedStyle(el).borderTopWidth);
  const commentTableMargin = await commentTable.evaluate((el) => Number.parseFloat(getComputedStyle(el).marginBlockEnd));
  const commentOverflow = await readOnlyComment.evaluate((el) => getComputedStyle(el.closest(".comment-body")!).overflowX);
  const headingSize = await readOnlyComment.locator("h2").evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  const listMarker = await readOnlyComment.locator("ul").evaluate((el) => getComputedStyle(el).listStyleType);
  check(await commentTable.count() === 1 && commentTableStyle !== "0px" && commentTableMargin >= 10 && commentOverflow === "auto" && headingSize > 16 && listMarker === "disc", `read-only Comment table margin, heading, or list styles are missing (count=${await commentTable.count()}, border=${commentTableStyle}, margin=${commentTableMargin}px, overflow=${commentOverflow}, heading=${headingSize}px, list=${listMarker})`);
  if (Bun.env.E2E_SCREENSHOT_PATH) await page.screenshot({ path: Bun.env.E2E_SCREENSHOT_PATH, fullPage: true });
  console.log("case passed: read-only Comment renders and styles every rich supported node, including tables");

  // Work item descriptions gain table insertion and the same contextual actions.
  await description.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const descriptionMenu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await descriptionMenu.getByRole("option", { name: translate("wiki.insert.table"), exact: true }).click();
  const descriptionTable = description.locator("table").last();
  await descriptionTable.waitFor();
  await descriptionTable.locator("td, th").first().click();
  const descriptionControls = page.locator(`[aria-label="${translate("table.controls")}"]`);
  await descriptionControls.getByRole("button", { name: translate("table.insertRowBelow"), exact: true }).click();
  check(await descriptionTable.locator("tr").count() === 4, "description table controls did not insert a row");


  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await wikiEditor.waitFor();
  await wikiEditor.getByText("Read only link").waitFor();
  await page.getByTestId("wiki-bubble-menu").waitFor({ state: "hidden" });
  await exercisePlaceholder("Wiki", wikiEditor);
  await wikiEditor.click(); await page.keyboard.press("Control+End");
  await page.evaluate(() => navigator.clipboard.writeText("[Read only link](https://example.edu)")); await page.keyboard.press("Control+V");
  await checkLink(wikiEditor, "Read only link", "https://example.edu/");
  // The Wiki editor uses the shared SlashMenu with a longer command list (covered by wiki-pages.e2e.ts).
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter");
  await page.keyboard.type("# Heading ");
  await wikiEditor.locator("h1").waitFor();
  check(await wikiEditor.locator("h1").evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) > 15, "Wiki heading styling is missing");
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  const wikiSlashMenu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await wikiSlashMenu.getByRole("option", { name: translate("wiki.insert.color"), exact: true }).click();
  await page.keyboard.type("Slash palette colour");
  check(await wikiEditor.locator('span[style*="color: rgb(59, 130, 246)"]').filter({ hasText: "Slash palette colour" }).count() === 1, "slash colour command did not use the shared palette");
  await wikiEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[Wiki Markdown](https://wiki.example)");
  await checkLink(wikiEditor, "Wiki Markdown", "https://wiki.example/");

  // Emoji slash picker and typed emoji suggestion each insert a chosen emoji.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.emoji"), exact: true }).click();
  const emojiPicker = page.getByRole("dialog", { name: translate("wiki.insert.emoji") }); await emojiPicker.waitFor();
  await emojiPicker.getByRole("button", { name: `${translate("wiki.insert.emoji")} 🚀` }).click();
  check(await wikiEditor.getByText("🚀", { exact: true }).count() > 0, "slash emoji picker did not insert the chosen emoji");
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type(":rocket");
  const emojiSuggestions = page.getByRole("listbox").filter({ has: page.getByRole("option", { name: "🚀" }) });
  await emojiSuggestions.waitFor(); await page.keyboard.press("Enter");
  check(await wikiEditor.getByText("🚀", { exact: true }).count() === 2, "typed emoji suggestion did not insert the matching emoji");
  console.log("case passed: emoji picker and typed emoji suggestion insert selected emoji");

  // Typography input rules preserve an undo step, and list keys nest/lift the active item.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("ratio 1/2 ");
  check(await wikiEditor.getByText("ratio ½", { exact: true }).count() === 1, "typography input rule did not convert 1/2 to ½");
  await page.keyboard.press("Control+z");
  check(await wikiEditor.getByText("ratio 1/2", { exact: true }).count() === 1, "typography conversion could not be undone");
  for (const [input, output] of [["->", "→"], ["...", "…"], ["(c)", "©"], ["(tm)", "™"], ["(r)", "®"]] as const) {
    await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type(`rule ${input} `);
    check(await wikiEditor.getByText(`rule ${output}`, { exact: true }).count() === 1, `typography input rule did not convert ${input}`);
    await page.keyboard.press("Control+z");
    check(await wikiEditor.getByText(`rule ${input}`, { exact: true }).count() === 1, `typography conversion ${input} could not be undone`);
  }
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.tool.bulletList"), exact: true }).click();
  await page.keyboard.type("parent"); await page.keyboard.press("Enter"); await page.keyboard.type("child");
  await page.keyboard.press("Tab");
  const nestedList = wikiEditor.locator("ul ul").last(); await nestedList.waitFor();
  check(await nestedList.getByText("child", { exact: true }).count() === 1, "Tab did not indent the list item");
  await page.keyboard.press("Shift+Tab");
  check(await wikiEditor.locator("ul ul").count() === 0, "Shift-Tab did not outdent the list item");
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  console.log("case passed: typography conversion is undoable and Tab/Shift-Tab indent/outdent lists");

  // Markdown pasted as plain text is parsed into real block nodes.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.evaluate(() => navigator.clipboard.writeText("## Pasted markdown\n\n- first item\n- second item"));
  await page.keyboard.press("Control+V");
  await wikiEditor.locator("h2").filter({ hasText: "Pasted markdown" }).waitFor();
  await wikiEditor.getByText("second item", { exact: true }).waitFor();
  await exitList();
  console.log("case passed: Markdown paste creates formatted heading and list blocks");

  // Code blocks are highlighted and expose a copy control; callout attributes can be selected from the palette.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await exitList(); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.tool.codeBlock"), exact: true }).click();
  const codeBlock = wikiEditor.locator("pre").last(); await codeBlock.waitFor();
  await codeBlock.click({ position: { x: 20, y: 18 } });
  await codeLanguage.waitFor();
  await page.keyboard.press("Shift+Tab");
  check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === translate("editor.codeLanguage"), "Code language control is not reachable by keyboard or labelled");
  await wikiEditor.locator("p").first().click();
  await codeLanguage.waitFor({ state: "detached" });
  console.log("case passed: Code language appears only in an active code block");
  await codeBlock.click({ position: { x: 20, y: 18 } });
  await page.keyboard.type("const answer = 42");
  check((await codeBlock.locator("code").innerText()).includes("const answer = 42"), "typing did not preserve code text in the code block");
  await page.waitForTimeout(300);
  check(await codeBlock.locator("code .hljs-keyword").count() > 0, "code block did not syntax-highlight its JavaScript keyword");
  const copyCode = codeBlock.getByRole("button", { name: translate("editor.copyCode") }); await copyCode.click();
  check(await page.evaluate(() => navigator.clipboard.readText()) === "const answer = 42", "code copy button did not copy the block text");
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.tool.codeBlock"), exact: true }).click();
  const pythonBlock = wikiEditor.locator("pre").last(); await pythonBlock.waitFor();
  await page.getByRole("combobox", { name: translate("editor.codeLanguage") }).selectOption("python");
  await pythonBlock.click({ position: { x: 20, y: 18 } }); await page.keyboard.type("def answer():");
  await pythonBlock.locator("code .hljs-keyword").waitFor();
  console.log("case passed: code block highlights a common language and its copy button copies text");

  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.callout"), exact: true }).click();
  const callout = wikiEditor.locator("aside[data-callout]").last(); await callout.locator("p").click(); await page.keyboard.type("Callout proof");
  await page.getByRole("button", { name: translate("callout.options") }).click();
  await page.getByRole("button", { name: `${translate("callout.color")} #f97316` }).click();
  await page.getByRole("button", { name: `${translate("callout.icon")} 🚀` }).click();
  await page.getByRole("button", { name: translate("callout.done"), exact: true }).click();
  check(await callout.getAttribute("data-color") === "#f97316" && await callout.getAttribute("data-icon") === "🚀", "callout colour and icon controls did not update attributes");
  console.log("case passed: callout colour and icon controls update attributes");

  // Bubble menu formatting is visible on a non-empty Wiki selection and keeps the selection while its controls are used.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("Palette proof"); await page.keyboard.press("Shift+Home");
  const bubble = page.getByTestId("wiki-bubble-menu"); await bubble.waitFor();
  const assistToolbar = page.getByRole("toolbar", { name: translate("assist.menu") }); await assistToolbar.waitFor();
  const boxes = await Promise.all([bubble.boundingBox(), assistToolbar.boundingBox()]);
  check(!!boxes[0] && !!boxes[1] && (boxes[0]!.x + boxes[0]!.width <= boxes[1]!.x || boxes[1]!.x + boxes[1]!.width <= boxes[0]!.x || boxes[0]!.y + boxes[0]!.height <= boxes[1]!.y || boxes[1]!.y + boxes[1]!.height <= boxes[0]!.y), "AI assist menu overlaps the formatting bubble menu");
  await bubble.getByRole("button", { name: translate("wiki.tool.underline") }).click();
  await bubble.getByRole("button", { name: `${translate("wiki.insert.color")} ${translate("wiki.color.blue")}` }).click();
  await bubble.getByRole("button", { name: `${translate("wiki.highlight")} ${translate("wiki.color.yellow")}` }).click();
  const linkDetails = bubble.locator("details"); await linkDetails.locator("summary").click();
  await linkDetails.getByLabel(translate("wiki.linkUrl")).fill("https://palette.example");
  await linkDetails.getByRole("button", { name: translate("wiki.linkSave") }).click();
  await linkDetails.getByLabel(translate("wiki.linkUrl")).fill("https://palette-edit.example");
  await linkDetails.getByRole("button", { name: translate("wiki.linkSave") }).click();
  check(await wikiEditor.locator('a[href="https://palette-edit.example"]').count() === 1, "bubble link edit did not replace the URL");
  await linkDetails.getByRole("button", { name: translate("wiki.linkRemove") }).click();
  check(await wikiEditor.locator('a[href="https://palette-edit.example"]').count() === 0, "bubble link remove left the link in place");
  await linkDetails.getByLabel(translate("wiki.linkUrl")).fill("https://palette.example");
  await linkDetails.getByRole("button", { name: translate("wiki.linkSave") }).click();
  await bubble.getByRole("button", { name: translate("wiki.align.right") }).click();
  await bubble.getByRole("combobox", { name: translate("wiki.tool.blockType") }).selectOption("h2");
  await page.keyboard.press("ArrowRight");
  await bubble.waitFor({ state: "hidden" });
  const paletteText = wikiEditor.getByText("Palette proof"); await paletteText.waitFor();
  check(await wikiEditor.locator("h2").filter({ hasText: "Palette proof" }).count() === 1, "bubble node selector did not convert the selected block");
  check((await wikiEditor.locator("h2").filter({ hasText: "Palette proof" }).getAttribute("style"))?.includes("text-align: right"), "bubble alignment did not apply to the heading");
  check(await wikiEditor.locator('a[href="https://palette.example"]').count() === 1 && await wikiEditor.locator("u").filter({ hasText: "Palette proof" }).count() === 1, "bubble link or underline did not apply");
  check(await wikiEditor.locator('span[style*="color: rgb(59, 130, 246)"]').filter({ hasText: "Palette proof" }).count() === 1, "bubble text colour did not apply");
  check(await wikiEditor.locator('mark[style*="background-color: rgb(234, 179, 8)"]').filter({ hasText: "Palette proof" }).count() === 1, "bubble highlight did not apply");
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("Paragraph alignment"); await page.keyboard.press("Shift+Home");
  const paragraphBubble = page.getByTestId("wiki-bubble-menu"); await paragraphBubble.waitFor();
  await paragraphBubble.getByRole("button", { name: translate("wiki.align.center") }).click();
  await page.keyboard.press("ArrowRight"); await paragraphBubble.waitFor({ state: "hidden" });
  check((await wikiEditor.locator("p").filter({ hasText: "Paragraph alignment" }).getAttribute("style"))?.includes("text-align: center"), "bubble alignment did not apply to the paragraph");
  // Every table control is exercised through the editor UI and its resulting document.
  await wikiEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.table"), exact: true }).click();
  const table = wikiEditor.locator("table").last();
  await table.waitFor();
  const controls = page.locator(`[aria-label="${translate("table.controls")}"]`);
  const button = (key: string) => controls.getByRole("button", { name: translate(key as never), exact: true });
  await table.locator("th, td").first().click();
  await controls.getByRole("button", { name: `${translate("table.cellColor")} #22c55e` }).click();
  check((await table.locator("th, td").first().getAttribute("data-background-color")) === "#22c55e", "table cell palette did not set its background colour");
  await button("table.resetCellColor").click();
  check(await table.locator("th, td").first().getAttribute("data-background-color") === null, "Reset cell color did not restore the default cell background");
  await controls.getByRole("button", { name: `${translate("table.cellColor")} #22c55e` }).click();
  await button("table.insertRowAbove").click(); check(await table.locator("tr").count() === 4, "insert row above failed");
  await button("table.insertRowBelow").click(); check(await table.locator("tr").count() === 5, "insert row below failed");
  await table.locator("tr").nth(1).locator("td, th").first().click();
  await page.keyboard.type("duplicate-me");
  await button("table.duplicateRow").click();
  check((await table.innerText()).includes("duplicate-me"), "duplicate row lost source content");
  check(await table.locator("tr").count() === 6, "duplicate row failed");
  await button("table.clearRow").click();
  check((await table.locator("tr").allInnerTexts()).filter((text) => text.includes("duplicate-me")).length === 1, `clear row should leave only the duplicated row: ${JSON.stringify(await table.locator("tr").allInnerTexts())}`);
  await button("table.deleteRow").click(); check(await table.locator("tr").count() === 5, "delete row failed");
  await button("table.insertColumnLeft").click(); check(await table.locator("tr").first().locator("th, td").count() === 4, "insert column left failed");
  await button("table.insertColumnRight").click(); check(await table.locator("tr").first().locator("th, td").count() === 5, "insert column right failed");
  await table.locator("tr").first().locator("th, td").nth(1).click();
  await page.keyboard.type("column-copy");
  await button("table.duplicateColumn").click();
  check((await table.innerText()).includes("column-copy"), `duplicate column lost source content: ${JSON.stringify(await table.locator("tr").allInnerTexts())}`);
  check(await table.locator("tr").first().locator("th, td").count() === 6, "duplicate column failed");
  await button("table.clearColumn").click();
  check((await table.locator("tr").allInnerTexts()).filter((text) => text.includes("column-copy")).length === 1, "clear column should leave only the duplicated column");
  await button("table.deleteColumn").click(); check(await table.locator("tr").first().locator("th, td").count() === 5, "delete column failed");
  await table.locator("tr").first().locator("th, td").first().click();
  const headerCellsBefore = await table.locator("tr").first().locator("th").count();
  await button("table.toggleHeaderRow").click();
  const headerCellsAfter = await table.locator("tr").first().locator("th").count();
  check(headerCellsAfter !== headerCellsBefore, "header row toggle did not change its state");
  await button("table.toggleHeaderRow").click(); check(await table.locator("tr").first().locator("th").count() === headerCellsBefore, "header row toggle did not restore its state");
  await table.locator("tr").nth(1).locator("th, td").first().click();
  const headerColumnBefore = await table.locator("th").count();
  await button("table.toggleHeaderColumn").click(); check(await table.locator("th").count() !== headerColumnBefore, "header column toggle did not change its state");
  await button("table.toggleHeaderColumn").click();
  const headerColumnRestored = await table.locator("th").count();
  check(headerColumnRestored === headerColumnBefore, `header column toggle did not restore its state (${headerColumnBefore} -> ${headerColumnRestored})`);
  const rowCountBeforeTab = await table.locator("tr").count();
  const lastCell = table.locator("tr").last().locator("td, th").last().locator("p");
  await lastCell.click();
  check(await wikiEditor.evaluate((element) => document.activeElement === element), "Tab test did not focus the Wiki editor");
  check(await page.evaluate(() => !!window.getSelection()?.anchorNode?.parentElement?.closest("td, th")), "Tab test caret is not inside a table cell");
  await page.keyboard.press("Tab"); check(await table.locator("tr").count() === rowCountBeforeTab + 1, "Tab in last cell did not append a row");
  const activeCellIndex = () => page.evaluate(() => {
    const cell = window.getSelection()?.anchorNode?.parentElement?.closest("td, th");
    if (!cell) return -1;
    return Array.from(cell.closest("table")!.querySelectorAll("td, th")).indexOf(cell);
  });
  const cellBeforeShiftTab = await activeCellIndex();
  await page.keyboard.press("Shift+Tab");
  check(await table.locator("tr").count() === rowCountBeforeTab + 1, "Shift-Tab changed the table structure");
  check(await activeCellIndex() === cellBeforeShiftTab - 1, "Shift-Tab did not move to the previous cell");
  await button("table.deleteTable").click(); check(await wikiEditor.locator("table").count() === 0, "delete table left the table in the document");

  // Keep a table in the document for the read-only and published rendering checks.
  await wikiEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.table"), exact: true }).click();
  await wikiEditor.locator("table").waitFor();
  const savedTable = wikiEditor.locator("table").last();
  await savedTable.locator("th, td").first().click();
  await page.locator(`[aria-label="${translate("table.controls")}"]`).getByRole("button", { name: `${translate("table.cellColor")} #22c55e` }).click();
  await page.waitForTimeout(2_000);
  await page.getByText(translate("wiki.saved")).waitFor({ timeout: 10_000 });
  await page.reload();
  await page.getByTestId("wiki-editor").locator('h2:has-text("Palette proof")').waitFor();
  const persistedWiki = page.getByTestId("wiki-editor").locator(".ProseMirror");
  check(await persistedWiki.locator('a[href="https://palette.example"] u').count() === 1, "bubble formatting did not persist after reload");
  check(await persistedWiki.locator('mark[style*="background-color: rgb(234, 179, 8)"]').filter({ hasText: "Palette proof" }).count() === 1, "highlight did not persist after reload");
  check((await persistedWiki.locator("p").filter({ hasText: "Paragraph alignment" }).getAttribute("style"))?.includes("text-align: center"), "paragraph alignment did not persist after reload");
  check(await persistedWiki.locator("table th, table td").first().getAttribute("data-background-color") === "#22c55e", "table cell colour did not persist after reload");
  check(await persistedWiki.locator("pre code span[class]").count() > 0, "highlighted code did not persist in the Wiki editor");
  check(await persistedWiki.locator("aside[data-callout]").last().getAttribute("data-color") === "#f97316" && await persistedWiki.locator("aside[data-callout]").last().getAttribute("data-icon") === "🚀", "callout colour and icon did not persist after reload");
  console.log("case passed: highlighted code and callout colour/icon persist after reload");
  await persistedWiki.locator("table th, table td").first().click();

  await call("lock_wiki_page", { pageId: wiki.id });
  await page.getByTestId("wiki-page-locked").waitFor();
  await page.getByTestId("wiki-editor").locator(".ProseMirror[contenteditable=false]").waitFor();
  check(await page.getByTestId("wiki-editor").locator("table").count() === 1, "read-only Wiki did not render its table");
  // A real selection and real typing on the locked page: no bubble menu, and the typed text never lands in the editor or the stored page.
  await page.getByTestId("wiki-editor").locator("p").filter({ hasText: "Paragraph alignment" }).first().click({ clickCount: 3 });
  await page.waitForTimeout(300);
  check(await page.getByTestId("wiki-bubble-menu").count() === 0, "read-only Wiki shows the formatting bubble menu for a real selection");
  await page.keyboard.type("typed-after-lock");
  await page.waitForTimeout(1_500);
  check(!(await page.getByTestId("wiki-editor").innerText()).includes("typed-after-lock"), "text typed after the lock appeared in the editor");
  check(!JSON.stringify(await call("get_wiki_page", { pageId: wiki.id })).includes("typed-after-lock"), "text typed after the lock was stored");
  check(await page.getByTestId("wiki-editor").locator(`[aria-label="${translate("table.controls")}" ]`).count() === 0, "read-only Wiki shows table controls");
  const published = await call<{ token: string }>("publish_wiki_page", { pageId: wiki.id });
  await page.goto(`${web}/p/${published.token}`);
  const publishedPage = page.getByTestId("published-wiki-page").locator(".ProseMirror");
  await checkLink(publishedPage, "Read only link", "https://example.edu/", true);
  check(await publishedPage.locator("table").count() === 1, "published Wiki did not render its table");
  check(await publishedPage.locator('a[href="https://palette.example"] u').count() === 1, "published Wiki did not render the formatted inline link and underline");
  check(await publishedPage.locator('mark[style*="background-color: rgb(234, 179, 8)"]').filter({ hasText: "Palette proof" }).count() === 1, "published Wiki did not render highlight colour");
  check((await publishedPage.locator("h2").filter({ hasText: "Palette proof" }).getAttribute("style"))?.includes("text-align: right"), "published Wiki did not render text alignment");
  check(await publishedPage.locator("table th, table td").first().getAttribute("data-background-color") === "#22c55e", "published Wiki did not render table cell colour");
  check(await publishedPage.locator("pre code span[class]").count() > 0, "published Wiki did not render highlighted code");
  check(await publishedPage.locator("aside[data-callout]").last().getAttribute("data-color") === "#f97316", "published Wiki did not render coloured callouts");
  check(await publishedPage.locator("aside[data-callout] [data-callout-icon]").last().innerText() === "🚀", "published Wiki did not render the callout icon");
  check(await publishedPage.locator("[aria-label='Table controls']").count() === 0, "published Wiki shows table controls");
  console.log("case passed: published Wiki renders highlighted code and coloured callouts");
  console.log("editor parity ok: placeholders, visible markdown blocks, shared slash menu, and safe links in description, Comment, Wiki, and published Wiki");
  await browser.close();
  browser = null;
} finally {
  await browser?.close();
  if (slug) {
    const { client, db } = createDatabase();
    await db.delete(workspaces).where(eq(workspaces.slug, slug));
    await db.delete(users).where(eq(users.email, `${slug}@example.test`));
    await client.end();
  }
  for (const server of servers) server.kill();
}
