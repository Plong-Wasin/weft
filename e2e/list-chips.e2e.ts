// Browser end-to-end flow for the empty property chips of a list row: hidden until the row is hovered or focused on hover-capable screens, always shown on touch.
// Run with `bun e2e/list-chips.e2e.ts` (set DATABASE_URL to use your own database).
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
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
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Chips Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  await call("create_work_item", { projectId: project!.id, title: "Alpha" });
  const listUrl = `${web}/${slug}/projects/MOB/issues`;

  /** The list reserves a stable slot for the empty chip, then reveals it on hover or focus. */
  const wrapper = async (row: import("playwright").Locator, property: string) => await row.getByRole("button", { name: new RegExp(`^${property}:`) }).evaluate((button) => {
    const node = button.parentElement?.parentElement as HTMLElement;
    const style = getComputedStyle(node);
    return { opacity: style.opacity, pointerEvents: style.pointerEvents };
  });
  const priority = translate("workItems.priority");

  // Desktop (hover-capable): the empty Priority chip is out of sight until the row is hovered or focused.
  await page.goto(listUrl);
  const row = page.getByTestId("row-MOB-1");
  await row.waitFor();
  const layoutSwitch = page.getByRole("group", { name: translate("layout.switch") });
  const boardSwitch = layoutSwitch.getByRole("button", { name: translate("layout.board") });
  check(await layoutSwitch.getByRole("tab").count() === 0, "the layout switcher should not expose incomplete tab semantics");
  check(await layoutSwitch.getByRole("button", { pressed: true }).getAttribute("aria-label") === translate("layout.list"), "the current layout should be announced as pressed");
  await boardSwitch.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("board").waitFor();
  check(await boardSwitch.getAttribute("aria-pressed") === "true", "keyboard activation should switch layouts and update the pressed state");
  await page.goto(listUrl);
  await page.getByTestId("row-MOB-1").waitFor();
  await page.mouse.move(0, 0);
  const emptyProperties = [priority, translate("workItems.assignees"), translate("workItems.labels")];
  for (const property of emptyProperties) {
    const hidden = await wrapper(row, property);
    check(hidden.opacity === "0" && hidden.pointerEvents === "none", `${property} chip should be hidden on desktop (${JSON.stringify(hidden)})`);
  }
  await row.hover();
  for (const property of emptyProperties) {
    const shown = await wrapper(row, property);
    check(shown.opacity === "1" && shown.pointerEvents === "auto", `hovering the row should reveal ${property} chip (${JSON.stringify(shown)})`);
  }
  await page.mouse.move(0, 0);
  for (const property of emptyProperties) {
    const hidden = await wrapper(row, property);
    check(hidden.opacity === "0" && hidden.pointerEvents === "none", `${property} chip should hide again when the pointer leaves`);
  }
  await row.getByRole("checkbox").click();
  await page.mouse.move(0, 0);
  const hiddenAfterCheckbox = await wrapper(row, priority);
  check(hiddenAfterCheckbox.opacity === "0" && hiddenAfterCheckbox.pointerEvents === "none", "clicking the row checkbox then moving away should hide the empty chip");
  // The checkbox still has focus from the click; Tab is a real keyboard move, so the link is focus-visible.
  await page.keyboard.press("Tab");
  const shownOnFocus = await wrapper(row, priority);
  check(shownOnFocus.opacity === "1" && shownOnFocus.pointerEvents === "auto", `focusing into the row should reveal the empty chip (${JSON.stringify(shownOnFocus)})`);
  // The Priority chip is the next keyboard stop after the focused title link.
  await page.keyboard.press("Tab");
  const activeAfterTabs = await page.evaluate(() => ({ label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.textContent }));
  check(activeAfterTabs.label?.startsWith("Priority") || activeAfterTabs.text?.includes("Priority") || false, `Tab should reach the Priority chip (${JSON.stringify(activeAfterTabs)})`);
  console.log("list-chips ok: desktop hides until hover or focus");

  // Touch: there is no hover, so every chip shows.
  const touch = await browser.newContext({ storageState: await context.storageState(), hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const touchPage = await touch.newPage();
  await touchPage.goto(listUrl);
  const touchRow = touchPage.getByTestId("row-MOB-1");
  await touchRow.waitFor();
  // The narrow layout removes empty Assignees and Labels slots to preserve room for the title.
  for (const property of [priority]) {
    const box = await wrapper(touchRow, property);
    check(box.opacity === "1" && box.pointerEvents === "auto", `${property} chip should be visible on touch (${JSON.stringify(box)})`);
  }
  console.log("list-chips ok: touch shows the empty Priority chip");
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
