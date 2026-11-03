import { expect, test } from "bun:test";
import { getPopoverPosition } from "../src/shell/popover";

const viewport = { width: 800, height: 600 };

test("popover sits below its trigger when there is room", () => {
  expect(getPopoverPosition({ left: 100, right: 140, top: 100, bottom: 120 }, { width: 220, height: 160 }, viewport, "left"))
    .toEqual({ left: 100, top: 124, maxHeight: "468px" });
});

test("popover flips above its trigger near the bottom edge", () => {
  expect(getPopoverPosition({ left: 100, right: 140, top: 520, bottom: 540 }, { width: 220, height: 160 }, viewport, "left"))
    .toEqual({ left: 100, top: 356, maxHeight: "508px" });
});

test("right aligned popover stays inside the viewport", () => {
  expect(getPopoverPosition({ left: 760, right: 790, top: 100, bottom: 120 }, { width: 220, height: 160 }, viewport, "right"))
    .toEqual({ left: 570, top: 124, maxHeight: "468px" });
});

test("popover height fits the larger side when neither side fits the full panel", () => {
  expect(getPopoverPosition({ left: 100, right: 140, top: 200, bottom: 220 }, { width: 220, height: 500 }, viewport, "left"))
    .toEqual({ left: 100, top: 224, maxHeight: "368px" });
});
