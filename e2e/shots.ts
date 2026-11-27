import type { Locator, Page } from "playwright";

/** Review screenshots are opt-in: set E2E_SHOTS=1 to write them. */
export const shotsOn = Bun.env.E2E_SHOTS === "1";

/**
 * Writes a screenshot when E2E_SHOTS=1, or always when `failed` says it records a defect.
 * Flows that already ask for a folder or file through a variable of their own call `screenshot` directly.
 */
export async function saveShot(target: Page | Locator, options: Parameters<Page["screenshot"]>[0] & { path: string }, { failed = false } = {}): Promise<void> {
  if (shotsOn || failed) await target.screenshot(options);
}
