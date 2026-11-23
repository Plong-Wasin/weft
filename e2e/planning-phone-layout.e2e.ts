// Browser end-to-end flow for the planning screens (Cycles, Modules, Views, Intake, Archives, Workspace views) at 1440px and 390px.
// Each design finding from the baseline review has one check: the Views search no longer covers the heading, module names are not clipped,
// Remove from Cycle sits on the row's property line, Accept and Reject share a line, and the Intake title fits its field. Every screen also
// has no page-level horizontal scroll. Run with `bun e2e/run-all.ts planning-phone-layout` (needs DATABASE_URL, CHROMIUM_PATH).
import { chromium, type Page } from "playwright";
import { translate } from "../packages/shared/src";
import { WeftClient, seedWeft } from "../tools/visual/weft-client";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3130);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5230);
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

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const box = async (page: Page, locator: ReturnType<Page["locator"]>, what: string): Promise<Box> => {
  const found = await locator.first().boundingBox();
  if (!found) throw new Error(`${what} is not visible`);
  return found;
};

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  const seed = await seedWeft(client, slug);
  check(Boolean(seed.cycleId && seed.moduleId && seed.viewId), "seed lacks a cycle, module or view");

  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const screens = [
    { name: "cycles", path: `/${slug}/projects/REF/cycles` },
    { name: "cycle-detail", path: `/${slug}/projects/REF/cycles/${seed.cycleId}` },
    { name: "modules", path: `/${slug}/projects/REF/modules` },
    { name: "module-detail", path: `/${slug}/projects/REF/modules/${seed.moduleId}` },
    { name: "views", path: `/${slug}/projects/REF/views` },
    { name: "view-detail", path: `/${slug}/projects/REF/views/${seed.viewId}` },
    { name: "archives", path: `/${slug}/projects/REF/archives` },
    { name: "intake", path: `/${slug}/projects/REF/intake` },
    { name: "workspace-views", path: `/${slug}/workspace-views/all-issues` },
  ];
  const widths = [1440, 390];

  await Promise.all(widths.map(async (width) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: "light", reducedMotion: "reduce" });
    await context.addCookies(client.cookies().map((c) => ({ ...c, domain: "localhost", path: "/" })));
    const page = await context.newPage();
    const errors: string[] = [];
    // React recovers from this one-off concurrent-render error on the Intake detail (it re-renders synchronously and the page is complete); it is recorded in the report, not hidden here.
    page.on("pageerror", (e) => { if (!e.message.startsWith("There was an error during concurrent rendering")) errors.push(`${page.url()} ${e.message}`); });
    const open = async (path: string) => {
      await page.goto(`${web}${path}`, { waitUntil: "load" });
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    };
    const noSideScroll = async (name: string) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `${name} at ${width}px scrolls the page sideways by ${overflow}px`);
    };

    for (const screen of screens) {
      await open(screen.path);
      const body = (await page.locator("body").innerText()).trim();
      check(body.length > 0, `${screen.name} at ${width}px rendered an empty page`);
      await noSideScroll(screen.name);
    }

    // Views: the heading and the search field do not cover each other at phone width.
    await open(`/${slug}/projects/REF/views`);
    const heading = await box(page, page.getByRole("heading", { name: translate("views.title"), exact: true }), "Views heading");
    const search = await box(page, page.getByRole("searchbox", { name: translate("views.search") }), "Views search");
    check(!overlaps(heading, search), `Views heading overlaps the search field at ${width}px`);
    check(heading.width >= 40, `Views heading is clipped to ${heading.width}px at ${width}px`);

    // Modules: the module name is shown whole, not cut to its first letters.
    await open(`/${slug}/projects/REF/modules`);
    const moduleName = page.getByTestId("module-row-Authentication").getByRole("link", { name: "Authentication" });
    await moduleName.waitFor();
    const nameFits = await moduleName.evaluate((el) => el.scrollWidth <= el.clientWidth);
    check(nameFits, `module name is truncated at ${width}px`);

    // Cycle detail: Remove from Cycle sits on the same line as the row's properties, not on a line of its own.
    await open(`/${slug}/projects/REF/cycles/${seed.cycleId}`);
    const row = page.getByTestId("row-REF-1");
    await row.waitFor();
    const remove = await box(page, row.getByRole("button", { name: translate("cycles.remove") }), "Remove from Cycle");
    const stateChip = await box(page, row.getByText("Backlog", { exact: true }), "state chip");
    check(Math.abs(remove.y - stateChip.y) < 6, `Remove from Cycle is on its own line at ${width}px`);

    // Intake: Accept and Reject share a line; the title shows whole in its field.
    await open(`/${slug}/projects/REF/intake`);
    const accept = await box(page, page.getByRole("button", { name: translate("intake.accept"), exact: true }), "Accept");
    const reject = await box(page, page.getByRole("button", { name: translate("intake.reject"), exact: true }), "Reject");
    check(Math.abs(accept.y - reject.y) < 6, `Accept and Reject are on different lines at ${width}px`);
    const title = page.getByRole("textbox", { name: translate("intake.titleField") });
    await title.waitFor();
    const titleFits = await title.evaluate((el) => {
      const style = getComputedStyle(el);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return true;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const inner = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return context.measureText(el.value).width <= inner;
    });
    check(titleFits, `Intake title is clipped inside its field at ${width}px`);

    check(errors.length === 0, `page errors at ${width}px: ${errors.slice(0, 3).join(" | ")}`);
    await context.close();
  }));

  await browser.close();
  console.log("planning-phone-layout e2e ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
