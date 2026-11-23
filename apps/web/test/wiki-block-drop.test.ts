import { expect, test } from "bun:test";
import { autoScrollStep, dropBoundary, type BlockSpan } from "../src/wiki-block-drop";

// Three top-level blocks: A at 100-140, B at 150-200 (a 10px gap above it), C at 200-230 (touching B).
const blocks: BlockSpan[] = [
  { pos: 0, size: 10, top: 100, bottom: 140 },
  { pos: 10, size: 12, top: 150, bottom: 200 },
  { pos: 22, size: 8, top: 200, bottom: 230 },
];

test("a pointer above the first block drops before it and a pointer below the last drops after it, far outside any text", () => {
  expect(dropBoundary(blocks, 20)).toEqual({ pos: 0, top: 100 });
  expect(dropBoundary(blocks, 900)).toEqual({ pos: 30, top: 230 });
});

test("a pointer in a gap snaps to the nearest edge of the blocks around it", () => {
  expect(dropBoundary(blocks, 146)).toEqual({ pos: 10, top: 150 }); // nearer the top of B: before B
  expect(dropBoundary(blocks, 143)).toEqual({ pos: 10, top: 140 }); // nearer the bottom of A: after A
});

test("a pointer inside a block snaps to whichever of its edges is nearer", () => {
  expect(dropBoundary(blocks, 115)).toEqual({ pos: 0, top: 100 });
  expect(dropBoundary(blocks, 125)).toEqual({ pos: 10, top: 140 });
  expect(dropBoundary(blocks, 205)).toEqual({ pos: 22, top: 200 });
  expect(dropBoundary(blocks, 222)).toEqual({ pos: 30, top: 230 });
});

test("no blocks means no drop boundary", () => {
  expect(dropBoundary([], 10)).toBeNull();
});

test("auto-scroll moves only inside the top or bottom edge of the scroll area", () => {
  const area = { top: 0, bottom: 800 };
  expect(autoScrollStep(400, area, false)).toBe(0);
  expect(autoScrollStep(400, area, true)).toBe(0);
  expect(autoScrollStep(10, area, false)).toBeLessThan(0);
  expect(autoScrollStep(790, area, false)).toBeGreaterThan(0);
});

test("auto-scroll speeds up nearer the edge, and reduced motion caps it at a slow step", () => {
  const area = { top: 0, bottom: 800 };
  expect(Math.abs(autoScrollStep(2, area, false))).toBeGreaterThan(Math.abs(autoScrollStep(40, area, false)));
  expect(Math.abs(autoScrollStep(2, area, true))).toBeLessThanOrEqual(6);
  expect(Math.abs(autoScrollStep(2, area, false))).toBeGreaterThan(6);
});
