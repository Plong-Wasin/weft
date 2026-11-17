// Browser cases for Wiki block handles, menus, persistence, and collaboration.
import { chromium, type Browser } from "playwright";
import { eq } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

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
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(15_000);
  const browserErrors = new Set<string>();
  page.on("console", (message) => { if (message.type() === "error" && !browserErrors.has(message.text())) { browserErrors.add(message.text()); console.log(`[browser console] ${message.text()}`); } });
  page.on("pageerror", (error) => { if (!browserErrors.has(error.message)) { browserErrors.add(error.message); console.log(`[browser pageerror] ${error.stack ?? error.message}`); } });
  slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Block Menu Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Block menu team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Blocks");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("BLK");
  await page.getByRole("button", { name: translate("projects.create") }).click();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const content = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Anchor block" }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Movable block" }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "List block" }] }] }] },
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quote block" }] }] },
    { type: "codeBlock", content: [{ type: "text", text: "Code block" }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Table block" }] }] }] }] },
    { type: "paragraph", content: [{ type: "text", text: "Wrapping paragraph ".repeat(20).trim() }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Aligned heading" }] },
    { type: "blockquote", content: [
      { type: "paragraph", content: [{ type: "text", text: "Tall first line" }] },
      { type: "paragraph", content: [{ type: "text", text: "Tall second line" }] },
      { type: "paragraph", content: [{ type: "text", text: "Tall third line" }] },
    ] },
  ] };
  await call("create_wiki_page", { workspaceId: me.workspaces[0]!.id, title: "Block controls", content });
  const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId: me.workspaces[0]!.id });
  const wiki = pages.find((item) => item.title === "Block controls")!;
  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const editor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await editor.getByText("Movable block", { exact: true }).waitFor();
  const collaborator = await context.newPage();
  collaborator.setDefaultTimeout(30_000);
  collaborator.setDefaultNavigationTimeout(15_000);
  collaborator.on("pageerror", (error) => { if (!browserErrors.has(error.message)) { browserErrors.add(error.message); console.log(`[collaborator pageerror] ${error.stack ?? error.message}`); } });
  await collaborator.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const otherEditor = collaborator.getByTestId("wiki-editor").locator(".ProseMirror");
  await otherEditor.getByText("Movable block", { exact: true }).waitFor({ timeout: 10_000 });

  const blockHandle = page.getByTestId("wiki-block-handle");
  await editor.getByText("Quote block", { exact: true }).hover();
  await blockHandle.waitFor({ timeout: 3_000 }).catch(async () => {
    console.log("block handle diagnostic", await page.evaluate(() => ({ blocks: Array.from(document.querySelectorAll('[data-testid="wiki-editor"] .ProseMirror > *')).map((node) => ({ tag: node.tagName, text: node.textContent, rect: node.getBoundingClientRect().toJSON() })), handles: Array.from(document.querySelectorAll('[data-testid="wiki-block-handle"]')).map((node) => node.outerHTML) })));
    await page.screenshot({ path: "/tmp/weft-block-handle-failure.png" });
    throw new Error("hover reveals a handle beside Quote blocks");
  });
  check(await blockHandle.isVisible(), "hovered block handle is not visible");
  const quoteBox = await editor.getByText("Quote block", { exact: true }).boundingBox();
  const handleBoxBesideQuote = await blockHandle.boundingBox();
  check(!!quoteBox && !!handleBoxBesideQuote && handleBoxBesideQuote.x + handleBoxBesideQuote.width <= quoteBox.x && Math.abs(handleBoxBesideQuote.y - quoteBox.y) < 8, "block handle is not beside the hovered block");
  console.log("PASS hover reveals the block handle for a quote");
  await page.mouse.move(5, 5);
  await blockHandle.waitFor({ state: "detached", timeout: 3_000 });
  console.log("PASS block handle hides after the pointer leaves the Wiki editor");

  await editor.getByText("Movable block", { exact: true }).hover();
  await blockHandle.click();
  const blockMenu = page.getByTestId("wiki-block-menu");
  await blockMenu.waitFor({ timeout: 3_000 });
  await blockMenu.getByRole("menuitem", { name: translate("wiki.blockDuplicate"), exact: true }).click();
  check(await editor.getByText("Movable block", { exact: true }).count() === 2, "block menu did not duplicate the heading");
  console.log("PASS block menu duplicates a heading");
  await editor.getByText("Movable block", { exact: true }).last().hover();
  await blockHandle.click();
  await page.getByTestId("wiki-block-menu").getByRole("menuitem", { name: translate("wiki.blockDelete"), exact: true }).click();
  check(await editor.getByText("Movable block", { exact: true }).count() === 1, "block menu did not delete the duplicate");
  console.log("PASS block menu deletes the selected block");

  const movingBlock = editor.getByText("Movable block", { exact: true });
  await movingBlock.hover();
  const handleBox = await blockHandle.boundingBox();
  const targetBox = await editor.getByText("Anchor block", { exact: true }).boundingBox();
  if (!handleBox || !targetBox) throw new Error("drag source or destination is not visible");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 5 });
  await page.mouse.up();
  const order = () => editor.evaluate((root) => Array.from(root.children).map((node) => node.textContent ?? ""));
  const otherOrder = () => otherEditor.evaluate((root) => Array.from(root.children).map((node) => node.textContent ?? ""));
  await page.waitForFunction(() => document.querySelector('[data-testid="wiki-editor"] .ProseMirror')?.firstElementChild?.textContent === "Movable block", null, { timeout: 10_000 });
  await collaborator.waitForFunction(() => document.querySelector('[data-testid="wiki-editor"] .ProseMirror')?.firstElementChild?.textContent === "Movable block", null, { timeout: 10_000 });
  const firstOrder = await order();
  const secondOrder = await otherOrder();
  check(firstOrder.indexOf("Movable block") < firstOrder.indexOf("Anchor block"), "dragging did not move the block to the drop position");
  check(JSON.stringify(secondOrder) === JSON.stringify(firstOrder), "collaborators did not converge on the same block order");
  console.log("PASS dragging reorders a block and collaborators converge");
  await page.waitForTimeout(2_000);
  await page.reload();
  const reloadedEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await reloadedEditor.getByText("Movable block", { exact: true }).waitFor();
  const reloadedOrder = await reloadedEditor.evaluate((root) => Array.from(root.children).map((node) => node.textContent ?? ""));
  check(reloadedOrder.indexOf("Movable block") < reloadedOrder.indexOf("Anchor block"), "reordered block order did not persist");
  console.log("PASS reordered block order persists after reload");

  // Order now: Movable, Anchor, List, Quote, Code, Table, Wrapping paragraph, Aligned heading, Tall block.
  const firstLineCenter = (text: string) => page.evaluate((target) => {
    const root = document.querySelector('[data-testid="wiki-editor"] .ProseMirror');
    const walker = document.createTreeWalker(root!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim() !== target) continue;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 1);
      const box = range.getBoundingClientRect();
      return box.top + box.height / 2;
    }
    throw new Error(`no text node ${target}`);
  }, text);
  const gripCenter = async () => {
    const box = await blockHandle.boundingBox();
    if (!box) throw new Error("block handle is not visible");
    return box.y + box.height / 2;
  };
  const checkGripOnFirstLine = async (text: string, message: string) => {
    await editor.getByText(text, { exact: true }).hover();
    await blockHandle.waitFor({ timeout: 3_000 });
    const grip = await gripCenter();
    const line = await firstLineCenter(text);
    check(Math.abs(grip - line) <= 4, `${message}: grip centre ${grip.toFixed(1)} is not on the first line centre ${line.toFixed(1)}`);
  };
  const headingTop = () => editor.getByText("Aligned heading", { exact: true }).evaluate((node) => node.getBoundingClientRect().top);

  await checkGripOnFirstLine("Anchor block", "grip is off the first line of a paragraph");
  await checkGripOnFirstLine("Aligned heading", "grip is off the first line of a heading");
  await checkGripOnFirstLine("Tall first line", "grip is off the first line of a tall block");
  console.log("PASS grip sits on the first line of a paragraph, a heading and a tall block");

  await page.setViewportSize({ width: 1440, height: 360 });
  await editor.getByText("Aligned heading", { exact: true }).evaluate((node) => node.scrollIntoView({ block: "center" }));
  await editor.getByText("Aligned heading", { exact: true }).hover();
  const topBeforeScroll = await headingTop();
  await page.evaluate(() => document.querySelector("main")?.scrollBy(0, -120));
  await page.waitForTimeout(300);
  check(Math.abs((await headingTop()) - topBeforeScroll) > 20, "scrolling the Wiki did not move the heading");
  await checkGripOnFirstLine("Aligned heading", "grip drifted off the heading after scrolling");
  console.log("PASS grip stays on the heading after scrolling");

  // Hover near the left edge so the pointer stays inside the editor when the window narrows.
  await editor.getByText("Aligned heading", { exact: true }).hover({ position: { x: 4, y: 4 } });
  const topBeforeResize = await headingTop();
  await page.setViewportSize({ width: 640, height: 360 });
  await page.waitForTimeout(300);
  check(Math.abs((await headingTop()) - topBeforeResize) > 4, "resizing did not move the heading; the resize check needs the paragraph above it to re-wrap");
  check(await blockHandle.isVisible(), "grip disappeared after resizing");
  const gripAfterResize = await gripCenter();
  const lineAfterResize = await firstLineCenter("Aligned heading");
  check(Math.abs(gripAfterResize - lineAfterResize) <= 4, `grip drifted off the heading after resizing: grip ${gripAfterResize.toFixed(1)}, line ${lineAfterResize.toFixed(1)}`);
  console.log("PASS grip stays on the heading after resizing");
  await page.setViewportSize({ width: 1440, height: 900 });

  const aligned = editor.getByText("Aligned heading", { exact: true });
  await aligned.hover();
  const gripBox = await blockHandle.boundingBox();
  const anchorBox = await editor.getByText("Anchor block", { exact: true }).boundingBox();
  if (!gripBox || !anchorBox) throw new Error("drag source or destination is not visible");
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(anchorBox.x + anchorBox.width / 2, anchorBox.y + 2, { steps: 8 });
  const ghost = page.getByTestId("wiki-block-ghost");
  await ghost.waitFor({ timeout: 3_000 });
  check(await ghost.evaluate((node) => getComputedStyle(node).boxShadow !== "none"), "drag ghost has no shadow");
  check((await ghost.textContent())?.includes("Aligned heading") === true, "drag ghost does not show the dragged block");
  const ghostHeight = (await ghost.boundingBox())?.height ?? 0;
  const sourceHeight = (await aligned.boundingBox())?.height ?? 0;
  check(ghostHeight > 0 && ghostHeight < sourceHeight + 40, `drag ghost is ${ghostHeight}px tall for a ${sourceHeight}px block (the editor's minimum height leaked into it)`);
  check(await aligned.evaluate((node) => Number(getComputedStyle(node).opacity) < 1), "dragged block is not dimmed in place");
  const dropLine = page.getByTestId("wiki-block-drop-line");
  await dropLine.waitFor({ timeout: 3_000 });
  const dropBox = await dropLine.boundingBox();
  check(!!dropBox && Math.abs(dropBox.y - anchorBox.y) <= 4, "drop line is not drawn at the top of Anchor block");
  await page.mouse.up();
  await ghost.waitFor({ state: "detached", timeout: 3_000 });
  check(await aligned.evaluate((node) => getComputedStyle(node).opacity === "1"), "dragged block stays dimmed after the drop");
  const afterFeedbackDrag = await order();
  check(afterFeedbackDrag.indexOf("Aligned heading") < afterFeedbackDrag.indexOf("Anchor block"), "drop did not place the heading on the drop line");
  console.log("PASS drag shows a ghost with a shadow, a dimmed source and a drop line, then drops on the line");

  // A grip inside a selection that spans blocks drags every block of the selection: Quote and Code move together below the Table.
  const beforeMulti = await order();
  const firstIndex = beforeMulti.findIndex((text) => text.startsWith("Quote block"));
  const blocks = editor.locator(":scope > *");
  const pair = [beforeMulti[firstIndex]!, beforeMulti[firstIndex + 1]!];
  check(beforeMulti[firstIndex + 2]?.startsWith("Table block") === true, `the multi-block drag expects Quote, Code, Table in a row: ${JSON.stringify(beforeMulti.map((t) => t.slice(0, 14)))}`);
  await blocks.nth(firstIndex).click();
  await blocks.nth(firstIndex + 1).click({ modifiers: ["Shift"] });
  await blocks.nth(firstIndex + 1).hover();
  const multiGrip = await blockHandle.boundingBox();
  const tableBlock = await blocks.nth(firstIndex + 2).boundingBox();
  if (!multiGrip || !tableBlock) throw new Error("multi-block drag source or destination is not visible");
  await page.mouse.move(multiGrip.x + multiGrip.width / 2, multiGrip.y + multiGrip.height / 2);
  await page.mouse.down();
  await page.mouse.move(tableBlock.x + tableBlock.width / 2, tableBlock.y + tableBlock.height - 2, { steps: 8 });
  const multiGhost = page.getByTestId("wiki-block-ghost");
  await multiGhost.waitFor({ timeout: 3_000 });
  const ghostText = (await multiGhost.textContent()) ?? "";
  check(ghostText.includes(pair[0]!.slice(0, 10)) && ghostText.includes(pair[1]!.slice(0, 10)), "drag ghost does not show every selected block");
  await page.mouse.up();
  await multiGhost.waitFor({ state: "detached", timeout: 3_000 });
  const afterMulti = await order();
  check(afterMulti.length === beforeMulti.length && afterMulti[firstIndex]?.startsWith("Table block") === true && afterMulti[firstIndex + 1] === pair[0] && afterMulti[firstIndex + 2] === pair[1], `the selected blocks did not move together below the Table: before ${JSON.stringify(beforeMulti.map((t) => t.slice(0, 14)))}, after ${JSON.stringify(afterMulti.map((t) => t.slice(0, 14)))}`);
  console.log("PASS dragging a grip inside a multi-block selection moves all of its blocks");

  await editor.getByText("Movable block", { exact: true }).hover();
  await blockHandle.click();
  const firstMenu = page.getByTestId("wiki-block-menu");
  await firstMenu.waitFor({ timeout: 3_000 });
  check(await firstMenu.getByRole("menuitem", { name: translate("wiki.blockMoveUp"), exact: true }).count() === 0, "first block offers Move up");
  await firstMenu.getByRole("menuitem", { name: translate("wiki.blockMoveDown"), exact: true }).focus();
  await page.keyboard.press("Enter");
  const afterMoveDown = await order();
  check(afterMoveDown[0] === "Aligned heading" && afterMoveDown[1] === "Movable block", "Move down from the keyboard did not swap Movable block with the block below");
  console.log("PASS Move down from the keyboard reorders the block; first block has no Move up");

  // ProseMirror keeps an empty trailing paragraph after the last block, so Tall still has a block below it.
  await editor.getByText("Tall second line", { exact: true }).hover();
  await blockHandle.click();
  const lastMenu = page.getByTestId("wiki-block-menu");
  await lastMenu.waitFor({ timeout: 3_000 });
  check(await lastMenu.getByRole("menuitem", { name: translate("wiki.blockMoveDown"), exact: true }).count() === 1, "block above the trailing paragraph lacks Move down");
  await lastMenu.getByRole("menuitem", { name: translate("wiki.blockMoveUp"), exact: true }).click();
  const afterMoveUp = await order();
  check(afterMoveUp[afterMoveUp.length - 1] === "" && afterMoveUp[afterMoveUp.length - 2].startsWith("Wrapping paragraph") && afterMoveUp[afterMoveUp.length - 3].startsWith("Tall first line"), "Move up did not swap the block with the one above it");
  await editor.locator(":scope > *").last().hover();
  await blockHandle.click();
  const trailingMenu = page.getByTestId("wiki-block-menu");
  await trailingMenu.waitFor({ timeout: 3_000 });
  check(await trailingMenu.getByRole("menuitem", { name: translate("wiki.blockMoveDown"), exact: true }).count() === 0, "last block offers Move down");
  await trailingMenu.getByRole("menuitem", { name: translate("wiki.blockMoveUp"), exact: true }).focus();
  await page.keyboard.press("Escape");
  await trailingMenu.waitFor({ state: "detached", timeout: 3_000 });
  console.log("PASS Move up reorders the block with the mouse; last block has no Move down");

  await editor.getByText("Anchor block", { exact: true }).click();
  await page.mouse.move(5, 5);
  await page.keyboard.press("ArrowDown");
  // The caret moved to the list; wait until the grip has followed it there before focusing it.
  for (let attempt = 0; attempt < 30 && Math.abs((await gripCenter()) - (await firstLineCenter("List block"))) > 4; attempt += 1) await Bun.sleep(100);
  await blockHandle.waitFor({ timeout: 3_000 });
  await blockHandle.focus();
  await page.keyboard.press("Enter");
  const keyboardMenu = page.getByTestId("wiki-block-menu");
  await keyboardMenu.waitFor({ timeout: 3_000 });
  await keyboardMenu.getByRole("menuitem", { name: translate("wiki.blockMoveUp"), exact: true }).focus();
  await page.keyboard.press("Enter");
  const afterKeyboardMove = await order();
  check(afterKeyboardMove.indexOf("List block") < afterKeyboardMove.indexOf("Anchor block"), "keyboard-only Move up did not reach the block after a caret move");
  console.log("PASS grip follows the caret and the block menu is keyboard reachable");

  // A collaborator types above the dragged block mid-drag: the source moves, so the drag is cancelled and no block moves.
  const beforeRemoteEdit = await order();
  await editor.getByText("Quote block", { exact: true }).hover();
  const quoteGrip = await blockHandle.boundingBox();
  // The code block's text also holds its copy button's label, so match the <pre> by its start.
  const codeBox = await editor.locator("pre", { hasText: "Code block" }).boundingBox();
  if (!quoteGrip || !codeBox) throw new Error("drag source or destination is not visible");
  await page.mouse.move(quoteGrip.x + quoteGrip.width / 2, quoteGrip.y + quoteGrip.height / 2);
  await page.mouse.down();
  await page.mouse.move(codeBox.x + codeBox.width / 2, codeBox.y + codeBox.height / 2, { steps: 5 });
  await page.getByTestId("wiki-block-ghost").waitFor({ timeout: 3_000 });
  await otherEditor.getByText("Aligned heading", { exact: true }).click();
  await collaborator.keyboard.press("Control+Home");
  await collaborator.keyboard.type("Remote ");
  // The remote cursor's name label sits inside the heading's text, so match the line by its start and end.
  await editor.getByText(/^Remote .*Aligned heading$/).waitFor({ timeout: 10_000 });
  await page.mouse.move(codeBox.x + codeBox.width / 2, codeBox.y + codeBox.height / 2 + 4, { steps: 2 });
  await page.mouse.up();
  await page.getByTestId("wiki-block-ghost").waitFor({ state: "detached", timeout: 3_000 });
  const afterRemoteEdit = await order();
  check(afterRemoteEdit.length === beforeRemoteEdit.length && /^Remote .*Aligned heading$/.test(afterRemoteEdit[0] ?? ""), "the collaborator's line did not reach the page");
  check(afterRemoteEdit.indexOf("Quote block") === beforeRemoteEdit.indexOf("Quote block") && afterRemoteEdit.findIndex((text) => text.startsWith("Code block")) === beforeRemoteEdit.findIndex((text) => text.startsWith("Code block")), "a drag that lost its source still moved a block");
  console.log("PASS a collaborator's edit during a drag cancels it and moves no block");

  await call("lock_wiki_page", { pageId: wiki.id });
  await page.getByTestId("wiki-page-locked").waitFor();
  check(await page.getByTestId("wiki-block-handle").count() === 0, "locked read-only Wiki shows a block handle");
  console.log("PASS read-only Wiki has no block handle");
  const published = await call<{ token: string }>("publish_wiki_page", { pageId: wiki.id });
  await page.goto(`${web}/p/${published.token}`);
  check(await page.getByTestId("wiki-block-handle").count() === 0, "published Wiki shows a block handle");
  console.log("PASS published Wiki has no block handle");
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
