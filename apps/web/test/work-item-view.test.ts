import { expect, test } from "bun:test";
import { defaultParams, groupItems, parseViewParams, serializeViewParams } from "../src/work-item-view";

test("filters, grouping, sort and view round-trip through the URL", () => {
  const params = { ...defaultParams, view: "kanban" as const, group: "priority" as const, state: ["s1", "s2"], priority: ["urgent"], assignee: ["u1"], label: ["l1"], sort: "title" as const, dir: "desc" as const };
  const search = serializeViewParams(params);
  expect(search).toBe("?view=kanban&group=priority&state=s1%2Cs2&priority=urgent&assignee=u1&label=l1&sort=title&dir=desc");
  expect(parseViewParams(search)).toEqual(params);
});

test("defaults leave the URL clean and unknown values fall back", () => {
  expect(serializeViewParams(defaultParams)).toBe("");
  expect(parseViewParams("?group=banana&sort=nope&view=x&dir=up")).toEqual(defaultParams);
});

test("grouping by assignee lists a multi-assignee item under each and unassigned last", () => {
  const items = [
    { id: "1", stateId: "a", priority: "low", assigneeIds: ["u1", "u2"] },
    { id: "2", stateId: "b", priority: "low", assigneeIds: [] },
  ];
  const groups = groupItems(items, "assignee", ["a", "b"]);
  expect(groups.map((group) => [group.key, group.items.map((item) => item.id)])).toEqual([["u1", ["1"]], ["u2", ["1"]], ["none", ["2"]]]);
  expect(groupItems(items, "state", ["a", "b", "c"]).map((group) => group.items.length)).toEqual([1, 1, 0]);
});

test("query mode and text round-trip through the URL and stay out of the plain URL", () => {
  const params = { ...defaultParams, mode: "pql" as const, q: 'priority = high AND title ~ "a&b"' };
  expect(parseViewParams(serializeViewParams(params))).toEqual(params);
  expect(serializeViewParams(defaultParams)).toBe("");
});
