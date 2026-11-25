import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chipClass, DatesMenu, EstimateSelect, MultiSelect, SingleSelect } from "../src/property-dropdowns";

const options = [{ id: "todo", name: "Todo" }];
const noop = () => {};

test("chipClass preserves the outlined chip and defines the quiet variant", () => {
  expect(chipClass(false)).toBe("border border-subtle bg-surface-1 px-2 py-1 text-12 font-medium text-primary hover:bg-layer-transparent-hover");
  const quiet = chipClass(true);
  expect(quiet).not.toMatch(/(?:^| )border(?: |$)/);
  expect(quiet).not.toContain("bg-surface-1");
  expect(quiet).toContain("text-secondary");
  expect(quiet).toContain("hover:bg-layer-transparent-hover");
  expect(quiet).toContain("hover:text-primary");
});

test("the outlined icon-only chip is the same as the outlined chip, so board cards do not change", () => {
  expect(chipClass(false, true)).toBe(chipClass(false, false));
});

test("icon-only quiet SingleSelect keeps its accessible name, value title, and hit area", () => {
  const html = renderToStaticMarkup(<SingleSelect quiet iconOnly label="State" summary="Todo" value="todo" options={options} onSelect={noop} />);
  expect(html).toContain('aria-label="State: Todo"');
  expect(html).toContain('title="State: Todo"');
  expect(html).toContain("min-h-7 min-w-7 max-sm:min-h-9 max-sm:min-w-9");
  expect(html).toContain("hover:bg-layer-transparent-hover hover:text-primary");
  expect(html).toContain("max-sm:inline");
});

test("quiet reaches read-only SingleSelect and DatesMenu triggers", () => {
  const select = renderToStaticMarkup(<SingleSelect quiet readOnly label="State" summary="Todo" value="todo" options={options} onSelect={noop} />);
  expect(select).toContain("bg-transparent px-2 py-1 text-12 font-medium text-secondary");
  expect(select).not.toContain("border-subtle");
  const dates = renderToStaticMarkup(<DatesMenu quiet readOnly startDate={null} dueDate={null} onChange={noop} />);
  expect(dates).toContain("bg-transparent px-2 py-1 text-12 font-medium text-secondary");
  expect(dates).not.toContain("border-subtle");
});

test("quiet reaches interactive EstimateSelect, MultiSelect, and DatePopover triggers", () => {
  const estimate = renderToStaticMarkup(<EstimateSelect quiet estimate={{ id: "estimate", projectId: "project", name: "Estimate", type: "points", enabled: true, points: [{ id: "one", position: 0, value: "1" }] }} pointId="one" onSelect={noop} />);
  const multi = renderToStaticMarkup(<MultiSelect quiet label="Labels" summary="Bug" options={[{ id: "bug", name: "Bug" }]} selected={["bug"]} onToggle={noop} />);
  const dates = renderToStaticMarkup(<DatesMenu quiet startDate={null} dueDate={null} onChange={noop} />);
  for (const html of [estimate, multi, dates]) {
    expect(html).toContain("bg-transparent px-2 py-1 text-12 font-medium text-secondary");
    expect(html).not.toContain("border-subtle");
  }
});
