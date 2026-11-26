// Browser end-to-end flow: every in-scope screen in tools/visual/routes.json has a Weft route, renders at 1440px and 390px without
// page-level horizontal scroll, and the 390px shell collapses to a drawer.
// Run with `bun e2e/responsive.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL, CHROMIUM_PATH).
import { chromium, expect, type Page } from "playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { translate } from "../packages/shared/src";
import { WeftClient, seedWeft } from "../tools/visual/weft-client";
import { fillPath, loadRoutes } from "../tools/visual/lib";
import { reviewShots } from "../tools/visual/paths";

// The AI route is gated by the presence of a provider key. This flow only opens it.
Bun.env.OPENAI_API_KEY ??= "sk-e2e-placeholder-no-call";

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

  const readyOn = (target: Page, route: string) => {
    const main = target.getByRole("main");
    const heading = (name: string) => main.getByRole("heading", { name, exact: true });
    const content: Record<string, () => ReturnType<typeof heading>> = {
      "auth-sign-in": () => target.getByRole("button", { name: translate("auth.signIn"), exact: true }),
      "workspace-home": () => heading(translate("projects.title")),
      "work-items-list": () => main.getByRole("link", { name: /Set up CI pipeline/ }).first(),
      "work-item-page": () => main.getByRole("textbox", { name: translate("workItems.titleField"), exact: true }),
      "cycles": () => main.getByRole("link", { name: "Sprint 1", exact: true }),
      "cycle-detail": () => heading("Sprint 1"),
      "modules": () => main.getByText("Authentication", { exact: true }).first(),
      "module-detail": () => main.getByRole("navigation", { name: translate("workItems.breadcrumb") }).getByText("Authentication", { exact: true }),
      "views": () => main.getByRole("link", { name: "High priority", exact: true }),
      "view-detail": () => main.getByText("High priority", { exact: true }).filter({ visible: true }).first(),
      "pages": () => main.getByRole("link", { name: "Getting started", exact: true }),
      "archives": () => heading(translate("archives.title")),
      "intake": () => main.getByText("Customer asks for CSV export", { exact: true }),
      "workspace-views": () => main.getByTestId("workspace-view-header"),
      "workspace-settings": () => heading(translate("settings.workspaceTitle")),
      "workspace-members": () => heading(translate("members.title")),
      "project-settings": () => heading(translate("settings.general")),
      "project-states": () => heading(translate("states.title")),
      "project-estimates": () => heading(translate("estimates.title")),
      "project-labels": () => heading(translate("labels.title")),
      "project-features": () => heading(translate("settings.features")),
      "wiki-list": () => heading(translate("wiki.title")),
      "wiki-page": () => heading("Getting started"),
      "analytics-overview": () => heading(translate("analytics.projectList")),
      "analytics-work-items": () => heading(translate("analytics.createdVsResolved")),
      "ai-chat": () => heading(translate("ai.heading")),
    };
    if (!content[route]) throw new Error(`Missing route-specific readiness assertion for ${route}`);
    return content[route]();
  };

  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const shots = reviewShots("20-responsive-and-final-sweep");
  // The viewports are independent (a context and page each), so they run side by side: this flow was the longest of the suite.
  await Promise.all(viewports.map(async (viewport) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "light", reducedMotion: "reduce" });
    await context.addCookies(client.cookies().map((c) => ({ ...c, domain: "localhost", path: "/" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`${e.message} at ${page.url()}: ${e.stack ?? "no stack"}`));
    for (const route of routes) {
      const path = fillPath(route.weft!, seed)!;
      const context2 = route.auth === false ? await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } }) : null;
      const target = context2 ? await context2.newPage() : page;
      await target.goto(`${web}${path}`, { waitUntil: "load" });
      await readyOn(target, route.name).waitFor({ timeout: 15_000 }).catch((cause) => {
        throw new Error(`${route.name} at ${viewport.width}px did not render its route-specific content`, { cause });
      });
      if (route.name === "work-item-page") {
        await expect(readyOn(target, route.name), "the work item page shows its seeded title").toHaveValue("Set up CI pipeline");
      }
      const body = (await target.locator("body").innerText()).trim();
      check(body.length > 0, `${route.name} at ${viewport.width}px rendered an empty page`);
      check(!/Unexpected Application Error|Cannot read propert|is not a function/.test(body), `${route.name} at ${viewport.width}px shows an error: ${body.slice(0, 120)}`);
      const overflow = await target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `${route.name} at ${viewport.width}px scrolls the page sideways by ${overflow}px`);
      if (viewport.width < 768 && route.auth !== false) {
        check(await target.getByRole("button", { name: translate("shell.openMenu") }).isVisible(), `${route.name} at ${viewport.width}px has no menu button`);
        check(!(await target.getByRole("dialog", { name: translate("shell.sidebar") }).isVisible()), `${route.name} at ${viewport.width}px shows the drawer closed state wrongly`);
      }
      if (route.name === "work-items-list") {
        await target.screenshot({ path: join(shots, `${route.name}-${viewport.suffix}-light.png`) });
        await target.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        await target.screenshot({ path: join(shots, `${route.name}-${viewport.suffix}-dark.png`) });
        await target.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      }
      if (context2) await context2.close();
    }
    check(errors.length === 0, `page errors at ${viewport.width}px: ${errors.slice(0, 3).join(" | ")}`);

    if (viewport.width < 768) {
      // The drawer opens from the top bar and carries the projects navigation.
      await page.goto(`${web}/${slug}/projects/REF/issues`);
      await page.getByRole("button", { name: translate("shell.openMenu") }).click();
      const drawer = page.getByRole("dialog", { name: translate("shell.sidebar") });
      await drawer.waitFor();
      await page.waitForFunction(() => document.querySelector('[data-slot="sheet-content"]')?.getBoundingClientRect().x === 0);
      check(await drawer.getByRole("link", { name: translate("cycles.activeTitle") }).isVisible(), "drawer lacks the Active cycles link");
      const drawerClose = drawer.getByRole("button", { name: translate("shell.closeMenu") });
      const drawerCloseBounds = await drawerClose.boundingBox();
      check(!!drawerCloseBounds && drawerCloseBounds.width >= 44 && drawerCloseBounds.height >= 44, "phone drawer close control is below a 44px touch target");
      const ticketShots = ".local/shots/shadcn-04";
      mkdirSync(ticketShots, { recursive: true });
      await page.screenshot({ path: join(ticketShots, "drawer-390-light.png") });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.screenshot({ path: join(ticketShots, "drawer-390-dark.png") });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.keyboard.press("Tab");
      check(await drawer.evaluate((element) => element.contains(document.activeElement)), "Tab moved focus outside the phone drawer");
      await page.keyboard.press("Shift+Tab");
      check(await drawer.evaluate((element) => element.contains(document.activeElement)), "Shift+Tab moved focus outside the phone drawer");
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
      check(await page.getByRole("button", { name: translate("shell.openMenu") }).evaluate((element) => element === document.activeElement), "Escape did not restore focus to the menu button");
      await page.getByRole("button", { name: translate("shell.openMenu") }).click();
      await drawer.waitFor();
      await page.locator('[data-slot="sheet-overlay"]').click({ position: { x: 370, y: 400 } });
      await drawer.waitFor({ state: "hidden" });
      await page.setViewportSize({ width: 667, height: 375 });
      const landscapeMenu = page.getByRole("button", { name: translate("shell.openMenu") });
      await landscapeMenu.click();
      await drawer.waitFor();
      await page.waitForFunction(() => document.querySelector('[data-slot="sheet-content"]')?.getBoundingClientRect().x === 0);
      check(await drawer.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
      }), `phone landscape drawer does not fit the visible viewport: ${JSON.stringify(await drawer.boundingBox())} in ${JSON.stringify(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))}`);
      await page.screenshot({ path: join(ticketShots, "drawer-667x375-light.png") });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.screenshot({ path: join(ticketShots, "drawer-667x375-dark.png") });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
    }
    await context.close();
  }));

  // The new Tooltip is not mounted in the product yet; exercise its keyboard path in an isolated browser root.
  const tooltipContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tooltipPage = await tooltipContext.newPage();
  await tooltipPage.goto(web, { waitUntil: "load" });
  await tooltipPage.evaluate(async () => {
    const [React, ReactDOM, components] = await Promise.all([
      import("/node_modules/.vite/deps/react.js"),
      import("/node_modules/.vite/deps/react-dom_client.js"),
      import("/src/ui/tooltip.tsx"),
    ]);
    document.body.innerHTML = '<div id="tooltip-keyboard-test"></div>';
    const createElement = React.default.createElement;
    const content = createElement(components.TooltipContent, null, "Helpful detail");
    const trigger = createElement(components.TooltipTrigger, {
      delay: 0,
      render: createElement("button", { type: "button", "aria-label": "Keyboard help" }, "Help"),
    });
    const tooltip = createElement(components.Tooltip, null, trigger, content);
    ReactDOM.default.createRoot(document.getElementById("tooltip-keyboard-test")!).render(
      createElement(components.TooltipProvider, null, tooltip),
    );
  });
  const tooltipTrigger = tooltipPage.getByRole("button", { name: "Keyboard help" });
  await tooltipPage.evaluate(() => { document.body.tabIndex = 0; document.body.focus(); });
  await tooltipPage.keyboard.press("Tab");
  check(await tooltipTrigger.evaluate((element) => element === document.activeElement), "Tab does not focus the Tooltip trigger");
  check((await tooltipTrigger.evaluate((element) => getComputedStyle(element).outlineWidth)) === "2px", "the Tooltip trigger focus ring is missing");
  const tooltipPopup = tooltipPage.locator('[data-slot="tooltip-trigger"][data-popup-open]');
  await tooltipPopup.waitFor();
  check((await tooltipPage.locator('[data-slot="tooltip-content"]').innerText()) === "Helpful detail", "keyboard focus does not open the Tooltip content");
  await tooltipPage.keyboard.press("Escape");
  await tooltipPopup.waitFor({ state: "hidden" });
  await tooltipContext.close();

  await browser.close();
  console.log("responsive e2e ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
