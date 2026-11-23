/** A top-level Wiki block as the page draws it: its document position and size, and its viewport top and bottom. */
export type BlockSpan = { pos: number; size: number; top: number; bottom: number };

/** An insertion boundary in the document, and the viewport y of the line drawn there. */
export type DropBoundary = { pos: number; top: number };

/** How far from the top or bottom of the scroll area auto-scroll starts, in pixels. */
const EDGE = 48;
const FAST_STEP = 24;
const FULL_SLOW_STEP = 4;
const REDUCED_STEP = 6;

/**
 * The boundary nearest the pointer's vertical position. The candidates are the top and bottom edge of every top-level block, so a
 * pointer in a gap snaps to the closer of the two blocks around it, above the first block means before it and below the last means
 * after it. Only y counts: the element under the pointer is irrelevant, so the gutter and the margins work too.
 */
export function dropBoundary(blocks: readonly BlockSpan[], y: number): DropBoundary | null {
  let best: DropBoundary | null = null;
  let bestDistance = Infinity;
  for (const block of blocks) {
    for (const candidate of [{ pos: block.pos, top: block.top }, { pos: block.pos + block.size, top: block.bottom }]) {
      const distance = Math.abs(y - candidate.top);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Pixels to scroll this frame while a drag's pointer sits near the top or bottom of the scroll area (negative scrolls up).
 * The step grows the nearer the pointer is to the edge. With reduced motion the step is capped at a slow pace.
 */
export function autoScrollStep(pointerY: number, area: { top: number; bottom: number }, reducedMotion: boolean): number {
  const intensity = (depth: number) => Math.min(1, Math.max(0, depth / EDGE));
  if (pointerY < area.top + EDGE) {
    const step = FULL_SLOW_STEP + intensity(area.top + EDGE - pointerY) * (FAST_STEP - FULL_SLOW_STEP);
    return -Math.round(reducedMotion ? Math.min(step, REDUCED_STEP) : step);
  }
  if (pointerY > area.bottom - EDGE) {
    const step = FULL_SLOW_STEP + intensity(pointerY - (area.bottom - EDGE)) * (FAST_STEP - FULL_SLOW_STEP);
    return Math.round(reducedMotion ? Math.min(step, REDUCED_STEP) : step);
  }
  return 0;
}
