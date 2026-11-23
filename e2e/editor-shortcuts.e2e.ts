// Browser cases for ticket 12: editor keyboard shortcuts (comment submit and cancel, clear formatting, redo, block move and duplicate, shortcuts list and dialog).
import { chromium, type Browser } from "playwright";
import { translate } from "../packages/shared/src";
import { editorPalette } from "../packages/actions/src/wiki-editor-extensions";
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
  await page.getByLabel(translate("auth.name")).fill("Shortcut Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Shortcut team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Keys");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("KEY");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /KEY · Keys/ }).waitFor();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId, archived: false });
  const item = await call<{ displayId: string }>("create_work_item", { projectId: project!.id, title: "Shortcut item" });
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  await call("create_wiki_page", { workspaceId, title: "Shortcut page", content: { type: "doc", content: [
    paragraph("First block"),
    paragraph("Second block"),
    paragraph("Third block"),
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Styled heading" }] },
    { type: "paragraph", content: [
      { type: "text", text: "Styled text", marks: [{ type: "bold" }, { type: "italic" }, { type: "textStyle", attrs: { color: editorPalette[5] } }, { type: "highlight", attrs: { color: editorPalette[2] } }, { type: "link", attrs: { href: "https://example.com/" } }] },
    ] },
  ] } });
  const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId });
  const wiki = pages.find((row) => row.title === "Shortcut page")!;

  // Ticket 12.1: Ctrl/Cmd+Enter submits a new comment; Shift+Enter still inserts a line break.
  await page.goto(`${web}/${slug}/browse/${item.displayId}`);
  const composer = page.getByTestId("comment-editor").last();
  const composerText = composer.locator(".ProseMirror");
  const comments = page.locator('li[id^="comment-"]');
  await composerText.click();
  await page.keyboard.type("Line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Line two");
  check(await composerText.locator("br").count() >= 1, "Shift+Enter did not insert a line break in the comment");
  check(await comments.count() === 0, "Shift+Enter submitted the comment");
  await page.keyboard.press("Control+Enter");
  await comments.filter({ hasText: "Line two" }).waitFor();
  check(await comments.count() === 1, "Ctrl+Enter did not submit exactly one comment");
  check(await comments.first().locator(".comment-body br").count() >= 1, "submitted comment lost its line break");
  check((await composerText.innerText()).trim() === "", "Ctrl+Enter did not clear the composer after submit");
  console.log("PASS Ctrl+Enter submits a new comment, Shift+Enter keeps the line break");

  // Ticket 12.1 and 12.2: Ctrl+Enter saves an edit; Escape cancels an edit and a reply, and keeps the draft of a new comment.
  const row = comments.filter({ hasText: "Line one" });
  await row.getByRole("button", { name: translate("comments.more"), exact: true }).first().click(); await page.getByRole("dialog", { name: translate("comments.more") }).getByRole("button", { name: translate("comments.edit"), exact: true }).click();
  const editor = row.getByTestId("comment-editor").first().locator(".ProseMirror");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" dropped");
  await page.keyboard.press("Escape");
  await row.getByTestId("comment-editor").first().waitFor({ state: "detached" });
  check(!(await row.locator(".comment-body").innerText()).includes("dropped"), "Escape saved the edit instead of cancelling it");
  console.log("PASS Escape cancels an edit without saving it");

  await row.getByRole("button", { name: translate("comments.more"), exact: true }).first().click(); await page.getByRole("dialog", { name: translate("comments.more") }).getByRole("button", { name: translate("comments.edit"), exact: true }).click();
  await row.getByTestId("comment-editor").first().locator(".ProseMirror").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" saved");
  await page.keyboard.press("Control+Enter");
  await row.getByTestId("comment-editor").first().waitFor({ state: "detached" });
  check((await row.locator(".comment-body").innerText()).includes("saved"), "Ctrl+Enter did not save the edit");
  console.log("PASS Ctrl+Enter saves an edit");

  await row.getByRole("button", { name: translate("comments.reply"), exact: true }).click();
  await row.getByTestId("comment-editor").first().locator(".ProseMirror").click();
  await page.keyboard.type("Reply draft");
  await page.keyboard.press("Escape");
  await row.getByTestId("comment-editor").first().waitFor({ state: "detached" });
  check(await page.getByText("Reply draft", { exact: true }).count() === 0, "Escape posted the reply draft");
  console.log("PASS Escape cancels a reply");

  // The slash menu uses Escape too: it closes the menu first and leaves the edit open.
  await row.getByRole("button", { name: translate("comments.more"), exact: true }).first().click(); await page.getByRole("dialog", { name: translate("comments.more") }).getByRole("button", { name: translate("comments.edit"), exact: true }).click();
  const slashEditor = row.getByTestId("comment-editor").first().locator(".ProseMirror");
  await slashEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).waitFor({ state: "detached" });
  check(await row.getByTestId("comment-editor").first().count() === 1, "Escape in the slash menu also cancelled the edit");
  await page.keyboard.press("Escape");
  await row.getByTestId("comment-editor").first().waitFor({ state: "detached" });
  console.log("PASS Escape closes the slash menu first, then cancels the edit");

  await row.getByRole("button", { name: translate("comments.reply"), exact: true }).click();
  await row.getByTestId("comment-editor").first().locator(".ProseMirror").click();
  await page.keyboard.type("Reply via keys");
  await page.keyboard.press("Control+Enter");
  await page.getByText("Reply via keys", { exact: true }).waitFor();
  await row.getByTestId("comment-editor").first().waitFor({ state: "detached" });
  console.log("PASS Ctrl+Enter posts a reply");

  await composerText.click();
  await page.keyboard.type("Draft kept");
  await composerText.click();
  await page.keyboard.press("Escape");
  check((await composerText.innerText()).includes("Draft kept"), "Escape lost the draft of a new comment");
  check((await page.getByTestId("comment-editor").last().locator(".ProseMirror").innerText()).includes("Draft kept"), "the new comment draft is gone after Escape");
  await page.keyboard.press("Control+Enter");
  await comments.filter({ hasText: "Draft kept" }).waitFor();
  console.log("PASS Escape keeps the draft of a new comment");

  // Ticket 12.1 tooltip: the submit button names its key.
  check(await page.getByRole("button", { name: translate("comments.add"), exact: true }).last().getAttribute("title") === withShortcut(translate("comments.add"), "Enter"), "the Comment button does not show Ctrl/Cmd+Enter in its tooltip");
  console.log("PASS the Comment button tooltip shows Ctrl/Cmd+Enter");

  // The comment editor has no block move or duplicate: Ctrl+Shift+Up and Ctrl+D change nothing there.
  await composerText.click();
  await page.keyboard.type("Alpha");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Beta");
  await page.keyboard.press("Control+Shift+ArrowUp");
  await page.keyboard.press("Control+d");
  check((await composerText.innerText()).replace(/\s+/g, " ").trim() === "Alpha Beta", `the comment editor moved or duplicated a block: "${await composerText.innerText()}"`);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  console.log("PASS block move and duplicate keys do nothing in the Comment editor");

  // Description editor (not collaborative): redo keys and block keys.
  await page.goto(`${web}/${slug}/browse/${item.displayId}`);
  const description = page.getByTestId("description-editor").locator(".ProseMirror");
  await description.click();
  await page.keyboard.type("Description one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Description two");
  await page.keyboard.press("Control+z");
  check(await description.getByText("Description two", { exact: true }).count() === 0, "undo did not remove the description text");
  await page.keyboard.press("Control+Shift+z");
  await description.getByText("Description two", { exact: true }).waitFor();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await description.getByText("Description two", { exact: true }).waitFor();
  console.log("PASS Ctrl+Shift+Z and Ctrl+Y redo in the description editor");

  await page.keyboard.press("Control+Shift+ArrowUp");
  check(JSON.stringify(await description.evaluate((node) => Array.from(node.children).map((child) => child.textContent ?? ""))) === JSON.stringify(["Description two", "Description one"]), "Ctrl+Shift+Up did not move the description block");
  await page.keyboard.press("Control+d");
  check(await description.getByText("Description two", { exact: true }).count() === 2, "Ctrl+D did not duplicate the description block");
  console.log("PASS block move up and duplicate work in the description editor");

  // Wiki page (collaborative): redo, block move and duplicate reach the collaborator; clear formatting runs last.
  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await wikiEditor.getByText("Styled text", { exact: true }).waitFor();
  const collaborator = await context.newPage();
  collaborator.setDefaultTimeout(10_000);
  await collaborator.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const otherEditor = collaborator.getByTestId("wiki-editor").locator(".ProseMirror");
  await otherEditor.getByText("Styled text", { exact: true }).waitFor({ timeout: 10_000 });
  // The selection reaches ProseMirror a moment after a click, so a key pressed at once would act on the old caret: wait until the DOM caret is in the block.
  const placeCaret = async (text: string) => {
    await wikiEditor.getByText(text, { exact: true }).last().click();
    await page.waitForFunction((expected) => window.getSelection()?.anchorNode?.parentElement?.closest(".ProseMirror") !== null && window.getSelection()?.anchorNode?.textContent === expected, text);
    await page.waitForTimeout(150);
  };
  // A remote caret shows its name inside the block it sits in, so the names are removed before the text is compared.
  const order = (root: typeof wikiEditor) => root.evaluate((node) => Array.from(node.children).map((child) => (child.textContent ?? "").replace(/Shortcut Tester/g, "")));
  const waitForOrder = async (root: typeof wikiEditor, expected: string[]) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (JSON.stringify((await order(root)).slice(0, expected.length)) === JSON.stringify(expected)) return;
      await Bun.sleep(200);
    }
    throw new Error(`collaborator view did not settle on ${JSON.stringify(expected)}: ${JSON.stringify(await order(root))}`);
  };

  // Ticket 12.4: redo with Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y, in the collaborative Wiki editor.
  // Known, not fixed here: after a whole-document edit (select all, then Ctrl+B), typing, undo and redo replace the whole page with the typed text.
  await placeCaret("Third block");
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await page.waitForTimeout(800);
  await page.keyboard.press("Control+z");
  check(await wikiEditor.getByText("Third block typed", { exact: true }).count() === 0, "undo did not remove the typed text");
  await page.keyboard.press("Control+Shift+z");
  await wikiEditor.getByText("Third block typed", { exact: true }).waitFor();
  console.log("PASS Ctrl+Shift+Z redoes in the Wiki editor");
  await page.keyboard.press("Control+z");
  check(await wikiEditor.getByText("Third block typed", { exact: true }).count() === 0, "second undo did not remove the typed text");
  await page.keyboard.press("Control+y");
  await wikiEditor.getByText("Third block typed", { exact: true }).waitFor();
  console.log("PASS Ctrl+Y redoes in the Wiki editor");

  // Ticket 12.5: Ctrl/Cmd+Shift+Up and Down move the current block as one transaction; Ctrl/Cmd+D duplicates it.
  await placeCaret("Second block");
  await page.keyboard.press("Control+Shift+ArrowUp");
  const movedUp = ["Second block", "First block", "Third block typed"];
  check(JSON.stringify((await order(wikiEditor)).slice(0, 3)) === JSON.stringify(movedUp), `Ctrl+Shift+Up did not move the block: ${JSON.stringify(await order(wikiEditor))}`);
  await waitForOrder(otherEditor, movedUp);
  await page.keyboard.press("Control+z");
  check(JSON.stringify((await order(wikiEditor)).slice(0, 3)) === JSON.stringify(["First block", "Second block", "Third block typed"]), "one undo did not revert the whole move");
  console.log("PASS Ctrl+Shift+Up moves the block up, reaches the collaborator and undoes in one step");
  await placeCaret("Second block");
  await page.keyboard.press("Control+Shift+ArrowDown");
  check(JSON.stringify((await order(wikiEditor)).slice(0, 3)) === JSON.stringify(["First block", "Third block typed", "Second block"]), "Ctrl+Shift+Down did not move the block down");
  await waitForOrder(otherEditor, ["First block", "Third block typed", "Second block"]);
  console.log("PASS Ctrl+Shift+Down moves the block down");

  await page.keyboard.press("Control+d");
  check(await wikiEditor.getByText("Second block", { exact: true }).count() === 2, "Ctrl+D did not duplicate the block");
  await waitForOrder(otherEditor, ["First block", "Third block typed", "Second block", "Second block"]);
  console.log("PASS Ctrl+D duplicates the current block and reaches the collaborator");

  // Ticket 12.3: Ctrl/Cmd+\\ removes marks and resets the block to a paragraph on the selection (last: a whole-document edit).
  const styledMarks = "strong, em, mark, a[href], span[style*='color']";
  check(await wikiEditor.locator(styledMarks).count() >= 4, "the styled text does not carry its marks before clearing");
  check(await wikiEditor.locator("h2").count() === 1, "the heading is not an h2 before clearing");
  await wikiEditor.getByText("Styled text", { exact: true }).click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+Backslash");
  await wikiEditor.locator(styledMarks).first().waitFor({ state: "detached" });
  check(await wikiEditor.locator(`${styledMarks}, h2`).count() === 0, "Ctrl+\\ left a mark or a heading block");
  check(await wikiEditor.getByText("Styled heading", { exact: true }).evaluate((node) => node.tagName === "P"), "Ctrl+\\ did not reset the heading block to a paragraph");
  check(await wikiEditor.getByText("Styled text", { exact: true }).count() === 1, "Ctrl+\\ removed the text itself");
  console.log("PASS clear formatting removes bold, italic, colour, highlight, link and resets a heading block");

  // Ticket 12.6: Ctrl/Cmd+/ opens the shortcuts dialog from inside an editor; Escape closes it.
  await wikiEditor.getByText("Second block", { exact: true }).last().click();
  await page.keyboard.press("Control+/");
  const dialog = page.getByRole("dialog", { name: translate("shortcuts.title"), exact: true });
  await dialog.waitFor();
  check(await dialog.getByText(translate("shortcuts.editorRedo"), { exact: true }).count() === 1, "the dialog does not list redo");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  console.log("PASS Ctrl+/ opens the shortcuts dialog and Escape closes it");

  // Ticket 12.6: the Shortcuts page lists the new keys.
  await page.goto(`${web}/account/shortcuts`);
  await page.locator("kbd").first().waitFor();
  const keys = await page.locator("kbd").allInnerTexts();
  for (const key of ["Ctrl U", "Ctrl Shift H", "Ctrl Shift 9", "Ctrl Alt C", "Ctrl Shift Z", "Ctrl Y", "Tab", "Shift Tab", "Ctrl \\", "Ctrl Shift ↑", "Ctrl Shift ↓", "Ctrl D", "Ctrl Enter", "Ctrl /", "Esc"]) {
    check(keys.includes(key), `the shortcuts page does not list ${key}`);
  }
  check(keys.some((key) => key.startsWith("Ctrl Alt 1")), "the shortcuts page does not list the heading keys");
  console.log("PASS the Shortcuts page lists every new key");

  // Ticket 12.7: every new string is in the catalog in English and Thai.
  for (const key of ["shortcuts.editorUnderline", "shortcuts.editorHighlight", "shortcuts.editorTodo", "shortcuts.editorHeading", "shortcuts.editorCodeBlock", "shortcuts.editorRedo", "shortcuts.editorRedoAlt", "shortcuts.editorIndent", "shortcuts.editorOutdent", "shortcuts.editorClearFormatting", "shortcuts.editorMoveBlockUp", "shortcuts.editorMoveBlockDown", "shortcuts.editorDuplicateBlock", "shortcuts.editorSubmitComment", "shortcuts.editorCancelComment", "shortcuts.editorHelp"] as const) {
    check(translate(key, "en") !== "" && translate(key, "th") !== "" && translate(key, "th") !== translate(key, "en"), `${key} is not translated to Thai`);
  }
  console.log("PASS every new shortcut string exists in English and Thai");
  console.log("editor shortcuts ok");
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
