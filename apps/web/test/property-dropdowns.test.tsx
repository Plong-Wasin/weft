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

test("icon-only SingleSelect keeps its accessible name, shadcn hit area, and responsive label", () => {
  const html = renderToStaticMarkup(<SingleSelect quiet iconOnly label="State" summary="Todo" value="todo" options={options} onSelect={noop} />);
  expect(html).toContain('aria-label="State: Todo"');
  expect(html).toContain("min-w-7 pointer-coarse:min-h-11 pointer-coarse:min-w-11");
  expect(html).toContain("border-input bg-background");
  expect(html).toContain("focus-visible:ring-ring/50");
  expect(html).toContain("max-sm:inline");
});

test("SingleSelect longer than the search threshold keeps the searchable popover, not the shadcn Select", () => {
  const many = Array.from({ length: 7 }, (_, index) => ({ id: `option-${index}`, name: `Option ${index}` }));
  const html = renderToStaticMarkup(<SingleSelect label="Cycle" summary="Option 0" value="option-0" options={many} onSelect={noop} />);
  expect(html).not.toContain('role="combobox"');
  expect(html).toContain('aria-label="Cycle: Option 0"');
});

test("quiet reaches read-only SingleSelect and DatesMenu triggers", () => {
  const select = renderToStaticMarkup(<SingleSelect quiet readOnly label="State" summary="Todo" value="todo" options={options} onSelect={noop} />);
  expect(select).toContain("bg-transparent px-2 py-1 text-12 font-medium text-secondary");
  expect(select).not.toContain("border-subtle");
  const dates = renderToStaticMarkup(<DatesMenu quiet readOnly startDate={null} dueDate={null} onChange={noop} />);
  expect(dates).toContain("bg-transparent px-2 py-1 text-12 font-medium text-secondary");
  expect(dates).not.toContain("border-subtle");
});

test("SingleSelect uses shadcn while MultiSelect and DatePopover keep their quiet trigger treatment", () => {
  const estimate = renderToStaticMarkup(<EstimateSelect quiet estimate={{ id: "estimate", projectId: "project", name: "Estimate", type: "points", enabled: true, points: [{ id: "one", position: 0, value: "1" }] }} pointId="one" onSelect={noop} />);
  const multi = renderToStaticMarkup(<MultiSelect quiet label="Labels" summary="Bug" options={[{ id: "bug", name: "Bug" }]} selected={["bug"]} onToggle={noop} />);
  const dates = renderToStaticMarkup(<DatesMenu quiet startDate={null} dueDate={null} onChange={noop} />);
  expect(estimate).toContain("border-input bg-background");
  for (const html of [multi, dates]) {
    expect(html).toContain("bg-transparent px-2 py-1 text-12 font-medium text-secondary");
    expect(html).not.toContain("border-subtle");
  }
});
