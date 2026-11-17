// Work item page Properties panel: three collapsible sections in a fixed order (primary, More, Details), a sticky panel that scrolls
// itself when taller than the screen, a show/hide toggle and collapse state remembered per viewer, and the unchanged peek and
// narrow-screen layout where Properties sit under the description.
import { chromium } from "playwright";
import { createDatabase } from "../packages/db/src";
import { createProjectActions, createWorkItemActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31271);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52271);
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
  const slug = `props-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Properties Writer");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Properties review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  let me = { user: { id: "" }, workspaces: [] as Array<{ id: string; slug: string }> };
  let lastMe: unknown = null;
  for (let attempt = 0; attempt < 50 && !me.workspaces.some((workspace) => workspace.slug === slug); attempt += 1) {
    lastMe = await (await page.request.get(`${api}/api/me`)).json();
    me = lastMe as typeof me;
    if (!me.workspaces?.some((workspace) => workspace.slug === slug)) await Bun.sleep(200);
  }
  check(me.workspaces.some((workspace) => workspace.slug === slug), `the new workspace is not listed by /api/me: ${JSON.stringify(lastMe).slice(0, 300)}`);
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const ownerId = me.user.id;
  const project = await createProjectActions(db).createProject.handler({ userId: ownerId }, { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  const workItems = createWorkItemActions(db);
  const target = await workItems.createWorkItem.handler({ userId: ownerId }, { projectId: project.id, title: "Release plan" });
  // Thirty sub-items make the main column taller than the viewport, so the panel has to stay in view while it scrolls.
  for (let index = 1; index <= 30; index += 1) await workItems.createWorkItem.handler({ userId: ownerId }, { projectId: project.id, title: `Step ${index}`, parentId: target.id });

  const labelOf = (key: string) => translate(key, "en");
  const sidebar = () => page.getByRole("complementary", { name: labelOf("workItems.properties"), exact: true }).last();
  const toggle = () => page.getByTestId("work-item-properties-toggle");
  const sectionOf = (key: string) => sidebar().locator(`[data-props-section="${key}"]`);
  // A section header is a button with aria-expanded; its rows are hidden, not removed, when collapsed.
  const headerOf = (key: string) => sectionOf(key).locator("h3 > button");
  const isOpen = async (key: string) => (await headerOf(key).getAttribute("aria-expanded")) === "true";
  const sectionLabels = { primary: labelOf("workItems.properties.primary"), more: labelOf("workItems.properties.more"), details: labelOf("workItems.properties.details") };
  // The order each section must show, as the catalog labels of its rows. Estimate and Module rows appear only when the project enables them.
  const expected = {
    primary: ["workItems.state", "workItems.priority", "workItems.assignees", "workItems.dueDate", "workItems.labels"],
    more: ["workItems.startDate", "workItems.estimate", "workItems.cycle", "workItems.modules", "workItems.parent"],
    details: ["workItems.createdBy"],
  } as const;
  const rowOrderOk = (text: string, keys: readonly string[]) => {
    const lines = text.split("\n").map((line) => line.trim());
    const positions = keys.map((key) => lines.findIndex((line) => line === labelOf(key) || line.startsWith(`${labelOf(key)}\t`) || line.startsWith(labelOf(key))));
    const present = positions.filter((position) => position >= 0);
    return present.every((position, index) => index === 0 || position > present[index - 1]!) && present.length >= 1;
  };

  await page.goto(`${web}/${slug}/browse/MOB-1`);
  await page.getByRole("heading", { name: "MOB-1" }).waitFor();
  await sidebar().waitFor();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await sidebar().waitFor();

  // Fields appear in the agreed sections and order.
  const sectionKeys = await sidebar().locator("[data-props-section]").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.propsSection));
  check(JSON.stringify(sectionKeys) === JSON.stringify(["primary", "more", "details"]), `sections out of order: ${sectionKeys.join(", ")}`);
  for (const key of ["primary", "more", "details"] as const) {
    const summary = await headerOf(key).innerText();
    check(summary.trim() === sectionLabels[key], `section ${key} is titled "${summary}"`);
    const text = await sectionOf(key).innerText();
    check(rowOrderOk(text, expected[key]), `rows of ${key} are out of the agreed order: ${text}`);
  }
  check(await sectionOf("primary").innerText().then((text) => text.includes(labelOf("workItems.dueDate")) && !text.includes(labelOf("workItems.startDate"))), "Start date must sit in More, not in the primary section");
  check(await sectionOf("details").innerText().then((text) => text.includes(labelOf("workItems.createdBy"))), "Created by must sit in Details");

  // Panel stays in view while the main column scrolls, and scrolls itself when taller than the screen.
  await page.mouse.move(300, 450);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(300);
  const scrolled = await page.evaluate(() => window.scrollY);
  const asideBox = await sidebar().boundingBox();
  check(scrolled > 0 || (asideBox !== null && asideBox.y < 200), "the page did not scroll in the sticky check");
  check(!!asideBox && asideBox.y >= 0 && asideBox.y < 200 && asideBox.y + asideBox.height > 0, `panel left the viewport while the main column scrolled (top ${asideBox?.y})`);
  check(await sidebar().evaluate((node) => getComputedStyle(node).position) === "sticky", "the Properties panel must be sticky on wide screens");
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.waitForTimeout(200);
  check(await sidebar().evaluate((node) => getComputedStyle(node).overflowY) === "auto", "a panel taller than the screen must scroll itself");
  check(await sidebar().evaluate((node) => node.scrollHeight > node.clientHeight), "the panel at 420 px high must overflow and scroll");
  await sidebar().evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const lastRow = await sectionOf("details").innerText();
  check(lastRow.includes(labelOf("workItems.createdBy")), "the last Details row must be reachable by scrolling the panel");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));

  // Show or hide the panel, and remember the choice across reloads.
  check(await toggle().getAttribute("aria-pressed") === "true", "the toggle starts pressed while the panel is shown");
  check(await toggle().getAttribute("title") === labelOf("workItems.properties.hide"), "the open toggle's tooltip must read Hide properties");
  await toggle().click();
  check(!(await sidebar().isVisible()), "the panel must hide when the toggle is pressed");
  check(await toggle().getAttribute("aria-pressed") === "false", "the toggle must release when the panel is hidden");
  check(await toggle().getAttribute("title") === labelOf("workItems.properties.show"), "the closed toggle's tooltip must read Show properties");
  await page.reload();
  await toggle().waitFor();
  check(!(await sidebar().isVisible()), "a hidden panel must stay hidden after reload");
  await toggle().click();
  await sidebar().waitFor();
  await page.reload();
  await sidebar().waitFor();
  check(await sidebar().isVisible(), "a shown panel must stay shown after reload");

  // Collapse state persists per viewer.
  await headerOf("more").click();
  check(!(await isOpen("more")), "More must collapse on click");
  await page.reload();
  await sidebar().waitFor();
  check(!(await isOpen("more")), "the collapsed More section must stay collapsed after reload");
  check(await isOpen("primary"), "Main must stay open");
  await headerOf("more").click();
  await page.waitForFunction(() => localStorage.getItem("weft:work-item-properties-collapsed") === "[]");
  await page.reload();
  await sidebar().waitFor();
  check(await isOpen("more"), "More must reopen and stay open after reload");

  // Peek and narrow screens keep Properties under the description, unsticky and with no toggle.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await sidebar().waitFor();
  check(!(await toggle().isVisible()), "the show/hide toggle must not appear on a narrow screen");
  check(await sidebar().evaluate((node) => getComputedStyle(node).position) !== "sticky", "Properties must not be sticky on a narrow screen");
  const description = await page.getByTestId("description-editor").boundingBox();
  const narrowAside = await sidebar().boundingBox();
  check(!!description && !!narrowAside && narrowAside.y > description.y, "Properties must sit under the description on a narrow screen");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the work item page must not scroll sideways at 390 px");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: "Release plan" }).first().click();
  const peek = page.getByRole("dialog", { name: translate("workItems.peek.title", "en") });
  await peek.waitFor();
  const peekSidebar = peek.getByRole("complementary", { name: labelOf("workItems.properties"), exact: true });
  await peekSidebar.waitFor();
  check(await peekSidebar.evaluate((node) => getComputedStyle(node).position) !== "sticky", "Properties in peek must not be sticky");
  check(rowOrderOk(await peekSidebar.innerText(), expected.primary), "peek Properties must keep the section order");

  // Storage blocked: the panel still renders, toggles and collapses for the visit.
  const blocked = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  await blocked.addInitScript(() => { Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("storage blocked"); } }); });
  await blocked.addCookies(await page.context().cookies());
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(`${web}/${slug}/browse/MOB-1`);
  await blockedPage.getByRole("heading", { name: "MOB-1" }).waitFor();
  const blockedSidebar = blockedPage.getByRole("complementary", { name: labelOf("workItems.properties"), exact: true }).last();
  await blockedSidebar.waitFor();
  await blockedPage.getByTestId("work-item-properties-toggle").click();
  check(!(await blockedSidebar.isVisible()), "the toggle must hide the panel when storage is blocked");
  await blockedPage.getByTestId("work-item-properties-toggle").click();
  await blockedSidebar.locator("[data-props-section='more'] h3 > button").click();
  check(await blockedSidebar.locator("[data-props-section='more'] h3 > button").getAttribute("aria-expanded") === "false", "collapse must work for the visit when storage is blocked");
  await blocked.close();

  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  servers.forEach((server) => server.kill());
  await client.end();
}
process.exit(failed ? 1 : 0);
