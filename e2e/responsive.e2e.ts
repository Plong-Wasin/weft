// Browser end-to-end flow: every in-scope screen in tools/visual/routes.json has a Weft route, renders at 1440px and 390px without
// page-level horizontal scroll, and the 390px shell collapses to a drawer.
// Run with `bun e2e/responsive.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL, CHROMIUM_PATH).
import { chromium } from "playwright";
import { join } from "node:path";
import { translate } from "../packages/shared/src";
import { WeftClient, seedWeft } from "../tools/visual/weft-client";
import { fillPath, loadRoutes } from "../tools/visual/lib";
import { reviewShots } from "../tools/visual/paths";

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

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  const seed = await seedWeft(client, slug);
  const { viewports, routes } = loadRoutes();

  // Every screen in scope has a Weft route and every placeholder in it resolves from the seed.
  const missing = routes.filter((r) => !r.weft || !fillPath(r.weft, seed)).map((r) => r.name);
  check(missing.length === 0, `no Weft route or seed value for: ${missing.join(", ")}`);

  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const shots = reviewShots("20-responsive-and-final-sweep");
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "light", reducedMotion: "reduce" });
    await context.addCookies(client.cookies().map((c) => ({ ...c, domain: "localhost", path: "/" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const route of routes) {
      const path = fillPath(route.weft!, seed)!;
      const context2 = route.auth === false ? await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } }) : null;
      const target = context2 ? await context2.newPage() : page;
      await target.goto(`${web}${path}`, { waitUntil: "load" });
      await target.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
      await target.waitForTimeout(300);
      const body = (await target.locator("body").innerText()).trim();
      check(body.length > 0, `${route.name} at ${viewport.width}px rendered an empty page`);
      check(!/Unexpected Application Error|Cannot read propert|is not a function/.test(body), `${route.name} at ${viewport.width}px shows an error: ${body.slice(0, 120)}`);
      const overflow = await target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `${route.name} at ${viewport.width}px scrolls the page sideways by ${overflow}px`);
      if (viewport.width < 768 && route.auth !== false) {
        check(await target.getByRole("button", { name: translate("shell.openMenu") }).isVisible(), `${route.name} at ${viewport.width}px has no menu button`);
        check(!(await target.getByRole("dialog", { name: translate("shell.sidebar") }).isVisible()), `${route.name} at ${viewport.width}px shows the drawer closed state wrongly`);
      }
      if (route.name === "work-items-list") await target.screenshot({ path: join(shots, `${route.name}-${viewport.suffix}.png`) });
      if (context2) await context2.close();
    }
    check(errors.length === 0, `page errors at ${viewport.width}px: ${errors.slice(0, 3).join(" | ")}`);

    if (viewport.width < 768) {
      // The drawer opens from the top bar and carries the projects navigation.
      await page.goto(`${web}/${slug}/projects/REF/issues`);
      await page.getByRole("button", { name: translate("shell.openMenu") }).click();
      const drawer = page.getByRole("dialog", { name: translate("shell.sidebar") });
      await drawer.waitFor();
      check(await drawer.getByRole("link", { name: translate("cycles.activeTitle") }).isVisible(), "drawer lacks the Active cycles link");
      await page.getByRole("button", { name: translate("shell.closeMenu") }).last().click();
      await drawer.waitFor({ state: "hidden" });
    }
    await context.close();
  }

  await browser.close();
  console.log("responsive e2e ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
