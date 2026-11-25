import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chipClass, DatesMenu, EstimateSelect, MultiSelect, SingleSelect } from "../src/property-dropdowns";

const options = [{ id: "todo", name: "Todo" }];
const noop = () => {};

test("chipClass uses the shadcn outlined chip and quiet variant", () => {
  expect(chipClass(false)).toBe("border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-accent [@media(pointer:coarse)]:min-h-11");
  const quiet = chipClass(true);
  expect(quiet).not.toMatch(/(?:^| )border(?: |$)/);
  expect(quiet).not.toContain("bg-background");
  expect(quiet).toContain("text-muted-foreground");
  expect(quiet).toContain("hover:bg-accent");
  expect(quiet).toContain("hover:text-accent-foreground");
});

test("the outlined icon-only chip keeps the outlined chip and adds only the coarse-pointer hit area", () => {
  expect(chipClass(false, true)).toBe(`${chipClass(false, false)} [@media(pointer:coarse)]:min-w-11`);
});

test("icon-only quiet SingleSelect keeps its accessible name, value title, and coarse-pointer hit area", () => {
  const html = renderToStaticMarkup(<SingleSelect quiet iconOnly label="State" summary="Todo" value="todo" options={options} onSelect={noop} />);
  expect(html).toContain('aria-label="State: Todo"');
  expect(html).toContain('title="State: Todo"');
  expect(html).toContain("pointer-coarse:min-h-11 pointer-coarse:min-w-11");
  expect(html).toContain("hover:bg-accent hover:text-accent-foreground");
  expect(html).toContain("max-sm:inline");
});

test("quiet reaches read-only SingleSelect and DatesMenu triggers", () => {
  const select = renderToStaticMarkup(<SingleSelect quiet readOnly label="State" summary="Todo" value="todo" options={options} onSelect={noop} />);
  expect(select).toContain("bg-transparent px-2 py-1 text-xs font-medium text-muted-foreground");
  expect(select).not.toContain("border-border");
  const dates = renderToStaticMarkup(<DatesMenu quiet readOnly startDate={null} dueDate={null} onChange={noop} />);
  expect(dates).toContain("bg-transparent px-2 py-1 text-xs font-medium text-muted-foreground");
  expect(dates).not.toContain("border-border");
});

test("quiet reaches interactive EstimateSelect, MultiSelect, and DatePopover triggers", () => {
  const estimate = renderToStaticMarkup(<EstimateSelect quiet estimate={{ id: "estimate", projectId: "project", name: "Estimate", type: "points", enabled: true, points: [{ id: "one", position: 0, value: "1" }] }} pointId="one" onSelect={noop} />);
  const multi = renderToStaticMarkup(<MultiSelect quiet label="Labels" summary="Bug" options={[{ id: "bug", name: "Bug" }]} selected={["bug"]} onToggle={noop} />);
  const dates = renderToStaticMarkup(<DatesMenu quiet startDate={null} dueDate={null} onChange={noop} />);
  for (const html of [estimate, multi, dates]) {
    expect(html).toContain("bg-transparent px-2 py-1 text-xs font-medium text-muted-foreground");
    expect(html).not.toContain("border-border");
  }
});
