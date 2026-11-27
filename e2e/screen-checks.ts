import type { Page } from "playwright";

/**
 * Checks any screen has to pass at any viewport, as one line per defect:
 * - top-controls-not-clipped: no control in the top 160px of the main column reaches past the viewport.
 * - no-sibling-control-overlap: controls of one group do not cover each other.
 * - primary-control-visible: the first control of a signed-in screen's main column is inside the viewport.
 */
export async function screenDefects(page: Page, label: string, { signedIn }: { signedIn: boolean }): Promise<string[]> {
  const viewport = page.viewportSize()!;
  const found = await page.evaluate(() => {
    const shown = (el: HTMLElement) => {
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const primary = [...document.querySelectorAll<HTMLElement>('main button:not([disabled]), main a[href], main input:not([type="hidden"])')].find((el) => {
      const rect = el.getBoundingClientRect();
      return shown(el) && rect.width > 0 && rect.height > 0;
    })?.getBoundingClientRect();
    return {
      primary: primary ? { x: primary.x, y: primary.y, right: primary.right, bottom: primary.bottom } : null,
      topControls: [...document.querySelectorAll<HTMLElement>("main button, main a[href], main input:not([type=hidden]), main select")].filter(shown).map((el) => {
        const rect = el.getBoundingClientRect();
        return { tag: el.tagName, id: el.id, label: el.getAttribute("aria-label"), text: el.textContent?.trim().slice(0, 60), x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
      }).filter((rect) => rect.y < 160 && rect.bottom > 0),
      siblingControlOverlap: [...document.querySelectorAll<HTMLElement>("main [role=group]")].some((group) => {
        const controls = [...group.querySelectorAll<HTMLElement>("button, a[href]")].filter((el) => el.parentElement === group && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
        for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
          const a = controls[i]!.getBoundingClientRect(), b = controls[j]!.getBoundingClientRect();
          if (a.width && a.height && b.width && b.height && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) return true;
        }
        return false;
      }),
    };
  });
  const defects: string[] = [];
  const clipped = found.topControls.filter((control) => control.x < 0 || control.right > viewport.width || control.bottom > viewport.height);
  if (clipped.length) defects.push(`${label} top-controls-not-clipped: ${JSON.stringify(clipped.slice(0, 4))}`);
  if (found.siblingControlOverlap) defects.push(`${label} no-sibling-control-overlap: sibling controls overlap`);
  const { primary } = found;
  if (signedIn && primary && !(primary.x >= 0 && primary.right <= viewport.width && primary.y < viewport.height && primary.bottom > 0)) {
    defects.push(`${label} primary-control-visible: ${JSON.stringify(primary)}`);
  }
  return defects;
}
