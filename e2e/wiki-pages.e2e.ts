// Browser end-to-end flow: Wiki list, wiki page editor with toolbar, project Pages, link/unlink, page activity.
// Run with `bun e2e/wiki-pages.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database). Screenshots go to .local/visual/review/15-wiki-and-pages.
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31157);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52157);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31159);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("15-wiki-and-pages");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort) }, stdout: "inherit", stderr: "inherit" }),
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
  await page.getByLabel(translate("auth.name")).fill("Wiki Tester");
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
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  await call("create_wiki_page", { workspaceId, title: "Handbook" });
  await call("create_wiki_page", { workspaceId, title: "Runbook" });

  // Wiki lists every page; Pages of the project lists none yet.
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("link", { name: "Handbook" }).waitFor();
  await page.getByRole("link", { name: "Runbook" }).waitFor();
  await page.goto(`${web}/${slug}/projects/MOB/pages`);
  await page.getByText(translate("pages.empty")).waitFor();
  check(await page.getByRole("link", { name: "Handbook" }).count() === 0, "Pages must start empty");
  await page.screenshot({ path: `${shots}/pages-empty-1440.png` });

  // Move Handbook from the Wiki into the project's Pages: it leaves the Wiki because each document has one scope.
  await page.getByLabel(translate("pages.linkExisting")).selectOption({ label: "Handbook" });
  await page.getByRole("link", { name: "Handbook" }).waitFor();
  check(await page.getByRole("link", { name: "Runbook" }).count() === 0, "Pages must show only linked pages");
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("link", { name: "Runbook" }).waitFor();
  check(await page.getByRole("link", { name: "Handbook" }).count() === 0, "a Page must leave the Wiki after moving to a project");
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
  await page.keyboard.type("/");
  const slash = page.getByRole("menu", { name: translate("wiki.insert") });
  await slash.waitFor();
  for (const key of ["wiki.tool.h1", "wiki.tool.h2", "wiki.tool.h3", "wiki.tool.h4", "wiki.tool.h5", "wiki.tool.h6", "wiki.tool.bulletList", "wiki.tool.orderedList", "wiki.insert.todo", "wiki.insert.table", "wiki.tool.quote", "wiki.tool.codeBlock", "wiki.insert.callout", "wiki.insert.divider", "wiki.insert.emoji", "wiki.insert.color", "wiki.insert.image"] as const) {
    await slash.getByRole("menuitem", { name: translate(key) }).waitFor();
  }
  await slash.getByRole("menuitem", { name: translate("wiki.tool.h2") }).click();
  await page.keyboard.type("Outline section");
  await page.getByRole("tab", { name: translate("wiki.outline") }).click();
  const outline = page.getByRole("navigation", { name: translate("wiki.outline") });
  const heading = outline.getByRole("button", { name: "Outline section" });
  await heading.waitFor();
  await heading.click();
  check(await page.locator(".ProseMirror h2").filter({ hasText: "Outline section" }).count() === 1, "outline entry must navigate to its heading");
  await page.getByRole("tab", { name: translate("wiki.editorTab") }).click();
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
  await page.getByRole("region", { name: translate("wiki.activity") }).getByText(new RegExp(translate("wiki.activity.created"))).waitFor();
  console.log("wiki-pages ok: toolbar, autosave, activity");

  // Link/unlink from the page's details.
  const details = page.getByRole("complementary", { name: translate("wiki.details") });
  const scope = details.getByRole("combobox", { name: translate("wiki.linkProject") });
  await scope.selectOption("");
  await page.waitForURL(new RegExp(`/${slug}/wiki/[0-9a-f-]+$`));
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("link", { name: "Untitled" }).waitFor();
  check(await page.getByRole("link", { name: "Handbook" }).count() === 0, "the Page remains in its project when another Page moves back to Wiki");
  console.log("wiki-pages ok: Page and Wiki page keep their scopes");

  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Untitled" }).waitFor();
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
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
