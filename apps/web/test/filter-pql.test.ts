import { expect, test } from "bun:test";
import { emptyFilters, filtersToPql, pqlToFilters, type Lookup } from "../src/filter-pql";

const lookup: Lookup = {
  state: [{ id: "s1", name: "Todo" }, { id: "s2", name: "In Progress" }],
  assignee: [{ id: "u1", name: "Ann" }, { id: "u2", name: "Bob" }],
  label: [{ id: "l1", name: "Bug" }, { id: "l2", name: "Bug" }],
  cycle: [{ id: "c1", name: "Sprint 1" }],
  module: [{ id: "m1", name: "Auth" }],
  createdBy: [{ id: "u1", name: "Ann" }],
  estimate: [{ id: "e1", name: "3" }, { id: "e2", name: "8" }],
  type: [{ id: "t1", name: "Bug" }, { id: "t2", name: "Task" }],
};

test("chips compile to PQL and read back to the same chips", () => {
  const filters = { ...emptyFilters(), state: ["s1", "s2"], priority: ["high"], estimate: ["e1", "e2"], assignee: ["none", "u1"], label: ["l1"], cycle: ["c1"], module: ["m1"], createdBy: ["u1"], dueDate: { from: "2026-01-01", to: "2026-01-31" }, startDate: { from: "2026-02-01", to: "" } };
  const text = filtersToPql(filters, lookup);
  expect(text).toBe('state IN ("Todo", "In Progress") AND priority = high AND estimate IN ("3", "8") AND (assignee = "Ann" OR hasNoAssignee()) AND label = "l1" AND cycle = "Sprint 1" AND module = "Auth" AND createdBy = "Ann" AND startDate >= 2026-02-01 AND dueDate BETWEEN 2026-01-01 AND 2026-01-31');
  const back = pqlToFilters(text, lookup)!;
  expect(back).toEqual({ ...filters, assignee: ["none", "u1"] });
});

test("empty text is no filters; hand-written equivalents are understood", () => {
  expect(pqlToFilters("  ", lookup)).toEqual(emptyFilters());
  expect(pqlToFilters("state = In Progress and priority in (urgent, high)", lookup)?.state).toEqual(["s2"]);
  expect(pqlToFilters("state = In Progress AND priority IN (urgent, high)", lookup)).toMatchObject({ state: ["s2"], priority: ["urgent", "high"] });
  expect(pqlToFilters("hasNoAssignee()", lookup)?.assignee).toEqual(["none"]);
  expect(pqlToFilters("dueDate >= 2026-01-01 AND dueDate <= 2026-01-31", lookup)?.dueDate).toEqual({ from: "2026-01-01", to: "2026-01-31" });
});

test("text the chips cannot say is not representable", () => {
  for (const text of ['state != Todo', 'priority = high OR priority = low', 'NOT state = Todo', 'assignee = currentUser()', 'title ~ foo', 'state = Todo ORDER BY title', 'state = Nope', 'state = Todo AND state = "In Progress"', 'priority = high LIMIT 5', 'state = ']) {
    expect(pqlToFilters(text, lookup)).toBeNull();
  }
});

test("a name two entries share is written as the id", () => {
  expect(filtersToPql({ ...emptyFilters(), label: ["l2"] }, lookup)).toBe('label = "l2"');
  expect(pqlToFilters('label = "l2"', lookup)?.label).toEqual(["l2"]);
  expect(pqlToFilters("label = Bug", lookup)).toBeNull();
});

test("an Estimate filter reads back from the quoted and the hand-written form", () => {
  expect(filtersToPql({ ...emptyFilters(), estimate: ["e2"] }, lookup)).toBe('estimate = "8"');
  expect(pqlToFilters('estimate = "8"', lookup)?.estimate).toEqual(["e2"]);
  expect(pqlToFilters("estimate IN (3, 8)", lookup)?.estimate).toEqual(["e1", "e2"]);
  // A value the scale no longer has, or an order comparison, is kept as text.
  expect(pqlToFilters("estimate = 13", lookup)).toBeNull();
  expect(pqlToFilters("estimate >= 8", lookup)).toBeNull();
});

test("the Work item type chip writes `type = Name` and reads it back", () => {
  const filters = { ...emptyFilters(), type: ["t1"] };
  expect(filtersToPql(filters, lookup)).toBe('type = "Bug"');
  expect(pqlToFilters("type = Bug", lookup)?.type).toEqual(["t1"]);
  expect(pqlToFilters('type IN (Bug, Task)', lookup)?.type).toEqual(["t1", "t2"]);
});
