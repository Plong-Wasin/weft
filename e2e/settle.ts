import type { Locator, Page } from "playwright";

/** Two animation frames: React has committed and the browser has laid the result out. */
export const frame = (page: Page) => page.evaluate(() => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
));

/**
 * Returns once the screen can be measured: everything in `ready` (data the screen renders) is visible, no loading
 * placeholder is left, the fonts are loaded and two frames have passed.
 */
export async function settle(page: Page, ...ready: Locator[]) {
  for (const locator of ready) await locator.first().waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid$="-skeleton"], main [class*="animate-pulse"], [data-peek] [class*="animate-pulse"]'));
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await frame(page);
}
