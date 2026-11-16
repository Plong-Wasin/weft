// Browser end-to-end flow: project stars and order in the sidebar (Starred group, Move up/down, arrow keys, drag handle), reset,
// the same order in a second session, and the phone settings page that orders without dragging.
// Run with `bun e2e/project-order.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database). Screenshots go to .local/visual/review/40-project-order.
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31040);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52040);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("40-project-order");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

let failed = false;
let failurePage: Page | undefined;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  failurePage = page;
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const sidebar = () => page.getByRole("navigation", { name: translate("shell.sidebar") });
  const projectOrder = async (target: Page) => await target.getByRole("navigation", { name: translate("shell.sidebar") }).getByRole("list", { name: translate("projects.title"), exact: true })
    .getByRole("button", { name: new RegExp(`^${translate("sidebar.toggleProject")}:`) }).evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")!.split(": ")[1]));
  const starredOrder = async (target: Page) => {
    const list = target.getByRole("navigation", { name: translate("shell.sidebar") }).getByRole("list", { name: translate("sidebar.starred"), exact: true });
    if (await list.count() === 0) return [];
    return await list.getByRole("button", { name: new RegExp(`^${translate("sidebar.toggleProject")}:`) }).evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")!.split(": ")[1]));
  };

  // The sidebar updates after the write is cached, so an order check waits up to 5 seconds for the expected list.
  const expectOrder = async (target: Page, expected: string[], message: string, starred = false) => {
    const read = () => starred ? starredOrder(target) : projectOrder(target);
    let got: string[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      got = await read();
      if (JSON.stringify(got) === JSON.stringify(expected)) return;
      await Bun.sleep(100);
    }
    throw new Error(`${message}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Order Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/actions/create_workspace")), page.getByRole("button", { name: translate("workspace.create") }).click()]);
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  for (const [name, key] of [["Alpha", "ALP"], ["Beta", "BET"], ["Gamma", "GAM"]] as const) await call("create_project", { workspaceId, name, key, visibility: "public" });
  await page.reload();
  await page.getByRole("button", { name: `${translate("sidebar.toggleProject")}: Gamma` }).waitFor();

  // Never ordered: by name, and no Starred group.
  await expectOrder(page, ["Alpha", "Beta", "Gamma"], `default order is not by name: ${await projectOrder(page)}`, false);
  check(await page.getByRole("list", { name: translate("sidebar.starred"), exact: true }).count() === 0, "Starred group shows while empty");

  // Star Gamma from the sidebar: the Starred group appears on top, and the star has a label.
  const starGamma = sidebar().getByRole("button", { name: `${translate("sidebar.star")}: Gamma` });
  check(await starGamma.getAttribute("title") === translate("sidebar.star"), "star has no tooltip");
  await starGamma.click();
  await sidebar().getByRole("button", { name: `${translate("sidebar.unstar")}: Gamma` }).waitFor();
  await expectOrder(page, ["Gamma"], "starred project is not in the Starred group", true);
  await page.screenshot({ path: `${shots}/desktop-starred-1440.png` });

  // Move Beta up through the project's menu.
  await sidebar().getByRole("button", { name: `${translate("sidebar.projectOptions")}: Beta` }).click();
  await sidebar().getByRole("group", { name: `${translate("sidebar.projectOptions")}: Beta` }).getByRole("button", { name: translate("sidebar.moveUp"), exact: true }).click();
  await expectOrder(page, ["Beta", "Alpha"], `Move up did not reorder: ${await projectOrder(page)}`, false);

  // Keyboard: focus Alpha and press Up; focus stays on Alpha.
  await sidebar().getByRole("button", { name: `${translate("sidebar.toggleProject")}: Alpha` }).focus();
  await page.keyboard.press("ArrowUp");
  await expectOrder(page, ["Alpha", "Beta"], "ArrowUp did not move Alpha", false);
  check(await sidebar().getByRole("button", { name: `${translate("sidebar.toggleProject")}: Alpha` }).evaluate((element) => element === document.activeElement), "focus left Alpha after the arrow key move");

  // Drag: Beta onto Alpha takes Alpha's place (HTML5 drag events, as a browser sends them).
  await page.evaluate(() => {
    const row = (name: string) => [...document.querySelectorAll<HTMLElement>("nav li")].find((li) => li.querySelector(`[aria-label^="Toggle project menu: ${name}"]`))!;
    const data = new DataTransfer();
    row("Beta").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    row("Alpha").dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
    row("Alpha").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await page.waitForTimeout(300);
  await expectOrder(page, ["Beta", "Alpha"], `drag did not reorder: ${await projectOrder(page)}`, false);

  // Expanded menus are stored on the server: open Beta, reload, and it stays open.
  await sidebar().getByRole("button", { name: `${translate("sidebar.toggleProject")}: Beta` }).click();
  await page.reload();
  check(await sidebar().getByRole("button", { name: `${translate("sidebar.toggleProject")}: Beta` }).getAttribute("aria-expanded") === "true", "expanded menu did not survive reload");

  // A second session (same person, other browser) shows the same order, stars and expanded menu.
  const second = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await second.addCookies(await context.cookies());
  const secondPage = await second.newPage();
  await secondPage.goto(web);
  await secondPage.getByRole("button", { name: `${translate("sidebar.toggleProject")}: Beta` }).waitFor();
  await expectOrder(secondPage, ["Beta", "Alpha"], "second session has a different order", false);
  await expectOrder(secondPage, ["Gamma"], "second session has different stars", true);
  check(await secondPage.getByRole("button", { name: `${translate("sidebar.toggleProject")}: Beta` }).getAttribute("aria-expanded") === "true", "second session lost the expanded menu");
  await second.close();

  // Reset order: name order again, stars stay.
  await sidebar().getByRole("button", { name: translate("sidebar.resetOrder"), exact: true }).click();
  await sidebar().getByRole("button", { name: `${translate("sidebar.toggleProject")}: Beta` }).waitFor();
  await expectOrder(page, ["Alpha", "Beta"], `reset did not restore name order: ${await projectOrder(page)}`, false);
  await expectOrder(page, ["Gamma"], "reset order removed a star", true);

  // Unstar Gamma: the Starred group hides when empty.
  await sidebar().getByRole("button", { name: `${translate("sidebar.unstar")}: Gamma` }).click();
  await page.getByRole("list", { name: translate("sidebar.starred"), exact: true }).waitFor({ state: "detached" });
  console.log("project order ok: stars, move, keyboard, drag, server state, reset");

  // The project list has the same star: it toggles the sidebar's Starred group.
  await page.goto(`${web}/${slug}/projects`);
  const listStar = page.locator("main").getByRole("button", { name: `${translate("sidebar.star")}: Beta` });
  check(await listStar.getAttribute("title") === translate("sidebar.star"), "project list star has no tooltip");
  await listStar.click();
  await page.locator("main").getByRole("button", { name: `${translate("sidebar.unstar")}: Beta` }).waitFor();
  await expectOrder(page, ["Beta"], "starring from the project list did not reach the sidebar", true);
  await page.locator("main").getByRole("button", { name: `${translate("sidebar.unstar")}: Beta` }).click();
  await page.locator("main").getByRole("button", { name: `${translate("sidebar.star")}: Beta` }).waitFor();
  console.log("project order ok: star from the project list");

  // Phone: the same order from the settings page, with no drag.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/settings/project-order`);
  await page.getByRole("button", { name: `${translate("sidebar.moveDown")}: Alpha` }).click();
  await page.getByRole("button", { name: `${translate("sidebar.star")}: Gamma` }).click();
  await page.getByRole("button", { name: `${translate("sidebar.unstar")}: Gamma` }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: `${translate("sidebar.unstar")}: Gamma` }).waitFor();
  check(await page.getByRole("button", { name: `${translate("sidebar.moveDown")}: Alpha` }).isDisabled(), "phone settings page did not keep the saved order after reload");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "phone settings page overflows horizontally");
  await page.screenshot({ path: `${shots}/phone-settings-390.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.screenshot({ path: `${shots}/phone-settings-390-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`${web}/${slug}/settings/project-order`);
  await page.getByRole("button", { name: `${translate("sidebar.unstar")}: Gamma` }).waitFor();
  await page.screenshot({ path: `${shots}/tablet-settings-768.png` });
  console.log("project order ok: phone settings page");

  console.log("e2e project-order: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
  await failurePage?.screenshot({ path: `${shots}/failure.png` }).catch(() => {});
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
