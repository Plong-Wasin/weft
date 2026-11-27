// Ticket 04: Sheet focus/dismissal and viewport fit at the two widths where the phone drawer is available.
import { launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { mkdirSync } from "node:fs";
import { translate } from "../packages/shared/src";
import { WeftClient, seedWeft } from "../tools/visual/weft-client";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 33140);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 35140);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web, { stdout: "ignore" }),
  startWeb(webPort, { api }),
];

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  await seedWeft(client, slug);
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
  await context.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));
  const page = await context.newPage();
  const shots = ".local/shots/shadcn-04";
  mkdirSync(shots, { recursive: true });
  const menu = page.getByRole("button", { name: translate("shell.openMenu") });
  const drawer = page.getByRole("dialog", { name: translate("shell.sidebar") });
  const capture = async (width: number, height: number) => {
    await page.setViewportSize({ width, height });
    await menu.click();
    await drawer.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-slot="sheet-content"]')?.getBoundingClientRect().x === 0);
    const bounds = await drawer.boundingBox();
    if (!bounds || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > width || bounds.y + bounds.height > height) {
      throw new Error(`Sheet is clipped at ${width}x${height}: ${JSON.stringify(bounds)}`);
    }
    const close = drawer.getByRole("button", { name: translate("shell.closeMenu") });
    const closeBounds = await close.boundingBox();
    if (!closeBounds || closeBounds.width < 44 || closeBounds.height < 44) throw new Error("Sheet close target is below 44px");
    if (await drawer.evaluate((element) => getComputedStyle(element).overflowY) !== "auto") throw new Error("Sheet does not scroll its content internally");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: `${shots}/drawer-${width}x${height}-${theme}.png` });
    }
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    if (!(await menu.evaluate((element) => element === document.activeElement))) throw new Error("Escape did not restore focus to the drawer trigger");
  };

  await page.goto(`${web}/${slug}/projects/REF/issues`);
  await capture(390, 844);
  await capture(667, 375);
  await context.close();
  await browser.close();
  console.log("shadcn 04 Sheet: viewport fit, touch close target, internal scrolling and Escape focus return passed at 390x844 and 667x375");
} finally {
  for (const server of servers) server.kill();
}
