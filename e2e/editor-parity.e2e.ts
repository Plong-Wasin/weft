// Browser end-to-end check for shared ProseMirror styling and slash commands.
import { chromium, type Browser } from "playwright";
import { eq } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31158);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52158);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
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
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: web });
  const page = await context.newPage();
  slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByLabel(translate("auth.name")).fill("Editor Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const seededLinkDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Read only link", marks: [{ type: "link", attrs: { href: "https://example.edu" } }] }] }] };
  const workItem = await call<{ id: string }>("create_work_item", { projectId: project!.id, title: "Editor parity" });
  await call("create_comment", { workItemId: workItem.id, body: seededLinkDoc });
  await call("create_wiki_page", { workspaceId: me.workspaces[0]!.id, title: "Editor page", content: seededLinkDoc });
  const wikiPages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId: me.workspaces[0]!.id });
  const wiki = wikiPages.find((candidate) => candidate.title === "Editor page")!;

  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const description = page.getByTestId("description-editor").locator(".ProseMirror");
  const comment = page.getByTestId("comment-editor").locator(".ProseMirror");
  await description.waitFor();
  await comment.waitFor();

  const exercisePlaceholder = async (name: string, editor: typeof description) => {
    const emptyParagraph = editor.locator("p.is-empty");
    await emptyParagraph.waitFor({ state: "attached" });
    check(await emptyParagraph.getAttribute("data-placeholder") === translate("editor.placeholder"), `${name} placeholder translation is missing`);
    await editor.click();
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

  const exerciseSlashMenu = async (editor: typeof description) => {
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const menu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
    await menu.waitFor();
    const menuLabels = ["wiki.tool.text", "wiki.tool.h1", "wiki.tool.h2", "wiki.tool.h3", "wiki.tool.bulletList", "wiki.tool.orderedList", "wiki.tool.quote", "wiki.tool.codeBlock", "wiki.tool.divider"];
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


  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await wikiEditor.waitFor();
  await exercisePlaceholder("Wiki", wikiEditor);
  // The Wiki editor has its own slash picker (covered by wiki-pages.e2e.ts), not the shared SlashMenu.
  await wikiEditor.click();
  await page.keyboard.type("# Heading ");
  await wikiEditor.locator("h1").waitFor();
  check(await wikiEditor.locator("h1").evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) > 15, "Wiki heading styling is missing");
  const published = await call<{ token: string }>("publish_wiki_page", { pageId: wiki.id });
  await page.goto(`${web}/p/${published.token}`);
  const publishedPage = page.getByTestId("published-wiki-page").locator(".ProseMirror");
  await checkLink(publishedPage, "Read only link", "https://example.edu/", true);
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
