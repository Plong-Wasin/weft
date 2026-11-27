// Browser cases for dragging a Wiki block to any boundary of the page: the gutter, the gaps, before the first and after the last block,
// auto-scroll on a long page, and reduced motion.
import { check, createSignedInContext, launchBrowser, startApi, startLive, startWeb, waitFor } from "./harness";
import { type Browser, type Locator } from "playwright";
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
  startApi(apiPort, web),
  startLive(livePort, web),
  startWeb(webPort, { api, live: `ws://localhost:${livePort}` }),
];
let slug = "";
let browser: Browser | null = null;

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const filler = (count: number) => Array.from({ length: count }, (_, index) => paragraph(`Filler paragraph ${index + 1}`));

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(liveHttp)]);
  browser = await launchBrowser();
  slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" }, api, web, {
    account: { name: "Block Drag Tester", email: `${slug}@example.test` },
    workspace: { name: "Block drag team", slug },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(15_000);
  const browserErrors = new Set<string>();
  page.on("pageerror", (error) => { if (!browserErrors.has(error.message)) { browserErrors.add(error.message); console.log(`[browser pageerror] ${error.stack ?? error.message}`); } });
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };

  await page.goto(`${web}/${slug}`);
  // The workspace exists once the app opens its route; reading the account before that can miss it.
  await page.waitForURL(new RegExp(`/${slug}(/|$)`));
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;

  // Each case gets its own page, so one case's moves never shift another's positions.
  let caseCount = 0;
  const openPage = async (title: string, blocks: unknown[]) => {
    caseCount += 1;
    await call("create_wiki_page", { workspaceId, title: `${title} ${caseCount}`, content: { type: "doc", content: blocks } });
    const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId });
    const wiki = pages.find((item) => item.title === `${title} ${caseCount}`)!;
    await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
    const editor = page.getByTestId("wiki-editor").locator(".ProseMirror");
    await editor.getByText(blockText(blocks[0]), { exact: true }).waitFor();
    return editor;
  };
  const blockText = (block: unknown) => ((block as { content: Array<{ text: string }> }).content[0]!).text;
  const order = (editor: Locator) => editor.evaluate((root) => Array.from(root.children).map((node) => node.textContent ?? ""));
  const waitForOrder = async (editor: Locator, expected: string[]) => {
    await page.waitForFunction(
      (wanted) => Array.from(document.querySelector('[data-testid="wiki-editor"] .ProseMirror')?.children ?? []).map((node) => node.textContent ?? "").join("|") === wanted.join("|"),
      expected,
      { timeout: 5_000 },
    ).catch(async () => {
      throw new Error(`block order is ${JSON.stringify(await order(editor))}, expected ${JSON.stringify(expected)}`);
    });
  };
  const blockBox = async (editor: Locator, name: string) => {
    const box = await editor.getByText(name, { exact: true }).boundingBox();
    if (!box) throw new Error(`${name} is not visible`);
    return box;
  };
  /** Grabs the grip of a block and holds the pointer at `point`; returns the drop line's box while the button is still down. */
  const holdDrag = async (editor: Locator, name: string, point: { x: number; y: number }) => {
    await editor.getByText(name, { exact: true }).hover();
    const grip = page.getByTestId("wiki-block-handle");
    const gripBox = await grip.boundingBox();
    if (!gripBox) throw new Error(`no grip for ${name}`);
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y, { steps: 10 });
    const line = page.getByTestId("wiki-block-drop-line");
    await line.waitFor({ timeout: 3_000 });
    return line.boundingBox();
  };
  const editorBox = async (editor: Locator) => {
    const box = await editor.boundingBox();
    if (!box) throw new Error("the editor is not visible");
    return box;
  };

  // 1. Gutter, gap, before the first and after the last block.
  const short = [paragraph("Alpha"), paragraph("Beta"), paragraph("Gamma")];
  let editor = await openPage("Drop anywhere short", short);
  const alpha = await blockBox(editor, "Alpha");
  const beta = await blockBox(editor, "Beta");
  const gamma = await blockBox(editor, "Gamma");
  const area = await editorBox(editor);
  check(area.x > 30, `the editor leaves no gutter to drop in (editor starts at ${area.x}px)`);

  // The gutter: left of the text, below Beta's bottom edge.
  let line = await holdDrag(editor, "Alpha", { x: area.x - 16, y: beta.y + beta.height + 2 });
  check(!!line && Math.abs(line.y - (beta.y + beta.height)) <= 4, `drop line in the gutter is not at the bottom of Beta (line ${line?.y}, Beta bottom ${beta.y + beta.height})`);
  await page.mouse.up();
  await waitForOrder(editor, ["Beta", "Alpha", "Gamma"]);
  console.log("PASS dragging into the gutter drops the block after the block above and shows the line first");

  // A gap between two blocks: the drop line snaps to the nearer edge, here the bottom of Beta.
  editor = await openPage("Drop anywhere gap", short);
  const betaGap = await blockBox(editor, "Beta");
  const gammaGap = await blockBox(editor, "Gamma");
  const gapY = betaGap.y + betaGap.height + Math.max(1, (gammaGap.y - (betaGap.y + betaGap.height)) / 2 - 3);
  const midX = (await editorBox(editor)).x + (await editorBox(editor)).width / 2;
  line = await holdDrag(editor, "Alpha", { x: midX, y: gapY });
  check(!!line && Math.abs(line.y - (betaGap.y + betaGap.height)) <= 4, `drop line in a gap did not snap to the nearer edge (line ${line?.y}, Beta bottom ${betaGap.y + betaGap.height})`);
  await page.mouse.up();
  await waitForOrder(editor, ["Beta", "Alpha", "Gamma"]);
  console.log("PASS dragging into a gap between blocks snaps the drop line to the nearer block edge and drops there");

  // Before the first block: a pointer above Alpha's top edge.
  editor = await openPage("Drop anywhere first", short);
  const alphaFirst = await blockBox(editor, "Alpha");
  line = await holdDrag(editor, "Gamma", { x: alphaFirst.x + alphaFirst.width / 2, y: alphaFirst.y - 18 });
  check(!!line && Math.abs(line.y - alphaFirst.y) <= 4, `drop line above the first block is not at its top (line ${line?.y}, Alpha top ${alphaFirst.y})`);
  await page.mouse.up();
  await waitForOrder(editor, ["Gamma", "Alpha", "Beta"]);
  console.log("PASS dragging above the first block drops it before the first block");

  // After the last block: a pointer below Gamma's bottom edge, out in the margin.
  editor = await openPage("Drop anywhere last", short);
  const gammaLast = await blockBox(editor, "Gamma");
  line = await holdDrag(editor, "Alpha", { x: gammaLast.x - 20, y: gammaLast.y + gammaLast.height + 40 });
  check(!!line && Math.abs(line.y - (gammaLast.y + gammaLast.height)) <= 4, `drop line below the last block is not at its bottom (line ${line?.y}, Gamma bottom ${gammaLast.y + gammaLast.height})`);
  await page.mouse.up();
  await waitForOrder(editor, ["Beta", "Gamma", "Alpha"]);
  console.log("PASS dragging below the last block drops it after the last block");

  // 2. Auto-scroll on a long page: a block dragged to the bottom edge scrolls the page down.
  const longBlocks = [paragraph("Long Alpha"), ...filler(80), paragraph("Long Omega")];
  const scrollTop = () => page.evaluate(() => document.getElementById("main-content")?.scrollTop ?? 0);
  const scrollerBox = await page.evaluate(() => {
    const rect = document.getElementById("main-content")!.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  const holdAtBottomEdge = async (blocks: unknown[], name: string, holdMs: number) => {
    editor = await openPage("Auto-scroll long", blocks);
    const before = await scrollTop();
    check(before === 0, `the long page did not start at the top (scrollTop ${before})`);
    await editor.getByText(name, { exact: true }).hover();
    const gripBox = await page.getByTestId("wiki-block-handle").boundingBox();
    if (!gripBox) throw new Error(`no grip for ${name}`);
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gripBox.x + gripBox.width / 2, scrollerBox.bottom - 10, { steps: 10 });
    await page.waitForTimeout(holdMs);
    const after = await scrollTop();
    await page.mouse.up();
    return { before, after };
  };
  const scrolled = await holdAtBottomEdge(longBlocks, "Long Alpha", 1_500);
  check(scrolled.after - scrolled.before > 100, `holding a drag at the bottom edge did not scroll the page (scrollTop ${scrolled.before} -> ${scrolled.after})`);
  await page.waitForTimeout(300);
  const longOrder = await order(editor);
  check(longOrder.indexOf("Long Alpha") > 0, "the block dragged to the bottom edge did not move down the page");
  console.log(`PASS holding a drag at the bottom edge auto-scrolls the long page (${scrolled.before} -> ${scrolled.after}px)`);

  // 3. Reduced motion: auto-scroll still works but at a slow, capped pace.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await holdAtBottomEdge(longBlocks, "Long Alpha", 1_500);
  const reducedDelta = reduced.after - reduced.before;
  const fullDelta = scrolled.after - scrolled.before;
  check(reducedDelta > 0, "auto-scroll stopped entirely under reduced motion");
  check(reducedDelta * 2 < fullDelta, `auto-scroll under reduced motion (${reducedDelta}px) is not clearly slower than without it (${fullDelta}px)`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  console.log(`PASS auto-scroll respects reduced motion (${reducedDelta}px in 1.5s, against ${fullDelta}px without it)`);

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
