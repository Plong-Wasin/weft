// Viewport audit across the documented desktop, tablet and landscape phone sizes.
// Each named check below corresponds to the viewport issue's no-scroll, visible-control,
// touch-target, overlay-fit and blank-tap acceptance checks.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";
import { WeftClient, seedWeft } from "../tools/visual/weft-client";
import { fillPath, loadRoutes } from "../tools/visual/lib";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 33150);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 35150);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true", VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];
const viewports = [
  { suffix: "1440x900", width: 1440, height: 900 },
  { suffix: "1024x768", width: 1024, height: 768 },
  { suffix: "820x1180", width: 820, height: 1180 },
  { suffix: "768x1024", width: 768, height: 1024 },
  { suffix: "844x390", width: 844, height: 390 },
  { suffix: "667x375", width: 667, height: 375 },
  { suffix: "390x844", width: 390, height: 844 },
];
const checks = new Set<string>();
// Failures are collected, not thrown at once, so one run lists every defect with its screenshot.
const failures: string[] = [];
const check = (name: string, ok: unknown, detail = "") => {
  checks.add(name);
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};
async function waitFor(url: string) {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const slug = `viewport-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  const seed = await seedWeft(client, slug);
  const cookie = client.cookies().map(({ name, value }) => `${name}=${value}`).join("; ");
  const me = await (await fetch(`${api}/api/me`, { headers: { cookie } })).json() as { workspaces: Array<{ id: string }> };
  const projects = await client.action<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id });
  const emptyWorkItem = await client.action<{ displayId: string }>("create_work_item", { projectId: projects[0]!.id, title: "Touch empty properties" });
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const root = Bun.env.VIEWPORT_SHOTS_DIR ?? join(import.meta.dir, "..", ".local", "shots", "shadcn-09", "after");
  await mkdir(root, { recursive: true });
  const { routes } = loadRoutes();
  const layoutRoutes = ["list", "board", "spreadsheet", "calendar", "gantt"].map((layout) => ({ name: `work-items-${layout}`, auth: true, weft: `/${slug}/projects/${seed.key}/issues?layout=${layout}` }));
  const extraRoutes = [
    { name: "projects", auth: true, weft: `/${slug}/projects` },
    { name: "inbox", auth: true, weft: `/${slug}/notifications` },
    { name: "work-item-peek", auth: true, weft: `/${slug}/projects/${seed.key}/issues?layout=list&peek=${encodeURIComponent(seed.workItem)}` },
    { name: "auth-sign-up", auth: false, weft: "/" },
  ];
  const captures = [...routes.filter((route) => route.weft && fillPath(route.weft, seed)).map((route) => ({ name: route.name, auth: route.auth !== false, weft: fillPath(route.weft!, seed)! })), ...layoutRoutes, ...extraRoutes];

  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "light", reducedMotion: "reduce" });
    await context.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));
    const page = await context.newPage();
    for (const route of captures) {
      const authContext = route.auth ? null : await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "light", reducedMotion: "reduce" });
      const target = authContext ? await authContext.newPage() : page;
      await target.goto(`${web}${route.weft}`, { waitUntil: "domcontentloaded" });
      await target.locator("body").waitFor();
      if (route.name === "auth-sign-up") await target.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
      await target.waitForTimeout(100);
      const measurements = await target.evaluate(() => {
        const main = document.querySelector("main");
        const primary = main ? [...main.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([type="hidden"])')].find((el) => {
          const style = getComputedStyle(el), rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
        }) : undefined;
        const box = primary?.getBoundingClientRect();
        return {
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          primary: box ? { x: box.x, y: box.y, right: box.right, bottom: box.bottom } : null,
          topControls: [...document.querySelectorAll<HTMLElement>("main button, main a[href], main input:not([type=hidden]), main select")].map((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return { tag: el.tagName, id: el.id, label: el.getAttribute("aria-label"), text: el.textContent?.trim(), className: el.className, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 };
          }).filter((rect) => rect.visible && rect.y < 160 && rect.bottom > 0),
          siblingControlOverlap: [...document.querySelectorAll<HTMLElement>("main [role=group]")].some((group) => {
            const controls = [...group.querySelectorAll<HTMLElement>("button, a[href]")].filter((el) => el.parentElement === group && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
            for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
              const a = controls[i]!.getBoundingClientRect(), b = controls[j]!.getBoundingClientRect();
              if (a.width && a.height && b.width && b.height && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) return true;
            }
            return false;
          }),
          bodyText: (document.body.innerText ?? "").trim().length,
        };
      });
      check("rendered-screen", measurements.bodyText > 0, `${route.name} at ${viewport.suffix} was empty`);
      check("no-horizontal-page-scroll", measurements.pageWidth <= measurements.viewportWidth, `${route.name} at ${viewport.suffix}: ${measurements.pageWidth}px > ${measurements.viewportWidth}px`);
      check("top-controls-not-clipped", measurements.topControls.every((control) => control.x >= 0 && control.right <= viewport.width && control.bottom <= viewport.height),
        `${route.name} at ${viewport.suffix}: ${JSON.stringify(measurements.topControls.filter((control) => control.x < 0 || control.right > viewport.width || control.bottom > viewport.height))}`);
      if (route.name === "work-items-list" && (viewport.suffix === "390x844" || viewport.suffix === "844x390")) {
        const listMetrics = await target.evaluate(() => {
          const list = document.querySelector<HTMLElement>('[data-testid="work-items-list-container"]');
          const rows = [...(list?.querySelectorAll<HTMLElement>("[data-list-row]") ?? [])];
          const metadata = rows.map((row) => row.querySelector<HTMLElement>('[data-testid="work-item-row-metadata"]'));
          return {
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            listRight: list?.getBoundingClientRect().right ?? null,
            listClientWidth: list?.clientWidth ?? null,
            listScrollWidth: list?.scrollWidth ?? null,
            rowsOverflow: rows.map((row) => row.scrollWidth > row.clientWidth + 1),
            metadataOverflow: metadata.map((item) => item ? item.scrollWidth > item.clientWidth + 1 : true),
          };
        });
        check("work-items-list-page-width-fits", listMetrics.documentWidth <= listMetrics.viewportWidth, `Work items at ${viewport.suffix}: ${JSON.stringify(listMetrics)}`);
        check("work-items-list-content-fits", listMetrics.listRight !== null && listMetrics.listRight <= listMetrics.viewportWidth && listMetrics.listScrollWidth !== null && listMetrics.listClientWidth !== null && listMetrics.listScrollWidth <= listMetrics.listClientWidth + 1 && listMetrics.rowsOverflow.every((overflow) => !overflow) && listMetrics.metadataOverflow.every((overflow) => !overflow), `Work item rows and property chips at ${viewport.suffix}: ${JSON.stringify(listMetrics)}`);
      }
      if (route.name === "work-items-list" && viewport.suffix === "844x390") {
        // Save as view stays on landscape phones; it must share a toolbar row with another control rather than wrap alone.
        const saveViewTop = await target.getByRole("button", { name: translate("views.saveAs") }).evaluate((element) => {
          const box = element.getBoundingClientRect();
          const toolbar = element.closest('[data-testid="work-items-toolbar"]');
          const others = [...(toolbar?.querySelectorAll<HTMLElement>("button, a[href]") ?? [])].filter((other) => other !== element && !other.contains(element) && !element.contains(other) && other.getClientRects().length > 0);
          return { visible: box.width > 0 && getComputedStyle(element).visibility !== "hidden", sharesRow: others.some((other) => { const r = other.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - (box.top + box.height / 2)) <= 2; }) };
        });
        check("work-items-list-save-view-kept", saveViewTop.visible && saveViewTop.sharesRow, `landscape phone keeps Save as view in a shared toolbar row: ${JSON.stringify(saveViewTop)}`);
      }
      check("no-sibling-control-overlap", !measurements.siblingControlOverlap, `${route.name} at ${viewport.suffix} has overlapping sibling controls`);
      if (route.auth && measurements.primary) {
        check("primary-control-visible", measurements.primary.x >= 0 && measurements.primary.right <= viewport.width && measurements.primary.y < viewport.height && measurements.primary.bottom > 0,
          `${route.name} at ${viewport.suffix}: ${JSON.stringify(measurements.primary)}`);
      }
      await target.screenshot({ path: join(root, `${route.name}-${viewport.suffix}.png`) });
      if (authContext) await authContext.close();
    }
    await page.close();
    await context.close();
  }

  // Touch regression: the formerly invisible empty Module slot at the right of the row must not open its picker.
  for (const viewport of [
    { suffix: "1024x768", width: 1024, height: 768 },
    { suffix: "820x1180", width: 820, height: 1180 },
    { suffix: "844x390", width: 844, height: 390 },
  ]) {
    const touchContext = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true, colorScheme: "light" });
    await touchContext.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));
    const touch = await touchContext.newPage();
    await touch.goto(`${web}/${slug}/projects/${seed.key}/issues?layout=list`, { waitUntil: "domcontentloaded" });
    await touch.getByTestId(`row-${emptyWorkItem.displayId}`).waitFor();
    const firstRow = touch.getByTestId(`row-${emptyWorkItem.displayId}`);
    const moduleTrigger = firstRow.getByRole("button", { name: /^Modules/ }).first();
    check("touch-empty-module-slot-hidden", !(await moduleTrigger.isVisible()), `empty Module control remains visible at ${viewport.suffix}`);
    const stateTrigger = firstRow.getByRole("button", { name: /^State:/ }).first();
    const stateMetrics = await stateTrigger.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hitArea = getComputedStyle(element, "::before");
      return { visualHeight: rect.height, hitHeight: parseFloat(hitArea.height), hitWidth: parseFloat(hitArea.width) };
    });
    check("touch-filled-chip-target-44px", stateMetrics.visualHeight <= 36 && stateMetrics.hitHeight >= 44 && stateMetrics.hitWidth >= 44, `State chip metrics at ${viewport.suffix}: ${JSON.stringify(stateMetrics)}`);
    // Real hit testing: the 4 corners and 4 edge midpoints, 1px inside the 44x44 square centred on the chip, resolve to the chip.
    const stateMisses = await stateTrigger.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      return [[-21, -21], [0, -21], [21, -21], [21, 0], [21, 21], [0, 21], [-21, 21], [-21, 0]].flatMap(([dx, dy]) => {
        const hit = document.elementFromPoint(cx + dx!, cy + dy!);
        return hit && (hit === element || element.contains(hit)) ? [] : [{ dx, dy, hit: hit?.tagName ?? null }];
      });
    });
    check("touch-filled-chip-hit-44px", stateMisses.length === 0, `State chip 44px area misses taps at ${viewport.suffix}: ${JSON.stringify(stateMisses)}`);
    const rowBox = await firstRow.boundingBox();
    check("touch-row-present", !!rowBox, `seed row has no visible bounds at ${viewport.suffix}`);
    // The last property slot can contain Assignee at wider widths, so the trailing edge is not reliably blank.
    if (rowBox) await touch.touchscreen.tap(Math.round(rowBox.x + rowBox.width - 2), Math.round(rowBox.y + rowBox.height / 2));
  check("touch-blank-row-does-not-open-menu", await touch.locator("[data-popover-panel]:visible").count() === 0 && touch.url().includes("/issues?layout=list"), `blank row tap opened a menu or peek panel at ${viewport.suffix}`);
    await touch.screenshot({ path: join(root, `work-item-list-touch-${viewport.suffix}.png`) });
    await touchContext.close();
  }

  // Display popovers must stay inside the short visible area and scroll their contents internally.
  for (const viewport of [{ suffix: "844x390", width: 844, height: 390 }, { suffix: "667x375", width: 667, height: 375 }]) {
    const shortContext = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true });
    await shortContext.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));
    const shortPage = await shortContext.newPage();
    await shortPage.goto(`${web}/${slug}/projects/${seed.key}/issues?layout=list`, { waitUntil: "domcontentloaded" });
    await shortPage.getByRole("button", { name: translate("layout.display") }).click();
    const displayPanel = shortPage.getByRole("dialog", { name: translate("layout.display") });
    const panelBox = await displayPanel.boundingBox();
    check("short-height-popover-fits", !!panelBox && panelBox.x >= 0 && panelBox.y >= 0 && panelBox.x + panelBox.width <= viewport.width && panelBox.y + panelBox.height <= viewport.height,
      `display panel bounds at ${viewport.suffix}: ${JSON.stringify(panelBox)}`);
    check("short-height-popover-scrolls-internally", await displayPanel.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto"), `display panel does not scroll internally at ${viewport.suffix}`);
    await displayPanel.screenshot({ path: join(root, `display-popover-touch-${viewport.suffix}.png`) });
    await shortPage.keyboard.press("Escape");
    const stateTrigger = shortPage.getByTestId(`row-${seed.workItem}`).getByRole("button", { name: /^State:/ }).first();
    await stateTrigger.tap();
    // SingleSelect renders its accessible picker as a dialog; role="menu" belongs to the nested option list.
    const propertyMenu = shortPage.locator('[data-popover-panel][role="dialog"]');
    const menuBox = await propertyMenu.boundingBox();
    check("short-height-menu-fits", !!menuBox && menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= viewport.width && menuBox.y + menuBox.height <= viewport.height,
      `property menu bounds at ${viewport.suffix}: ${JSON.stringify(menuBox)}`);
    await propertyMenu.screenshot({ path: join(root, `property-menu-touch-${viewport.suffix}.png`) });
    await shortPage.keyboard.press("Escape");
    await shortPage.getByRole("button", { name: translate("workItems.addNew"), exact: true }).tap();
    const createDialog = shortPage.getByRole("dialog", { name: translate("workItems.modal.title") });
    const dialogBox = await createDialog.boundingBox();
    check("short-height-dialog-fits", !!dialogBox && dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= viewport.width && dialogBox.y + dialogBox.height <= viewport.height,
      `create dialog bounds at ${viewport.suffix}: ${JSON.stringify(dialogBox)}`);
    check("short-height-dialog-scrolls-internally", await createDialog.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto"), `create dialog does not scroll internally at ${viewport.suffix}`);
    await createDialog.screenshot({ path: join(root, `create-item-dialog-touch-${viewport.suffix}.png`) });
    await shortContext.close();
  }

  const drawerContext = await browser.newContext({ viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true });
  await drawerContext.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));
  const drawerPage = await drawerContext.newPage();
  await drawerPage.goto(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  await drawerPage.getByRole("button", { name: translate("shell.openMenu") }).tap();
  const drawer = drawerPage.getByRole("dialog", { name: translate("shell.sidebar") });
  await drawerPage.waitForFunction(() => { const el = document.querySelector('[role="dialog"]'); if (!el) return false; const r = el.getBoundingClientRect(); return r.x >= 0 && r.width > 0; }, undefined, { timeout: 5000 });
  const drawerBox = await drawer.boundingBox();
  check("short-height-drawer-fits", !!drawerBox && drawerBox.x >= 0 && drawerBox.y >= 0 && drawerBox.x + drawerBox.width <= 667 && drawerBox.y + drawerBox.height <= 375,
    `drawer bounds ${JSON.stringify(drawerBox)}`);
  await drawerPage.screenshot({ path: join(root, "sidebar-drawer-touch-667x375.png") });
  await drawerContext.close();
  await browser.close();
  console.log(`viewport checks: ${[...checks].join(", ")}`);
  if (failures.length) throw new Error(`${failures.length} viewport defect(s):\n${failures.join("\n")}`);
} finally {
  for (const server of servers) server.kill();
}
