import { expect, test } from "bun:test";
import { groupItems } from "../src/work-item-layout";
import { droppedByTypeChange, missingRequired, propertiesOfType, type CustomProperty } from "../src/work-item-types";

const severity: CustomProperty = { id: "p1", projectId: "x", name: "Severity", kind: "dropdown", required: true, defaultValue: null, position: 0, options: [], typeIds: ["bug"] };
const link: CustomProperty = { id: "p2", projectId: "x", name: "Link", kind: "url", required: false, defaultValue: null, position: 1, options: [], typeIds: ["bug", "task"] };
const properties = [severity, link];

test("group-by type splits the items by their type, with none last", () => {
  const items = [
    { id: "a", stateId: "s", priority: "none", assigneeIds: [], typeId: "bug" },
    { id: "b", stateId: "s", priority: "none", assigneeIds: [], typeId: "task" },
    { id: "c", stateId: "s", priority: "none", assigneeIds: [], typeId: null },
  ];
  const groups = groupItems(items, "type", ["s"]);
  expect(groups.map((group) => [group.key, group.items.map((item) => item.id)])).toEqual([["bug", ["a"]], ["task", ["b"]], ["none", ["c"]]]);
});

test("moving to a type that lacks a property with a value names it, and shared properties are kept", () => {
  const values = [{ propertyId: "p1", value: "p1-high" }, { propertyId: "p2", value: "https://example.com" }];
  expect(droppedByTypeChange(properties, values, "task")).toEqual(["Severity"]);
  expect(droppedByTypeChange(properties, values, "bug")).toEqual([]);
  expect(propertiesOfType(properties, "task").map((property) => property.name)).toEqual(["Link"]);
});

test("a required property without a value is named as missing", () => {
  expect(missingRequired(properties, new Map([["p2", "https://example.com"]]))).toEqual(["Severity"]);
  expect(missingRequired(properties, new Map([["p1", "p1-low"]]))).toEqual([]);
});
