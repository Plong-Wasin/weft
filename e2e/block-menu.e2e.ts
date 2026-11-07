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
  page.setDefaultTimeout(10_000);
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
  ] };
  await call("create_wiki_page", { workspaceId: me.workspaces[0]!.id, title: "Block controls", content });
  const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId: me.workspaces[0]!.id });
  const wiki = pages.find((item) => item.title === "Block controls")!;
  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const editor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await editor.getByText("Movable block", { exact: true }).waitFor();
  const collaborator = await context.newPage();
  collaborator.setDefaultTimeout(10_000);
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
