// Work item narrow layout: a key-property bar under the title in the peek panel and on the full page below 1024 px (beside the description
// from 1024 px it is not shown), a title that wraps at every width, and Properties section headers that are chevron buttons with aria-expanded.
import { chromium, expect, type Locator, type Page } from "playwright/test";
import { controlAppearance } from "./control-appearance";
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
  // Dark theme for the whole flow: the app reads the stored choice on load.
  await page.addInitScript(() => { try { localStorage.setItem("weft.theme", "dark"); } catch { /* storage blocked: the page keeps its default */ } });
  const slug = `narrow-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  // Screenshots for review go to this folder when set; nothing is written into the repository.
  const shots = Bun.env.E2E_SHOTS_DIR;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Narrow Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Narrow layout");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  let me = { user: { id: "" }, workspaces: [] as Array<{ id: string; slug: string }> };
  for (let attempt = 0; attempt < 50 && !me.workspaces?.some((workspace) => workspace.slug === slug); attempt += 1) {
    me = (await (await page.request.get(`${api}/api/me`)).json()) as typeof me;
    if (!me.workspaces?.some((workspace) => workspace.slug === slug)) await Bun.sleep(200);
  }
  check(me.workspaces.some((workspace) => workspace.slug === slug), "the new workspace is not listed by /api/me");
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const project = await createProjectActions(db).createProject.handler({ userId: me.user.id }, { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  await createWorkItemActions(db).createWorkItem.handler({ userId: me.user.id }, { projectId: project.id, title: "Alpha" });

  const labelOf = (key: string) => translate(key, "en");
  const bar = (scope: Page | Locator) => scope.getByRole("group", { name: labelOf("workItems.quickProperties"), exact: true });
  const barPicker = (scope: Page | Locator, key: string) => bar(scope).getByRole("button", { name: new RegExp(`^${labelOf(key)}:`) });
  const sidebar = () => page.getByRole("complementary", { name: labelOf("workItems.properties"), exact: true }).last();
  const sidebarPicker = (key: string) => sidebar().getByRole("button", { name: new RegExp(`^${labelOf(key)}:`) });
  const titleField = () => page.getByLabel(labelOf("workItems.titleField"), { exact: true });
  const pickerKeys = ["workItems.state", "workItems.priority", "workItems.assignees", "workItems.dueDate"] as const;
  const setWidth = async (width: number, height = 900) => { await page.setViewportSize({ width, height }); await page.waitForTimeout(150); };
  const waitText = async (locator: Locator, text: string, message: string) => {
    for (let attempt = 0; attempt < 60; attempt += 1) { if ((await locator.innerText()).includes(text)) return; await Bun.sleep(100); }
    throw new Error(`${message}: ${await locator.innerText()}`);
  };
  const longTitle = "Session expires while the mobile release plan is still waiting for review from the platform and design teams";

  // Full page at 900 px: the bar sits under the title, above the description, and shows the same values as the Properties section.
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  await page.getByRole("navigation", { name: translate("workItems.breadcrumb") }).getByText("MOB-1", { exact: true }).waitFor();
  await expect(titleField(), "MOB-1 detail is paired with its seeded title").toHaveValue("Alpha");
  await sidebar().waitFor();
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await setWidth(900);
  check(await bar(page).isVisible(), "the key-property bar must show under the title on the full page at 900 px");
  const titleBox = await titleField().boundingBox();
  const barBox = await bar(page).boundingBox();
  const descriptionBox = await page.getByTestId("description-editor").boundingBox();
  check(!!titleBox && !!barBox && !!descriptionBox && barBox.y >= titleBox.y + titleBox.height - 1 && barBox.y + barBox.height <= descriptionBox.y + 1, "the bar must sit between the title and the description");
  for (const key of pickerKeys) check(await barPicker(page, key).isVisible(), `the bar at 900 px must hold the ${key} picker`);
  await barPicker(page, "workItems.priority").click();
  await page.getByRole("menuitemradio", { name: labelOf("workItems.priority.urgent"), exact: true }).click();
  await waitText(barPicker(page, "workItems.priority"), labelOf("workItems.priority.urgent"), "the bar's priority did not save");
  await waitText(sidebarPicker("workItems.priority"), labelOf("workItems.priority.urgent"), "the Properties section did not follow the bar's priority");
  await page.keyboard.press("Escape");

  // Beside the description at 1440 px the bar is not shown; the panel carries the fields.
  await setWidth(1440);
  check(!(await bar(page).isVisible()), "the bar must not show beside the description at 1440 px");
  check(await sidebar().isVisible(), "the Properties panel must sit beside the description at 1440 px");

  // The title wraps onto several lines at every width, is not clipped, and the page does not scroll sideways.
  await titleField().fill(longTitle);
  await titleField().press("Enter");
  await page.reload();
  await titleField().waitFor();
  check(await titleField().inputValue() === longTitle, "the long title did not save");
  for (const width of [1440, 900, 768, 390]) {
    await setWidth(width);
    const measured = await titleField().evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        line: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2,
        clipped: element.scrollHeight > element.clientHeight + 1,
        overflowX: element.scrollWidth > element.clientWidth + 1,
        pageScrollsX: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    check(measured.height >= measured.line * 2 - 1, `the title must wrap onto several lines at ${width} px (height ${measured.height})`);
    check(!measured.clipped, `the title is clipped vertically at ${width} px`);
    check(!measured.overflowX, `the title overflows sideways at ${width} px`);
    check(!measured.pageScrollsX, `the page scrolls sideways at ${width} px`);
  }

  // Section headers are buttons with a chevron, aria-expanded, and a visible focus ring in both themes.
  await setWidth(1440);
  const header = (key: string) => sidebar().locator(`[data-props-section="${key}"] > h3 > button`);
  for (const key of ["primary", "more", "details"] as const) {
    const button = header(key);
    check(await button.getAttribute("aria-expanded") === "true", `section ${key} header must report aria-expanded=true when open`);
    check(await button.locator("svg").count() === 1, `section ${key} header must carry a chevron icon`);
  }
  const more = header("more");
  await more.click();
  check(await more.getAttribute("aria-expanded") === "false", "More header must report aria-expanded=false after a click");
  check(!(await sidebar().locator('[data-props-section="more"] > div').first().isVisible()), "a collapsed section must hide its rows");
  await more.focus();
  await page.keyboard.press("Enter");
  check(await more.getAttribute("aria-expanded") === "true", "Enter on the focused header must expand the section");
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await more.blur();
    const blurred = await controlAppearance(more);
    await more.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(async () => {
      const focused = await controlAppearance(more);
      return focused.focusVisible && (
        (focused.outline !== null && focused.outline !== blurred.outline) ||
        focused.rings.some((ring) => !blurred.rings.includes(ring))
      );
    }, { message: `Properties header draws a visible keyboard focus indicator in ${theme}` }).toBe(true);
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));

  // Peek at 1440 px is two columns: the bar is hidden because the Properties column beside the content shows the same four fields.
  await setWidth(1440);
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: "Session expires" }).first().click();
  const widePeek = page.getByRole("dialog", { name: labelOf("workItems.peek.title") });
  await widePeek.waitFor();
  await widePeek.getByRole("complementary", { name: labelOf("workItems.properties"), exact: true }).waitFor();
  check(!(await bar(widePeek).isVisible()), "the peek key-property bar must be hidden at 1440 px, where Properties sits beside the content");
  // Peek panel at 768 px (one column): State, Priority, Assignees and Due date are in view without scrolling and editable from the bar.
  for (const width of [768]) {
    await setWidth(width);
    await page.goto(`${web}/${slug}/projects/MOB/issues`);
    await page.getByRole("link", { name: "Session expires" }).first().click();
    const peek = page.getByRole("dialog", { name: labelOf("workItems.peek.title") });
    await peek.waitFor();
    await bar(peek).waitFor();
    const peekBox = await peek.boundingBox();
    const peekHeader = await peek.locator("header").first().boundingBox();
    check(!!peekBox && !!peekHeader, "the peek panel has no box");
    for (const key of pickerKeys) {
      const box = await barPicker(peek, key).boundingBox();
      check(!!box && box.y >= peekHeader!.y + peekHeader!.height - 1 && box.y + box.height <= peekBox!.y + peekBox!.height + 1, `the peek's ${key} picker is not in view without scrolling at ${width} px`);
    }
    const next = "workItems.priority.medium";
    await barPicker(peek, "workItems.priority").click();
    await page.getByRole("menuitemradio", { name: labelOf(next), exact: true }).click();
    await waitText(barPicker(peek, "workItems.priority"), labelOf(next), `the peek bar's priority did not save at ${width} px`);
    await waitText(peek.getByRole("complementary", { name: labelOf("workItems.properties"), exact: true }).locator("[data-props-section]").first(), labelOf(next), `the peek Properties did not follow the bar at ${width} px`);
    if (shots) await page.screenshot({ path: `${shots}/ticket13-peek-dark-${width}.png` });
    await peek.getByRole("link", { name: labelOf("workItems.peek.expand") }).click();
    await page.waitForURL(`${web}/${slug}/browse/MOB-1`);
    await page.getByRole("navigation", { name: translate("workItems.breadcrumb") }).getByText("MOB-1", { exact: true }).waitFor();
    await expect(titleField(), "expanded MOB-1 keeps the title edited in this flow").toHaveValue(longTitle);
    if (shots) await page.screenshot({ path: `${shots}/ticket13-page-dark-${width}.png`, fullPage: true });
  }
  if (shots) {
    await setWidth(900);
    await page.screenshot({ path: `${shots}/ticket13-page-dark-900.png`, fullPage: true });
    await setWidth(390, 844);
    await page.screenshot({ path: `${shots}/ticket13-page-dark-390.png`, fullPage: true });
  }

  await browser.close();
  console.log("work-item-narrow-layout: bar under title at 900 and hidden at 1440, title wraps at 1440/900/768/390, peek bar in view at 1440/768, section headers are chevron buttons");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  servers.forEach((server) => server.kill());
  await client.end();
}
process.exit(failed ? 1 : 0);
