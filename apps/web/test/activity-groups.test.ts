import { expect, test } from "bun:test";
import { groupActivities, readableActivityValue, type GroupableActivity } from "../src/activity-groups";

const activity = (id: string, minutes: number, changes: Partial<GroupableActivity> = {}): GroupableActivity => ({
  id, field: "title", actorId: "alice", actorName: "Alice", source: "ui", createdAt: `2026-01-01T00:${String(minutes).padStart(2, "0")}:00.000Z`, oldValue: `v${minutes}`, newValue: `v${minutes + 1}`,
  ...changes,
});

test("groups adjacent changes through the inclusive five-minute sliding boundary", () => {
  const rows = groupActivities([activity("a", 0, { oldValue: "start" }), activity("b", 5), activity("c", 10, { newValue: "finish" })]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "group", id: "a", oldValue: "start", newValue: "finish", count: 3 });
});

test("newest-first Activities keep their display order and chronological value summary", () => {
  const rows = groupActivities([activity("new", 5, { oldValue: "middle", newValue: "finish" }), activity("old", 0, { oldValue: "start", newValue: "middle" })]);
  expect(rows).toMatchObject([{ kind: "group", id: "new", oldValue: "start", newValue: "finish", activities: [{ id: "new" }, { id: "old" }] }]);
});

test("an intervening actor ends a group and the other actor's Activity stays in order", () => {
  expect(groupActivities([activity("a", 0), activity("b", 1, { actorId: "bob" }), activity("c", 2)])).toHaveLength(3);
});

test("field and surface changes remain separate rows", () => {
  expect(groupActivities([activity("a", 0), activity("b", 1, { field: "state" }), activity("c", 2, { source: "ai" })])).toHaveLength(3);
});

test("net-zero groups are hidden by default and available in show-all mode", () => {
  const rows = groupActivities([activity("a", 0, { oldValue: "same", newValue: "middle" }), activity("b", 1, { oldValue: "middle", newValue: "same" })]);
  expect(rows).toEqual([]);
  expect(groupActivities([activity("a", 0, { oldValue: "same", newValue: "middle" }), activity("b", 1, { oldValue: "middle", newValue: "same" })], true)).toMatchObject([{ kind: "group", count: 2 }]);
});

test("a lone Activity remains an Activity row and groups retain every raw Activity", () => {
  const rows = groupActivities([activity("a", 0), activity("b", 1)]);
  expect(rows[0]).toMatchObject({ kind: "group", activities: [{ id: "a" }, { id: "b" }] });
  expect(groupActivities([activity("solo", 0)])).toMatchObject([{ kind: "activity", activity: { id: "solo" } }]);
});

test("lifecycle and attachment events are never grouped or hidden", () => {
  for (const field of ["attachment_added", "web_link_added", "relation_added", "created", "archived"]) {
    const rows = groupActivities([activity("a", 0, { field, oldValue: null, newValue: null }), activity("b", 1, { field, oldValue: null, newValue: null })]);
    expect(rows.map((row) => row.kind)).toEqual(["activity", "activity"]);
  }
});

test("another field of the same actor in between does not end a group, another actor does", () => {
  const rows = groupActivities([activity("a", 0), activity("b", 1, { field: "priority" }), activity("c", 2)]);
  expect(rows.map((row) => row.kind)).toEqual(["group", "activity"]);
  expect(rows[0]).toMatchObject({ id: "a", count: 2 });
  expect(groupActivities([activity("a", 0), activity("b", 1, { actorId: "bob", field: "priority" }), activity("c", 2)]).map((row) => row.kind)).toEqual(["activity", "activity", "activity"]);
});

test("ids, lists and objects are not shown as group values", () => {
  expect(readableActivityValue("7f3a2b1c-1d2e-4f50-9a8b-0123456789ab")).toBeNull();
  expect(readableActivityValue(["x"])).toBeNull();
  expect(readableActivityValue({ a: 1 })).toBeNull();
  expect(readableActivityValue("Todo")).toBe("Todo");
  expect(readableActivityValue(null)).toBe("—");
});

test("a change to the same field from another surface ends the open group", () => {
  const rows = groupActivities([activity("a", 0, { oldValue: "A", newValue: "B" }), activity("b", 1, { source: "ai", oldValue: "B", newValue: "C" }), activity("c", 2, { oldValue: "C", newValue: "A" })]);
  expect(rows.map((row) => row.kind)).toEqual(["activity", "activity", "activity"]);
});

test("equal timestamps in newest-first order still give the chronological summary", () => {
  const same = { createdAt: "2026-01-01T00:00:00.000Z" };
  const rows = groupActivities([activity("new", 0, { ...same, oldValue: "B", newValue: "C" }), activity("old", 0, { ...same, oldValue: "A", newValue: "B" })]);
  expect(rows[0]).toMatchObject({ kind: "group", oldValue: "A", newValue: "C" });
});
