import { expect, test } from "bun:test";
import { defaultParams, groupItems, moveProperty, parseLayoutParams, serializeLayoutParams } from "../src/work-item-layout";

test("filters, grouping, sort and layout round-trip through the URL", () => {
  const params = { ...defaultParams, layout: "board" as const, group: "priority" as const, q: "priority = urgent", sort: "title" as const, dir: "desc" as const };
  const search = serializeLayoutParams(params);
  expect(search).toBe("?layout=board&group=priority&sort=title&dir=desc&q=priority+%3D+urgent");
  expect(parseLayoutParams(search)).toEqual(params);
});

test("defaults leave the URL clean and unknown values fall back", () => {
  expect(serializeLayoutParams(defaultParams)).toBe("");
  expect(parseLayoutParams("?group=banana&sort=nope&layout=x&dir=up")).toEqual(defaultParams);
});

test("new Group-by values round-trip through URLs while existing settings keep their spelling", () => {
  const params = { ...defaultParams, group: "dueDate" as const };
  expect(serializeLayoutParams(params)).toBe("?group=dueDate");
  expect(parseLayoutParams("?group=dueDate")).toEqual(params);
  expect(parseLayoutParams("?group=assignee").group).toBe("assignee");
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

test("grouping by label and module lists multi-valued items in every group and empty items under none", () => {
  const items = [
    { id: "1", stateId: "a", priority: "low", assigneeIds: [], labelIds: ["l1", "l2"], moduleIds: ["m1", "m2"] },
    { id: "2", stateId: "a", priority: "low", assigneeIds: [], labelIds: [], moduleIds: [] },
  ];
  expect(groupItems(items, "label", ["a"]).map((group) => [group.key, group.items.map((item) => item.id)])).toEqual([["l1", ["1"]], ["l2", ["1"]], ["none", ["2"]]]);
  expect(groupItems(items, "module", ["a"]).map((group) => [group.key, group.items.map((item) => item.id)])).toEqual([["m1", ["1"]], ["m2", ["1"]], ["none", ["2"]]]);
});

test("grouping by cycle, creator, and due date uses named groups and fixed local date buckets", () => {
  const items = [
    { id: "overdue", stateId: "a", priority: "low", assigneeIds: [], cycleId: "c1", creatorId: "u1", dueDate: "2026-10-31" },
    { id: "today", stateId: "a", priority: "low", assigneeIds: [], cycleId: null, creatorId: "u1", dueDate: "2026-11-02" },
    { id: "week", stateId: "a", priority: "low", assigneeIds: [], cycleId: null, creatorId: "u2", dueDate: "2026-11-08" },
    { id: "next", stateId: "a", priority: "low", assigneeIds: [], cycleId: null, creatorId: "u2", dueDate: "2026-11-09" },
    { id: "later", stateId: "a", priority: "low", assigneeIds: [], cycleId: null, creatorId: "u2", dueDate: "2026-11-16" },
    { id: "none", stateId: "a", priority: "low", assigneeIds: [], cycleId: null, creatorId: null, dueDate: null },
  ];
  expect(groupItems(items, "cycle", ["a"]).map((group) => group.key)).toEqual(["c1", "none"]);
  expect(groupItems(items, "creator", ["a"]).map((group) => group.key)).toEqual(["u1", "u2", "none"]);
  expect(groupItems(items, "dueDate", ["a"], new Date(2026, 10, 2)).map((group) => [group.key, group.items.map((item) => item.id)])).toEqual([
    ["overdue", ["overdue"]], ["today", ["today"]], ["thisWeek", ["week"]], ["nextWeek", ["next"]], ["later", ["later"]], ["noDueDate", ["none"]],
  ]);
});

test("the filter query round-trips through the URL and stays out of the plain URL", () => {
  const params = { ...defaultParams, q: 'priority = high AND title ~ "a&b"' };
  expect(parseLayoutParams(serializeLayoutParams(params))).toEqual(params);
  expect(serializeLayoutParams(defaultParams)).toBe("");
});

test("visible properties round-trip through the URL; the default set keeps the URL clean", () => {
  const params = { ...defaultParams, props: ["id", "state", "dates"] as typeof defaultParams.props };
  expect(serializeLayoutParams(params)).toBe("?props=id%2Cstate%2Cdates");
  expect(parseLayoutParams("?props=id,state,dates,bogus")).toEqual(params);
  expect(parseLayoutParams("?props=").props).toEqual([]);
  expect(serializeLayoutParams({ ...defaultParams, props: [] })).toBe("?props=");
});

test("spreadsheet layout and column order round-trip through the URL", () => {
  const params = { ...defaultParams, layout: "spreadsheet" as const, props: ["dates", "id", "state"] as typeof defaultParams.props };
  const query = serializeLayoutParams(params);
  expect(query).toBe("?layout=spreadsheet&props=dates%2Cid%2Cstate");
  expect(parseLayoutParams(query)).toEqual(params);
  expect(parseLayoutParams("?props=state,state,id").props).toEqual(["state", "id"]);
});

test("moveProperty swaps neighbours and stops at the ends", () => {
  expect(moveProperty(["id", "state", "dates"], "dates", -1)).toEqual(["id", "dates", "state"]);
  expect(moveProperty(["id", "state"], "id", -1)).toEqual(["id", "state"]);
  expect(moveProperty(["id", "state"], "state", 1)).toEqual(["id", "state"]);
});

test("calendar placement fills a Monday-first month grid and keeps undated work items aside", async () => {
  const { calendarPlacement } = await import("../src/work-item-layout");
  const items = [
    { id: "first", dueDate: "2026-11-01" },
    { id: "inside", dueDate: "2026-11-18" },
    { id: "outside", dueDate: "2026-12-01" },
    { id: "undated", dueDate: null },
  ];
  const placement = calendarPlacement(items, new Date(2026, 10, 1));
  expect(placement.days[0]?.date).toBe("2026-10-26");
  expect(placement.days).toHaveLength(42);
  expect(placement.days.find((day) => day.date === "2026-11-01")?.items.map((item) => item.id)).toEqual(["first"]);
  expect(placement.days.find((day) => day.date === "2026-11-18")?.items.map((item) => item.id)).toEqual(["inside"]);
  expect(placement.undated.map((item) => item.id)).toEqual(["undated"]);
});
