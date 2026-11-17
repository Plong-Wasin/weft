// Page and Wiki page Details panel: hidden by default, toggled from the header, remembered on wide screens,
// a drawer below 1024px, one row of tabs, and Outlinks/Backlinks only inside the Links tab.
import { chromium } from "playwright";
import { createDatabase } from "../packages/db/src";
import { createMemberFactory } from "../packages/db/src/test-helpers";
import { createProjectActions, createWikiActions, createWorkItemActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31267);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52267);
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
  const slug = `details-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name} failed (${response.status()}): ${await response.text()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Panel Writer");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Panel review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const ownerId = me.user.id;
  const projects = createProjectActions(db);
  const workItems = createWorkItemActions(db);
  const wiki = createWikiActions(db);
  const project = await projects.createProject.handler({ userId: ownerId }, { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  const target = await workItems.createWorkItem.handler({ userId: ownerId }, { projectId: project.id, title: "Release plan" });
  const linkedPage = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, projectId: project.id, title: "Project handbook" });
  const wikiPage = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Team handbook" });
  const visibleWiki = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Wiki source", contentMarkdown: `[[Team handbook|wiki:${wikiPage.id}]]` });
  const hiddenMember = await createMemberFactory(db, workspaceId, "Member");
  const hiddenCollection = await wiki.createCollection.handler({ userId: hiddenMember.id }, { workspaceId, name: "Private notes", visibility: "private" });
  await wiki.createWikiPage.handler({ userId: hiddenMember.id }, { workspaceId, collectionId: hiddenCollection.id, title: "Private backlink", contentMarkdown: `[[Team handbook|wiki:${wikiPage.id}]]` });
  await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Source notes", contentMarkdown: `[[Release plan|work-item:${target.id}]] [[Project handbook|page:${linkedPage.id}]]` });
  const pageLinks = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, projectId: project.id, title: "Panel page", contentMarkdown: `[[Project handbook|page:${linkedPage.id}]]` });
  await page.evaluate(() => localStorage.clear());

  const panelName = translate("wiki.details", "en");
  const linksName = translate("outlinks.title", "en");
  const toggle = () => page.getByTestId("wiki-details-toggle");
  const details = () => page.getByRole("complementary", { name: panelName, exact: true });
  const links = () => details().getByRole("region", { name: linksName, exact: true });
  const tabs = () => details().getByRole("tab");
  const tabLabels = ["Details", "Outline", "Links", "Comments", "Activity"];
  const sameRow = async () => {
    const boxes = await Promise.all((await tabs().all()).map((tab) => tab.boundingBox()));
    check(boxes.length === 5, `the Details panel must show five tabs, found ${boxes.length}`);
    check(boxes.every((box) => box !== null && Math.abs(box.y - boxes[0]!.y) < 1), "the five Details panel tabs must stay on one row");
  };
  const openPage = async (url: string) => { await page.goto(url); await page.getByRole("heading", { name: translate("wiki.untitled", "en") }).or(page.getByLabel(translate("wiki.untitled", "en"), { exact: true })).first().waitFor(); };

  // Wide screen: hidden on open, toggled from the header, choice kept after reload.
  await openPage(`${web}/${slug}/wiki/${wikiPage.id}`);
  check(await details().count() === 0, "opening a Wiki page must not show the Details panel");
  check(await toggle().getAttribute("aria-pressed") === "false", "the header toggle must start unpressed");
  await toggle().click();
  await details().waitFor();
  check(await toggle().getAttribute("aria-pressed") === "true", "the header toggle must be pressed while the panel is open");

  // Header icon buttons: one ghost family, icons centred in their box, a tooltip from the catalog, a pressed fill in both themes.
  const menuTrigger = () => page.getByRole("button", { name: translate("wiki.exports", "en"), exact: true });
  const offCentre = async (button: ReturnType<typeof toggle>) => {
    const box = await button.boundingBox();
    const icon = await button.locator("svg").first().boundingBox();
    check(box !== null && icon !== null, "a header icon button must render its icon");
    return { x: Math.abs(icon!.x + icon!.width / 2 - (box!.x + box!.width / 2)), y: Math.abs(icon!.y + icon!.height / 2 - (box!.y + box!.height / 2)) };
  };
  for (const [name, button] of [["Details toggle", toggle()], ["page menu", menuTrigger()]] as const) {
    const off = await offCentre(button);
    check(off.x < 1 && off.y < 1, `the ${name} icon must be centred in its button, off by ${off.x.toFixed(2)}px across and ${off.y.toFixed(2)}px down`);
  }
  const fill = (locator: ReturnType<typeof toggle>) => locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  check(await toggle().getAttribute("title") === "Hide details", "the open toggle's tooltip must read Hide details");
  check(await fill(toggle()) !== "rgba(0, 0, 0, 0)", "the pressed toggle must have a fill in the light theme");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  check(await fill(toggle()) !== "rgba(0, 0, 0, 0)", "the pressed toggle must have a fill in the dark theme");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await toggle().click();
  await details().waitFor({ state: "detached" });
  check(await toggle().getAttribute("title") === "Show details", "the closed toggle's tooltip must read Show details");
  await page.mouse.move(0, 0);
  check(await fill(toggle()) === "rgba(0, 0, 0, 0)", "the unpressed toggle must stay a transparent ghost button");
  await toggle().click();
  await details().waitFor();
  await page.reload();
  await details().waitFor();
  check(await details().isVisible(), "the open choice must survive reload on a wide screen");
  await toggle().click();
  await details().waitFor({ state: "detached" });
  await page.reload();
  await page.getByTestId("wiki-details-toggle").waitFor();
  check(await details().count() === 0, "the closed choice must survive reload on a wide screen");

  // The five tabs keep one row at 1440px, and the Links tab lists what the viewer can open.
  await toggle().click();
  await details().waitFor();
  await sameRow();
  for (const label of tabLabels) check(await details().getByRole("tab", { name: label, exact: true }).count() === 1, `tab ${label} must be present`);
  check(await links().count() === 0, "Outlinks and Backlinks must not render while the Details tab is selected");
  await details().getByRole("tab", { name: linksName, exact: true }).click();
  await links().waitFor();
  await links().getByText("Wiki source", { exact: false }).first().waitFor();
  check(await links().getByText("Wiki source", { exact: false }).count() === 1, "the visible Backlink must be listed in the Links tab");
  check(await links().getByText("Private backlink", { exact: false }).count() === 0, "a Backlink from a source the viewer cannot open must stay hidden");
  check(await page.getByTestId("wiki-editor-shell").getByRole("region", { name: linksName, exact: true }).count() === 0, "nothing may render under the editor body");

  // Source Page: outlinks show in the Links tab, not under the body.
  await openPage(`${web}/${slug}/projects/MOB/pages/${pageLinks.id}`);
  await details().waitFor();
  check(await details().isVisible(), "the wide-screen choice must carry over to the next page");
  await details().getByRole("tab", { name: linksName, exact: true }).click();
  await links().getByText("Project handbook", { exact: false }).first().waitFor();
  check(await page.getByTestId("wiki-editor-shell").getByRole("region", { name: linksName, exact: true }).count() === 0, "a Page must not render Links under its body");

  // Narrow screen: drawer, closed on load, closes by button, outside tap and Escape.
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(`${web}/${slug}/wiki/${wikiPage.id}`);
  check(await details().count() === 0, "a narrow screen must start with the drawer closed");
  await toggle().click();
  await details().waitFor();
  const drawer = await details().boundingBox();
  check(drawer !== null && drawer.x > 0 && drawer.x + drawer.width <= 390 + 1, "the narrow panel must be a drawer inside the 390px viewport");
  check((await offCentre(toggle())).x < 1, "the Details toggle icon must stay centred at 390px");
  await sameRow();
  // The drawer is a modal dialog: it says so, focus enters it, Tab stays inside it, and focus returns to the toggle when it closes.
  check(await page.getByRole("dialog", { name: translate("wiki.details", "en"), exact: true }).getAttribute("aria-modal") === "true", "the narrow drawer must be a modal dialog");
  check(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")), "focus must enter the drawer when it opens");
  for (let i = 0; i < 40; i += 1) { await page.keyboard.press("Tab"); if (!(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")))) throw new Error("Tab left the open drawer"); }
  await details().getByRole("button", { name: translate("wiki.details.close", "en"), exact: true }).click();
  await details().waitFor({ state: "detached" });
  check(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "wiki-details-toggle"), "focus must return to the toggle after the drawer closes");
  await toggle().click();
  await details().waitFor();
  await details().getByRole("button", { name: translate("wiki.details.close", "en"), exact: true }).click();
  await details().waitFor({ state: "detached" });
  await toggle().click();
  await details().waitFor();
  await page.keyboard.press("Escape");
  await details().waitFor({ state: "detached" });
  await toggle().click();
  await details().waitFor();
  await page.mouse.click(20, 500);
  await details().waitFor({ state: "detached" });
  await toggle().click();
  await details().waitFor();
  await page.reload();
  await page.getByTestId("wiki-details-toggle").waitFor();
  check(await details().count() === 0, "a narrow screen must start with the drawer closed after reload");
  await details().count();

  // A wide-screen choice does not open the drawer on a narrow screen.
  await page.setViewportSize({ width: 1440, height: 900 });
  await details().waitFor();
  check(await toggle().getAttribute("aria-pressed") === "true", "the stored wide choice is open before the narrow check");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByTestId("wiki-details-toggle").waitFor();
  check(await details().count() === 0, "a stored wide choice must not open the drawer on a narrow screen");

  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  servers.forEach((server) => server.kill());
  await client.end();
}
process.exit(failed ? 1 : 0);
