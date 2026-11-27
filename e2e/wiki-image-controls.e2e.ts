// Wiki image control usability on desktop and touch-sized mobile viewports.
import { check, launchBrowser, newContext, startApi, startLive, startWeb, waitFor } from "./harness";
import { like } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31161);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52161);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31163);
const api = `http://localhost:${apiPort}`; const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startLive(livePort, web),
  startWeb(webPort, { api, live: `ws://localhost:${livePort}` }),
];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const { client, db } = createDatabase(); let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web); await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Wiki Image Tester"); await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password"); await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Image controls"); await page.getByLabel(translate("workspace.slug")).fill(slug); await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.goto(`${web}/${slug}/wiki`); await page.getByRole("main").getByRole("button", { name: translate("wiki.new") }).click(); await page.locator(".ProseMirror").waitFor();
  await page.locator('[data-testid="inline-image-input"]').setInputFiles({ name: "mobile.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  const image = page.locator(".ProseMirror .asset-image-node"); await image.waitFor();
  await page.waitForFunction(() => Boolean((document.querySelector(".asset-image-node img") as HTMLImageElement | null)?.naturalWidth));
  const handle = image.getByRole("button", { name: translate("assets.resizeImage") }); await handle.focus(); await page.keyboard.press("ArrowRight");
  const widthAfterKeyboard = await image.locator("img").evaluate((el) => (el as HTMLImageElement).style.width);
  check(Boolean(widthAfterKeyboard), "keyboard resize must update image width");
  for (const [key, alignment] of [["assets.alignLeft", "left"], ["assets.alignCenter", "center"], ["assets.alignRight", "right"]] as const) {
    await image.getByRole("button", { name: translate(key) }).click(); check(await image.getAttribute("data-alignment") === alignment, `alignment control failed: ${alignment}`);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await image.scrollIntoViewIfNeeded();
  const layout = await page.evaluate(() => { const controls = document.querySelector<HTMLElement>(".asset-image-controls")!; const box = controls.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, target: controls.querySelector("button")!.getBoundingClientRect().height }; });
  check(layout.left >= 0 && layout.right <= 390, "mobile controls must fit the viewport"); check(layout.scrollWidth <= layout.clientWidth, "mobile image controls must not create page overflow"); check(layout.target >= 44, "image controls must have touch-sized targets");
  const resize = image.getByRole("button", { name: translate("assets.resizeImage") });
  await resize.focus(); await page.keyboard.press("ArrowLeft"); check(Boolean(await image.locator("img").evaluate((el) => (el as HTMLImageElement).style.width)), "mobile keyboard resize did not work");
  await image.getByRole("button", { name: translate("assets.fullScreen") }).tap(); const viewer = page.locator("dialog.asset-image-viewer"); await viewer.waitFor();
  await viewer.getByRole("button", { name: translate("assets.zoomIn") }).tap(); await viewer.getByRole("button", { name: translate("assets.closeViewer") }).tap(); await viewer.waitFor({ state: "detached" });
  await page.locator("body").click({ position: { x: 20, y: 110 } });
  await page.getByTestId("wiki-bubble-menu").waitFor({ state: "hidden" });
  const screenshotDir = "/home/plong/workspace/weft/.local/ai-ux-follow-up/09"; await mkdir(screenshotDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 }); await saveShot(page, { path: `${screenshotDir}/wiki-image-controls-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await saveShot(page, { path: `${screenshotDir}/wiki-image-controls-mobile.png`, fullPage: true });
  await browser.close(); console.log("wiki image controls: touch, keyboard, alignment, resize, viewer dismissal, and responsive bounds passed");
} catch (error) { failed = true; console.error(error); }
finally { for (const server of servers) server.kill(); await db.delete(workspaces).where(like(workspaces.slug, "e2e-%")); await db.delete(users).where(like(users.email, "e2e-%@example.test")); await client.end(); }
process.exit(failed ? 1 : 0);
