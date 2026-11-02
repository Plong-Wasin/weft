// Browser end-to-end flow: live Wiki updates, Wiki and Pages list controls, and the page editor.
// Run with `bun e2e/wiki-pages.e2e.ts` (set DATABASE_URL to an isolated test database). Screenshots go to .local/visual/review/15-wiki-and-pages.
import { chromium } from "playwright";
import { eq, like } from "drizzle-orm";
import { createDatabase, users, workspaceMembers, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31157);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52157);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31158);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const liveHttp = `http://localhost:${livePort}`;
const shots = reviewShots("15-wiki-and-pages");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort) }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
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
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(liveHttp)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

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
  const project = (await call<Array<{ id: string; key: string }>>("list_projects", { workspaceId, archived: false })).find((candidate) => candidate.key === "MOB")!;
  await call("create_wiki_page", { workspaceId, title: "Handbook" });
  await call("create_wiki_page", { workspaceId, title: "Runbook" });

  // Wiki lists every page; Pages of the project lists none yet.
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("link", { name: "Handbook" }).waitFor();
  await page.getByRole("link", { name: "Runbook" }).waitFor();
  // List state is addressable, so refreshing preserves the selected tab, filters, and order.
  await page.getByRole("tab", { name: translate("pages.tab.all") }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "all");
  await page.getByLabel(translate("pages.filter.owner")).selectOption({ label: "Wiki Tester" });
  await page.waitForFunction(() => Boolean(new URLSearchParams(location.search).get("owner")));
  await page.getByLabel(translate("pages.order")).selectOption("name");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("order") === "name");
  check(page.url().includes("tab=all") && page.url().includes("owner=") && page.url().includes("order=name"), "Wiki list controls must be reflected in the URL");
  await page.reload();
  await page.getByRole("link", { name: "Handbook" }).waitFor();
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
  await secondary.getByLabel(translate("auth.name")).fill("Wiki Collaborator");
  await secondary.getByLabel(translate("auth.email")).fill(secondaryEmail);
  await secondary.getByLabel(translate("auth.password")).fill("a-secure-password");
  await secondary.getByRole("button", { name: translate("auth.signUp") }).click();
  await secondary.getByLabel(translate("workspace.name")).fill("Collaborator team");
  await secondary.getByLabel(translate("workspace.slug")).fill(secondarySlug);
  await secondary.getByRole("button", { name: translate("workspace.create") }).click();
  const [collaborator] = await db.select().from(users).where(eq(users.email, secondaryEmail));
  await db.insert(workspaceMembers).values({ workspaceId, userId: collaborator!.id, role: "Admin" });
  await secondary.waitForTimeout(1_200);
  const createResponse = await secondary.request.post(`${api}/actions/create_wiki_page`, { data: { workspaceId, title: "Created by collaborator" } });
  check(createResponse.ok, "a second workspace member must be able to create a Wiki page");
  await page.getByRole("link", { name: "Created by collaborator" }).waitFor({ timeout: 10_000 });
  await page.getByLabel(translate("pages.filter.owner")).selectOption({ label: "Wiki Collaborator" });
  await page.getByRole("link", { name: "Created by collaborator" }).waitFor();
  await page.getByRole("link", { name: "Handbook" }).waitFor({ state: "detached" });
  check(await page.getByRole("link", { name: "Handbook" }).count() === 0, "Owner filter must hide pages owned by other people");
  await page.getByLabel(translate("pages.filter.owner")).selectOption("");
  await page.getByLabel(translate("pages.filter.createdAfter")).fill("2999-01-01");
  await page.getByRole("link", { name: "Handbook" }).waitFor({ state: "detached" });
  await page.getByText(translate("wiki.empty")).waitFor();
  await page.getByLabel(translate("pages.filter.createdAfter")).fill("");
  await page.getByRole("link", { name: "Handbook" }).waitFor();
  await secondaryContext.close();
  console.log("wiki-pages ok: collaborator list updates without reload");
  await page.goto(`${web}/${slug}/projects/MOB/pages`);
  await page.getByText(translate("pages.empty")).waitFor();
  check(await page.getByRole("link", { name: "Handbook" }).count() === 0, "Pages must start empty");
  await page.screenshot({ path: `${shots}/pages-empty-1440.png` });

  // Pages and Wiki lists are separate scopes; seed shared and private Pages for list controls.
  const sharedPage = await call<{ id: string }>("create_wiki_page", { workspaceId, projectId: project.id, title: "A Project draft" });
  await call("create_wiki_page", { workspaceId, projectId: project.id, title: "Z Private draft", access: "private" });
  await Bun.sleep(1_100);
  await call("update_wiki_page", { pageId: sharedPage.id, title: "A Project handbook" });
  await page.getByRole("link", { name: "A Project handbook" }).waitFor();
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
  await page.getByRole("link", { name: "A Project handbook" }).waitFor();
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
  await page.getByRole("link", { name: "A Project handbook" }).waitFor({ state: "detached" });
  check(await page.getByRole("link", { name: "A Project handbook" }).count() === 0, "Created date filter must hide older Pages");
  await page.getByLabel(translate("pages.filter.createdAfter")).fill("2020-01-01");
  await page.getByRole("link", { name: "A Project handbook" }).waitFor();
  await page.goto(`${web}/${slug}/projects/MOB/pages`);
  await page.getByRole("link", { name: "A Project handbook" }).waitFor();
  await page.getByRole("tab", { name: translate("pages.tab.private") }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "private");
  await page.getByRole("link", { name: "Z Private draft" }).waitFor();
  check(await page.getByRole("link", { name: "A Project handbook" }).count() === 0, "Private tab must hide public pages");
  await page.getByRole("tab", { name: translate("pages.tab.public") }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "public");
  await page.getByRole("link", { name: "A Project handbook" }).waitFor();
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("link", { name: "Runbook" }).waitFor();
  await page.getByRole("link", { name: "Handbook" }).waitFor();
  console.log("wiki-pages ok: Wiki and Pages list tabs, filters, and order");

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
  await page.reload();
  await page.locator(".ProseMirror ul li strong", { hasText: "Hello toolbar" }).waitFor();
  await page.getByRole("region", { name: translate("wiki.activity") }).getByText(new RegExp(translate("wiki.activity.created"))).waitFor();
  console.log("wiki-pages ok: toolbar, autosave, activity");

  // The created Page remains visible on the Pages list.
  await page.goto(`${web}/${slug}/projects/MOB/pages`);
  await page.getByRole("link", { name: "A Project handbook" }).waitFor();
  await page.getByRole("link", { name: "Untitled" }).waitFor();

  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/pages-390.png` });
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("link", { name: "Handbook" }).waitFor();
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
