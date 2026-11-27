// Browser end-to-end flow: Favorites sit at the top of their sidebar section. In Work they follow the primary links and come before
// the project search and project list; in Wiki they come before the page tree. An empty Favorites list shows no heading, and the
// order holds at phone width without horizontal page scroll.
// Run with `bun e2e/sidebar-favorites.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { check, launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31050);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52050);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

/** A landmark inside the sidebar: the first element matching `selector` (and, when given, whose text is `text`). */
type Landmark = { name: string; selector: string; text?: string };

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const sidebar = () => page.getByRole("navigation", { name: translate("shell.sidebar") });
  const favoritesText = translate("sidebar.favorites");

  // Each landmark must exist, and each must come after the one before it in document order.
  const landmarksInOrder = async (landmarks: Landmark[]) => await sidebar().evaluate((nav, list) => {
    const nodes = list.map((landmark) => {
      const match = [...nav.querySelectorAll(landmark.selector)].find((node) => landmark.text === undefined || node.textContent?.trim() === landmark.text);
      return { name: landmark.name, node: match ?? null };
    });
    const missing = nodes.filter((entry) => entry.node === null).map((entry) => entry.name);
    if (missing.length > 0) return { ok: false, problem: `missing: ${missing.join(", ")}` };
    for (let index = 1; index < nodes.length; index += 1) {
      const before = nodes[index - 1].node!;
      const after = nodes[index].node!;
      if ((before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
        return { ok: false, problem: `${nodes[index].name} is not after ${nodes[index - 1].name}` };
      }
    }
    return { ok: true, problem: "" };
  }, landmarks);

  // The order is read after the sidebar data loads: poll up to 5 seconds before failing.
  const expectOrder = async (landmarks: Landmark[], message: string) => {
    let last = { ok: false, problem: "not checked" };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      last = await landmarksInOrder(landmarks);
      if (last.ok) return;
      await Bun.sleep(100);
    }
    throw new Error(`${message}: ${last.problem}`);
  };

  // The Favorites heading count, polled until it matches the expected number (the list loads after the page).
  const expectHeadingCount = async (expected: number, message: string) => {
    let got = -1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      got = await sidebar().evaluate((nav, label) => [...nav.querySelectorAll("p")].filter((node) => node.textContent?.trim() === label).length, favoritesText);
      if (got === expected) return;
      await Bun.sleep(100);
    }
    throw new Error(`${message}: heading count ${got}, expected ${expected}`);
  };

  // Sign up and make a workspace with one project and two pages.
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Favorites Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/actions/create_workspace")), page.getByRole("button", { name: translate("workspace.create") }).click()]);
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  await call("create_project", { workspaceId, name: "Alpha", key: "ALP", visibility: "public" });
  const pageId = (await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Favorite handbook" })).id;
  await call("create_wiki_page", { workspaceId, title: "Plain page" });

  // Nothing favorited yet: no Favorites heading in either section.
  await page.goto(`${web}/${slug}`);
  await sidebar().getByRole("button", { name: `${translate("sidebar.toggleProject")}: Alpha` }).waitFor();
  await expectHeadingCount(0, "Favorites heading shows with no favorites (Work)");
  await page.goto(`${web}/${slug}/wiki`);
  await sidebar().getByRole("link", { name: translate("sidebar.allPages"), exact: true }).waitFor();
  await expectHeadingCount(0, "Favorites heading shows with no favorites (Wiki)");

  // Favorite one page: the heading and its link now show.
  await call("favorite_wiki_page", { pageId, favorite: true });

  // Work: Favorites follows the primary links and comes before the project search and the project list.
  const workOrder: Landmark[] = [
    { name: "Home link", selector: "a", text: translate("nav.home") },
    { name: "Favorites heading", selector: "p", text: favoritesText },
    { name: "Favorite link", selector: "a", text: "Favorite handbook" },
    { name: "project search", selector: `input[type="search"]` },
    { name: "project list", selector: `ul[aria-label="${translate("projects.title")}"]` },
  ];
  await page.goto(`${web}/${slug}`);
  await sidebar().getByRole("link", { name: "Favorite handbook", exact: true }).waitFor();
  await expectOrder(workOrder, "Work order wrong");
  console.log("sidebar favorites ok: Work order");

  // Wiki: Favorites comes before the page tree.
  const wikiOrder: Landmark[] = [
    { name: "Favorites heading", selector: "p", text: favoritesText },
    { name: "Favorite link", selector: "a", text: "Favorite handbook" },
    { name: "All pages link", selector: "a", text: translate("sidebar.allPages") },
  ];
  await page.goto(`${web}/${slug}/wiki`);
  // The page also sits in the page tree, so the wait takes the first match: the Favorites link comes first.
  await sidebar().getByRole("link", { name: "Favorite handbook", exact: true }).first().waitFor();
  await expectOrder(wikiOrder, "Wiki order wrong");
  console.log("sidebar favorites ok: Wiki order");

  // Phone width: the same Work order, and no horizontal page scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}`);
  // On a phone the sidebar lives in the menu drawer: open it, then read the same list inside it.
  await page.getByRole("button", { name: translate("shell.openMenu"), exact: true }).click();
  await sidebar().getByRole("link", { name: "Favorite handbook", exact: true }).waitFor();
  await expectOrder(workOrder, "phone Work order wrong");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "phone Work page overflows horizontally");
  console.log("sidebar favorites ok: phone layout");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Unfavorite: the heading disappears again in both sections.
  await call("favorite_wiki_page", { pageId, favorite: false });
  await page.goto(`${web}/${slug}`);
  await sidebar().getByRole("button", { name: `${translate("sidebar.toggleProject")}: Alpha` }).waitFor();
  await expectHeadingCount(0, "empty Favorites still shows its heading (Work)");
  await page.goto(`${web}/${slug}/wiki`);
  await sidebar().getByRole("link", { name: translate("sidebar.allPages"), exact: true }).waitFor();
  await expectHeadingCount(0, "empty Favorites still shows its heading (Wiki)");
  console.log("sidebar favorites ok: empty heading hidden");

  console.log("e2e sidebar-favorites: ok");
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
