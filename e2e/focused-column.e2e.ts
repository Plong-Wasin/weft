// Page and Wiki page body: a centred ~760px column with no box around the body or title, a Full width
// option in the page menu that is remembered per browser, and side margins that work at 390px.
import { chromium } from "playwright";
import { createDatabase } from "../packages/db/src";
import { createProjectActions, createWikiActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31268);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52268);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true", VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];
const { client, db } = createDatabase();
let failed = false;
async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const slug = `column-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Column Writer");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Column review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const ownerId = me.user.id;
  const projects = createProjectActions(db);
  const wiki = createWikiActions(db);
  const project = await projects.createProject.handler({ userId: ownerId }, { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  const body = Array.from({ length: 6 }, (_, index) => `Paragraph ${index + 1} explains the release steps in plain sentences so the column has real text to measure.`).join("\n\n");
  const wikiPage = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Column handbook", contentMarkdown: body });
  const pagePage = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, projectId: project.id, title: "Column page", contentMarkdown: body });
  await page.evaluate(() => localStorage.clear());

  const fullWidthName = translate("wiki.fullWidth", "en");
  const menuName = translate("wiki.exports", "en");
  // The text column: the section that holds the title and the editor body, measured against its own grid.
  const column = () => page.getByTestId("wiki-editor-shell").locator("xpath=../.."); // shell -> print document -> section
  const grid = () => page.getByTestId("wiki-editor-shell").locator("xpath=../../..");
  const box = async (locator: ReturnType<typeof page.locator>) => { const found = await locator.boundingBox(); check(found !== null, "element must have a box"); return found!; };
  const openPage = async (url: string) => { await page.goto(url); await page.getByTestId("wiki-editor").waitFor(); await page.locator(".wiki-edit-title").waitFor(); };
  const menuItem = () => page.getByRole("menuitemcheckbox", { name: fullWidthName, exact: true });
  const toggleFullWidth = async () => {
    await page.getByRole("button", { name: menuName, exact: true }).click();
    await menuItem().click();
  };

  // 1440px, panel closed: the body column is about 760px and centred in its grid, with no box.
  await openPage(`${web}/${slug}/wiki/${wikiPage.id}`);
  check(await page.getByRole("heading", { level: 1, name: "Column handbook", exact: true }).count() === 1, "the editable Wiki title must be the page's accessible h1");
  const closedColumn = await box(column());
  const closedGrid = await box(grid());
  check(closedColumn.width >= 700 && closedColumn.width <= 780, `the text column must be about 760px wide at 1440px, found ${closedColumn.width}`);
  const leftGap = closedColumn.x - closedGrid.x;
  const rightGap = closedGrid.x + closedGrid.width - (closedColumn.x + closedColumn.width);
  check(Math.abs(leftGap - rightGap) <= 2, `the text column must be centred, gaps ${leftGap} and ${rightGap}`);

  // Panel open: the column still reads well, about 760px or less, and does not overlap the panel.
  await page.getByTestId("wiki-details-toggle").click();
  await page.getByRole("complementary", { name: translate("wiki.details", "en"), exact: true }).waitFor();
  const openColumn = await box(column());
  const details = await box(page.getByRole("complementary", { name: translate("wiki.details", "en"), exact: true }));
  check(openColumn.width >= 480 && openColumn.width <= 780, `the text column must stay readable with the panel open, found ${openColumn.width}`);
  check(openColumn.x + openColumn.width <= details.x + 1, "the text column must not run under the Details panel");
  await page.getByTestId("wiki-details-toggle").click();
  await page.getByRole("complementary", { name: translate("wiki.details", "en"), exact: true }).waitFor({ state: "detached" });

  // No box: the editor body and the title have no border and no surface.
  const bodyStyle = await page.getByTestId("wiki-editor").evaluate((node) => { const style = getComputedStyle(node); return { border: style.borderTopWidth, background: style.backgroundColor }; });
  check(bodyStyle.border === "0px", `the editor body must have no border, found ${bodyStyle.border}`);
  check(bodyStyle.background === "rgba(0, 0, 0, 0)" || bodyStyle.background === "transparent", `the editor body must have no surface, found ${bodyStyle.background}`);
  const titleStyle = await page.locator(".wiki-edit-title").evaluate((node) => { const style = getComputedStyle(node); return { border: style.borderTopWidth, size: Number.parseFloat(style.fontSize) }; });
  check(titleStyle.border === "0px", `the title must have no border, found ${titleStyle.border}`);
  check(titleStyle.size >= 32, `the title must be large, found ${titleStyle.size}px`);

  // Full width: the menu option widens the body, survives reload, and can be turned off.
  await toggleFullWidth();
  await page.keyboard.press("Escape");
  await menuItem().waitFor({ state: "detached" });
  const wideColumn = await box(column());
  check(wideColumn.width > 900, `Full width must widen the body past 900px at 1440px, found ${wideColumn.width}`);
  await page.reload();
  await page.getByTestId("wiki-editor").waitFor();
  const reloadedWide = await box(column());
  check(reloadedWide.width > 900, `Full width must survive reload, found ${reloadedWide.width}`);
  await page.getByRole("button", { name: menuName, exact: true }).click();
  check(await menuItem().getAttribute("aria-checked") === "true", "the Full width menu item must show as checked");
  await menuItem().click();
  const narrowAgain = await box(column());
  check(narrowAgain.width >= 700 && narrowAgain.width <= 780, `turning Full width off must return to about 760px, found ${narrowAgain.width}`);

  // The Full width choice is per page menu, and a Page shows the same column.
  await openPage(`${web}/${slug}/projects/MOB/pages/${pagePage.id}`);
  const pageColumn = await box(column());
  check(pageColumn.width >= 700 && pageColumn.width <= 780, `a Page must use the same centred column, found ${pageColumn.width}`);

  // 390px: text uses the full width with a comfortable side margin and no horizontal page scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(`${web}/${slug}/wiki/${wikiPage.id}`);
  const phoneColumn = await box(column());
  const phoneLeft = phoneColumn.x;
  const phoneRight = 390 - (phoneColumn.x + phoneColumn.width);
  check(phoneLeft >= 12 && phoneLeft <= 24, `the phone side margin must be comfortable, left ${phoneLeft}`);
  check(phoneRight >= 12 && phoneRight <= 24, `the phone side margin must be comfortable, right ${phoneRight}`);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  check(scrollWidth <= 390, `there must be no horizontal page scroll at 390px, scrollWidth ${scrollWidth}`);

  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  servers.forEach((server) => server.kill());
  await client.end();
}
process.exit(failed ? 1 : 0);
