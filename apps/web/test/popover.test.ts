import { expect, test } from "bun:test";
import { getPopoverPosition } from "../src/shell/popover";

const viewport = { width: 800, height: 600 };

test("popover sits below its trigger when there is room", () => {
  expect(getPopoverPosition({ left: 100, right: 140, top: 100, bottom: 120 }, { width: 220, height: 160 }, viewport, "left"))
    .toEqual({ left: 100, top: 124, maxHeight: "460px" });
});

test("popover flips above its trigger near the bottom edge", () => {
  expect(getPopoverPosition({ left: 100, right: 140, top: 520, bottom: 540 }, { width: 220, height: 160 }, viewport, "left"))
    .toEqual({ left: 100, top: 356, maxHeight: "500px" });
});

test("right aligned popover stays inside the viewport", () => {
  expect(getPopoverPosition({ left: 760, right: 790, top: 100, bottom: 120 }, { width: 220, height: 160 }, viewport, "right"))
    .toEqual({ left: 564, top: 124, maxHeight: "460px" });
});

test("popover height fits the larger side when neither side fits the full panel", () => {
  expect(getPopoverPosition({ left: 100, right: 140, top: 200, bottom: 220 }, { width: 220, height: 500 }, viewport, "left"))
    .toEqual({ left: 100, top: 224, maxHeight: "360px" });
});

test("phone-width popovers retain a clear gutter at both viewport edges", () => {
  const position = getPopoverPosition({ left: 340, right: 380, top: 100, bottom: 120 }, { width: 224, height: 160 }, { width: 390, height: 844 }, "left");
  expect(position.left).toBe(150);
  expect(position.left + 224).toBeLessThanOrEqual(374);
});
