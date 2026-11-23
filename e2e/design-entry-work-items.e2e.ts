// Browser end-to-end flow for ticket 12 (design fixes: entry, home and work item surfaces).
// Each finding of the baseline report in this area has a check here:
// - work-items-list at 390px: the toolbar (view switcher, Select shown, Filters, Query, Display, Save as view) fits in two rows, not three.
// - work-items-list at 1440px: the toolbar stays on one row.
// - work-item-page at 390px: the quick property chips and the action buttons form two-column rows, so no row holds a lone chip.
// - every route of this area at both widths: no page-level horizontal scroll, and no toolbar, chip or action control clips its own text.
// Run with `bun e2e/run-all.ts design-entry` (needs DATABASE_URL, CHROMIUM_PATH, E2E_API_PORT, E2E_WEB_PORT).
import { chromium, type Page } from "playwright";
import { translate } from "../packages/shared/src";
import { WeftClient, seedWeft } from "../tools/visual/weft-client";
import { fillPath, loadRoutes } from "../tools/visual/lib";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3120);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5220);
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

/**
 * Counts the children of a container per visual row. A child joins the first row whose vertical band it overlaps,
 * so items centred on a shared line count as one row even when their tops differ.
 * `spec` is a CSS selector for the container, or `parent of <selector>` for the parent of the matched element.
 */
function rowsIn(page: Page, spec: string): Promise<number[]> {
  return page.evaluate((input) => {
    const parentOf = input.startsWith("parent of ");
    const selector = parentOf ? input.slice("parent of ".length) : input;
    const match = document.querySelector(selector);
    const box = parentOf ? match?.parentElement ?? null : match;
    const bands: Array<{ top: number; bottom: number; count: number }> = [];
    for (const child of Array.from(box?.children ?? [])) {
      const rect = child.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const band = bands.find((b) => rect.top < b.bottom - 2 && rect.bottom > b.top + 2);
      if (band) { band.count += 1; band.top = Math.min(band.top, rect.top); band.bottom = Math.max(band.bottom, rect.bottom); }
      else bands.push({ top: rect.top, bottom: rect.bottom, count: 1 });
    }
    return bands.sort((a, b) => a.top - b.top).map((b) => b.count);
  }, spec);
}

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  const seed = await seedWeft(client, slug);
  const { viewports, routes } = loadRoutes();
  const areaRoutes = routes.filter((r) => ["auth-sign-in", "workspace-home", "work-items-list", "work-item-page", "archives", "workspace-views"].includes(r.name));
  check(areaRoutes.length === 6, "the area's six routes are missing from the manifest");

  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const switchLabel = translate("layout.switch");
  const actionsLabel = translate("workItems.actions");
  const quickLabel = translate("workItems.quickProperties");

  await Promise.all(viewports.map(async (viewport) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "light", reducedMotion: "reduce" });
    await context.addCookies(client.cookies().map((c) => ({ ...c, domain: "localhost", path: "/" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const route of areaRoutes) {
      const path = fillPath(route.weft!, seed)!;
      const signedOut = route.auth === false ? await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } }) : null;
      const target = signedOut ? await signedOut.newPage() : page;
      await target.goto(`${web}${path}`, { waitUntil: "load" });
      await target.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
      await target.waitForTimeout(300);

      const overflow = await target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `${route.name} at ${viewport.width}px scrolls the page sideways by ${overflow}px`);

      // No toolbar, chip or action control clips its own text (its content is wider than its box).
      const clipped = await target.evaluate(() => Array.from(document.querySelectorAll("[role=tablist] ~ * button, [role=group] button, [data-quick-properties] > *"))
        .filter((el) => el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent?.trim() ?? ""));
      check(clipped.length === 0, `${route.name} at ${viewport.width}px clips controls: ${clipped.join(", ")}`);

      if (route.name === "work-items-list") {
        const rows = await rowsIn(target, `parent of [role="tablist"][aria-label="${switchLabel}"]`);
        const limit = viewport.width < 768 ? 2 : 1;
        check(rows.length <= limit, `work-items-list at ${viewport.width}px: toolbar takes ${rows.length} rows [${rows.join(", ")}] (limit ${limit})`);
        check(await target.getByRole("button", { name: translate("views.saveAs") }).isVisible(), `work-items-list at ${viewport.width}px hides Save as view`);
      }

      if (route.name === "work-item-page" && viewport.width < 768) {
        const chipRows = await rowsIn(target, `[data-quick-properties][aria-label="${quickLabel}"]`);
        check(chipRows.length > 0 && chipRows.every((count) => count === 2), `work-item-page at ${viewport.width}px quick properties rows: [${chipRows.join(", ")}] (want two per row)`);
        const actionRows = await rowsIn(target, `[role="group"][aria-label="${actionsLabel}"]`);
        check(actionRows.length > 0 && actionRows.every((count) => count === 2), `work-item-page at ${viewport.width}px action rows: [${actionRows.join(", ")}] (want two per row)`);
      }
      if (signedOut) await signedOut.close();
    }
    check(errors.length === 0, `page errors at ${viewport.width}px: ${errors.slice(0, 3).join(" | ")}`);
    await context.close();
  }));

  await browser.close();
  console.log("design-entry-work-items e2e ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
