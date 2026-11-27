// Browser end-to-end flow: an archived work item shows on the project Archives page, newest archive first, and Restore from its row removes it.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import type { Page } from "playwright";
import { like } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31143);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52143);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 } }, api, web, {
    account: { name: "Archive Tester", email: `${slug}@example.test` },
    workspace: { name: "E2E team", slug },
    project: { name: "Mobile", key: "MOB", visibility: "public", shape: "full" },
  });
  const page = await context.newPage();
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); if (!response.ok()) throw new Error(`${name} failed: ${response.status()}`); return await response.json() as T; };
  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const states = await call<Array<{ id: string; group: string }>>("list_states", { projectId: project!.id });
  const done = states.find((state) => state.group === "completed")!.id;
  const make = (title: string) => call<{ id: string; displayId: string }>("create_work_item", { projectId: project!.id, title, stateId: done });
  const first = await make("Old job"); const second = await make("Newer job"); const open = await call<{ id: string }>("create_work_item", { projectId: project!.id, title: "Still open" });
  const longTitle = "unbrokenarchiveworkitemtitle".repeat(7);
  const longTitleItem = await make(longTitle);
  await call("archive_work_item", { workItemId: first.id });
  await Bun.sleep(20);
  await call("archive_work_item", { workItemId: longTitleItem.id });
  await Bun.sleep(20);
  await call("archive_work_item", { workItemId: second.id });

  const t = (key: string) => translate(key as never);
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("navigation", { name: new RegExp(t("projectNav.label")) }).getByRole("link", { name: t("projectNav.archives") }).click();
  await page.waitForURL(`**/projects/MOB/archives`);
  const rows = page.locator("[data-testid^=archived-row-]");
  await rows.first().waitFor();
  const screenshotDir = reviewShots("07-archives");
  await mkdir(screenshotDir, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(100);
    const restore = rows.first().getByRole("button", { name: t("archives.restore") });
    const target = await restore.boundingBox();
    check(target !== null, `Restore control is not visible at ${width}px`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `Archives page scrolls horizontally by ${overflow}px at ${width}px`);
    if (width === 390) {
      check(target!.height >= 44 && target!.width >= 44, `Restore target is only ${Math.round(target!.width)}x${Math.round(target!.height)}px at ${width}px`);
      const longTitleLink = page.getByRole("link", { name: longTitle, exact: true });
      const titleLayout = await longTitleLink.evaluate((element) => {
        const style = getComputedStyle(element);
        return { fits: element.scrollWidth <= element.clientWidth, wraps: element.clientHeight > parseFloat(style.lineHeight), right: element.getBoundingClientRect().right };
      });
      check(titleLayout.fits && titleLayout.wraps, `Unbroken archived work item title does not wrap within its row at ${width}px`);
      check(titleLayout.right <= width, `Unbroken archived work item title extends past the ${width}px viewport`);
    }
    await saveShot(page, { path: `${screenshotDir}/archives-${width}.png`, fullPage: true });
    console.log(`archives render ${width}px: Restore ${Math.round(target!.width)}x${Math.round(target!.height)}px; page overflow ${overflow}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  check(await rows.count() === 3, "the Archives page does not list exactly the archived items");
  check((await rows.first().innerText()).includes("Newer job"), "newest archive is not first");
  check(await page.getByText("Still open").count() === 0, "an item that is not archived is listed");
  await rows.first().getByRole("button", { name: t("archives.restore") }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid^=archived-row-]").length === 2);
  const back = await call<{ archivedAt: string | null }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: second.displayId });
  check(back.archivedAt === null, "Restore did not clear the archive time");
  await rows.first().getByRole("button", { name: t("archives.restore") }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid^=archived-row-]").length === 1);
  await rows.first().getByRole("button", { name: t("archives.restore") }).click();
  await page.getByText(t("archives.empty")).waitFor();

  // Cycles and Modules tabs: an ended Cycle and a completed Module, restored from their tabs.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const cycle = await call<{ id: string }>("create_cycle", { projectId: project!.id, name: "Old sprint", startDate: day(-20), endDate: day(-10) });
  const mod = await call<{ id: string }>("create_module", { projectId: project!.id, name: "Old topic" });
  await call("update_module", { moduleId: mod.id, status: "completed" });
  await call("archive_cycle", { cycleId: cycle.id }); await call("archive_module", { moduleId: mod.id });
  await page.reload();
  const tab = (name: string) => page.getByRole("tab", { name });
  const workItemsTab = tab(t("archives.workItems"));
  await workItemsTab.focus();
  await page.keyboard.press("ArrowRight");
  check(await tab(t("archives.cycles")).evaluate((element) => element === document.activeElement), "ArrowRight did not move focus to the next Archives tab");
  check(await tab(t("archives.cycles")).getAttribute("aria-selected") === "true", "ArrowRight did not select the focused Archives tab");
  check(await page.getByRole("tab").evaluateAll((elements) => elements.filter((element) => (element as HTMLElement).tabIndex === 0).length === 1), "more than one Archives tab is in the page tab order");
  await page.keyboard.press("End");
  check(await tab(t("archives.modules")).evaluate((element) => element === document.activeElement), "End did not move focus to the last Archives tab");
  await page.keyboard.press("Home");
  check(await workItemsTab.evaluate((element) => element === document.activeElement), "Home did not move focus to the first Archives tab");
  await tab(t("archives.cycles")).click();
  await page.getByText("Old sprint").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const cycleRow = page.locator(`[data-testid="archived-row-${cycle.id}"]`);
  const cycleDate = await cycleRow.locator("span").boundingBox();
  const cycleRestore = await cycleRow.getByRole("button", { name: t("archives.restore") }).boundingBox();
  check(cycleDate !== null && cycleRestore !== null, "dated Cycle row is missing its date or Restore control");
  check(Math.abs((cycleDate!.y + cycleDate!.height / 2) - (cycleRestore!.y + cycleRestore!.height / 2)) < 2 && cycleRestore!.x > cycleDate!.x, "dated Cycle Restore is not aligned beside the date on the same mobile row");
  check(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth), "dated Cycle row scrolls the page horizontally at 390px");
  await saveShot(page, { path: `${screenshotDir}/archives-cycle-dated-390.png`, fullPage: true });

  // Render the resolved Guest project role while retaining the fixture's Admin API session.
  await call("archive_work_item", { workItemId: longTitleItem.id });
  const readOnly = await context.newPage();
  await readOnly.setViewportSize({ width: 390, height: 844 });
  await readOnly.route(`${api}/actions/get_project`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json() as Record<string, unknown>, role: "Guest" } });
  });
  await readOnly.goto(`${web}/${slug}/projects/MOB/archives`);
  const readOnlyRows = readOnly.locator("[data-testid^=archived-row-]");
  await readOnlyRows.first().waitFor();
  check(await readOnlyRows.count() === 1 && await readOnlyRows.getByRole("button").count() === 0, "Guest sees a Restore control on an archived work item");
  await readOnly.getByRole("tab", { name: t("archives.cycles") }).click();
  const readOnlyCycleRow = readOnly.locator(`[data-testid="archived-row-${cycle.id}"]`);
  await readOnlyCycleRow.waitFor();
  check(await readOnlyCycleRow.getByRole("button").count() === 0, "Guest sees a Restore control on an archived Cycle");
  await readOnly.getByRole("tab", { name: t("archives.modules") }).click();
  const readOnlyModuleRow = readOnly.locator(`[data-testid="archived-row-${mod.id}"]`);
  await readOnlyModuleRow.waitFor();
  check(await readOnlyModuleRow.getByRole("button").count() === 0, "Guest sees a Restore control on an archived Module");
  await saveShot(readOnly, { path: `${screenshotDir}/archives-read-only-390.png`, fullPage: true });
  await readOnly.close();
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: t("archives.restore") }).click();
  await page.getByText(t("archives.emptyCycles")).waitFor();
  check((await call<Array<{ id: string }>>("list_cycles", { projectId: project!.id })).some((row) => row.id === cycle.id), "restored Cycle is not back in the Cycles list");
  await page.goto(`${web}/${slug}/projects/MOB/cycles`);
  await page.getByRole("tab", { name: /Completed/ }).click();
  await page.getByText("Old sprint").waitFor();
  await page.goto(`${web}/${slug}/projects/MOB/archives`);
  await tab(t("archives.modules")).click();
  await page.getByText("Old topic").waitFor();
  await page.getByRole("button", { name: t("archives.restore") }).click();
  await page.getByText(t("archives.emptyModules")).waitFor();
  check((await call<Array<{ id: string }>>("list_modules", { projectId: project!.id })).some((row) => row.id === mod.id), "restored Module is not back in the Modules list");
  await page.goto(`${web}/${slug}/projects/MOB/modules`);
  await page.getByText("Old topic").waitFor();
  // Turning the features off hides the tabs.
  await call("set_project_features", { projectId: project!.id, features: { cycles: false, modules: false } });
  await page.goto(`${web}/${slug}/projects/MOB/archives`);
  await tab(t("archives.workItems")).waitFor();
  check(await page.getByRole("tab").count() === 1, "tabs of a feature that is off are still shown");
  console.log("e2e archives: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  // The flow commits real rows (the servers use their own connections), so remove them: other tests expect an empty instance.
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
