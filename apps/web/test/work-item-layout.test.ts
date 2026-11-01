import { expect, test } from "bun:test";
import { defaultParams, groupItems, parseLayoutParams, serializeLayoutParams } from "../src/work-item-layout";

test("filters, grouping, sort and layout round-trip through the URL", () => {
  const params = { ...defaultParams, layout: "board" as const, group: "priority" as const, state: ["s1", "s2"], priority: ["urgent"], assignee: ["u1"], label: ["l1"], sort: "title" as const, dir: "desc" as const };
  const search = serializeLayoutParams(params);
  expect(search).toBe("?layout=board&group=priority&state=s1%2Cs2&priority=urgent&assignee=u1&label=l1&sort=title&dir=desc");
  expect(parseLayoutParams(search)).toEqual(params);
});

test("defaults leave the URL clean and unknown values fall back", () => {
  expect(serializeLayoutParams(defaultParams)).toBe("");
  expect(parseLayoutParams("?group=banana&sort=nope&layout=x&dir=up")).toEqual(defaultParams);
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
