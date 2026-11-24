import { expect, test } from "bun:test";
import { resources } from "@weft/shared";
import { dateFilters, namedFilters } from "../src/filter-query";
import { groupings, layouts } from "../src/work-item-layout";

// The filter bar and the layout menu build these keys at run time, so the compiler cannot see a missing one. A missing key makes translate() return undefined and the filter bar throws on `.toLowerCase()`.
const dynamicKeys = [
  ...namedFilters.map((key) => `layout.filter.${key}`),
  ...dateFilters.map((key) => `layout.filter.${key}`),
  ...groupings.map((key) => `layout.group.${key}`),
  ...layouts.map((key) => `layout.${key}`),
];

test("every key the filter bar and layout menu build has an English and a Thai text", () => {
  const missing = (resource: Record<string, string>) => dynamicKeys.filter((key) => typeof resource[key] !== "string" || resource[key] === "");
  expect(missing(resources.en)).toEqual([]);
  expect(missing(resources.th)).toEqual([]);
});
