import { expect, test } from "bun:test";
import { translateDynamic } from "@weft/shared";
import { humanize, summarizeProposal } from "../src/ai-proposal-summary";

const id = "123e4567-e89b-42d3-a456-426614174000";

test("a create proposal gives verb, noun, title and plain fields without raw ids", () => {
  const summary = summarizeProposal("create_work_item", { projectId: id, title: "Launch checklist", priority: "high", stateId: id });
  expect(summary).toEqual({ verb: "create", noun: "work_item", title: "Launch checklist", projectId: id, fields: [{ key: "priority", value: "high" }], omitted: 1 });
});

test("lists of ids show as a count and lists of words join", () => {
  const summary = summarizeProposal("update_work_item", { workItemId: id, assigneeIds: [id, id], labels: ["bug", "ui"] });
  expect(summary.fields).toEqual([{ key: "assigneeIds", value: "2" }, { key: "labels", value: "bug, ui" }]);
});

test("an unknown tool still reads as verb and noun, and rich content is left out", () => {
  const summary = summarizeProposal("rename_widget_thing", { content: { type: "doc" }, name: "New" });
  expect(summary).toMatchObject({ verb: "rename", noun: "widget_thing", title: "New", fields: [] });
});

test("humanize turns snake and camel case into words", () => {
  expect(humanize("work_item")).toBe("work item");
  expect(humanize("assigneeIds")).toBe("assignee");
  expect(humanize("dueDate")).toBe("due date");
});

test("a dropped id next to a title is counted so the card can point at the exact input", () => {
  const summary = summarizeProposal("update_work_item", { workItemId: id, title: "Fix login", moduleId: id, cycleId: id, parentId: id });
  expect(summary.title).toBe("Fix login");
  expect(summary.omitted).toBe(3); // moduleId, cycleId, parentId; workItemId is the subject, not a dropped detail
});

test("nested objects, empty values and truncated text count as omitted", () => {
  const long = "x".repeat(200);
  const summary = summarizeProposal("update_work_item", { description: long, filter: { a: 1 }, assigneeIds: [], note: "" });
  expect(summary.fields[0]?.value.length).toBe(120);
  expect(summary.omitted).toBe(4);
});

test("nothing is omitted when every entry is shown", () => {
  expect(summarizeProposal("create_label", { projectId: id, name: "Bug", color: "red" }).omitted).toBe(0);
});

test("value text keeps its underscores", () => {
  expect(summarizeProposal("update_work_item", { note: "see user_id" }).fields).toEqual([{ key: "note", value: "see user_id" }]);
});

test("add and remove cycle items share one noun that reads right with either verb", () => {
  const en = (key: string) => translateDynamic(key);
  const phrase = (action: string) => { const s = summarizeProposal(action, {}); return `${en(`ai.proposal.verb.${s.verb}`)} ${en(`ai.proposal.noun.${s.noun}`)}`; };
  expect(phrase("add_cycle_items")).toBe("Add work items in a Cycle");
  expect(phrase("remove_cycle_items")).toBe("Remove work items in a Cycle");
  expect(phrase("remove_module_items")).toBe("Remove work items in a Module");
});

test("the subject id of an update is not counted as omitted", () => {
  expect(summarizeProposal("update_work_item", { workItemId: id, priority: "high" }).omitted).toBe(0);
  expect(summarizeProposal("remove_cycle_items", { cycleId: id, workItemIds: [id] }).omitted).toBe(0);
});
