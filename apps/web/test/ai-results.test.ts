import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { translate } from "@weft/shared";
import { aiWriteActions } from "../../../packages/actions/src/confirmations";
import { appliedResult, autopilotResults, displayIdsIn, targetPath } from "../src/ai-results";
import { ResultList } from "../src/ai-result-rows";
import { Markdown } from "../src/markdown";

const target = { kind: "work_item", ref: "a", id: "a", status: "available", title: "Fix login", displayId: "MOB-1", projectKey: "MOB", stateGroup: "started" } as const;
const created = appliedResult("create_work_item", { projectId: "p", title: "Fix login" }, { id: "a" });
const render = (element: React.ReactElement) => renderToStaticMarkup(React.createElement(MemoryRouter, null, element));
const list = (targets: Parameters<typeof ResultList>[0]["targets"], results = [created]) => render(React.createElement(ResultList, { results, targets, slug: "team", heading: "Applied" }));

test("finds the target and verb of an applied action", () => {
  expect(created).toEqual({ action: "create_work_item", verb: "created", refs: [{ kind: "work_item", id: "a" }] });
  expect(appliedResult("update_work_item", { workItemId: "b" }, { id: "b" })).toMatchObject({ verb: "updated", refs: [{ kind: "work_item", id: "b" }] });
  expect(appliedResult("bulk_update_work_items", { workItemIds: ["b", "c"] }, {}).refs.map((ref) => ref.id)).toEqual(["b", "c"]);
  expect(appliedResult("delete_wiki_page", { pageId: "w" }, {})).toMatchObject({ verb: "deleted", refs: [{ kind: "wiki_page", id: "w" }] });
  expect(appliedResult("create_cycle", {}, { id: "c" }).refs).toEqual([{ kind: "cycle", id: "c" }]);
  expect(appliedResult("add_module_items", { moduleId: "m" }, {})).toMatchObject({ verb: "updated", refs: [{ kind: "module", id: "m" }] });
  expect(appliedResult("create_project", {}, { id: "p" }).refs).toEqual([{ kind: "project", id: "p" }]);
});

test("an action with no target, or an old result without the data, has no reference", () => {
  expect(appliedResult("create_view", {}, { id: "v" }).refs).toEqual([]);
  expect(appliedResult("create_work_item", {}, undefined).refs).toEqual([]);
  expect(appliedResult("update_work_item", undefined, undefined).refs).toEqual([]);
});

test("reads the Autopilot results stored in a message's parts", () => {
  const parts = [
    { type: "tool-list_work_items", input: {}, output: "[]" },
    { type: "tool-create_work_item", input: { title: "x" }, output: JSON.stringify({ status: "done", action: "create_work_item", result: { id: "a" } }) },
    { type: "tool-create_work_item", output: JSON.stringify({ status: "done" }) },
  ];
  expect(autopilotResults(parts).map((result) => [result.action, result.refs.length])).toEqual([["create_work_item", 1], ["create_work_item", 0]]);
});

test("every AI Write action has a readable label in English and Thai", () => {
  for (const action of aiWriteActions) {
    for (const locale of ["en", "th"] as const) {
      const label = translate(`ai.action.${action}`, locale);
      expect(label).not.toContain("_");
      expect(label).not.toBe(`ai.action.${action}`);
    }
  }
});

test("a visible target is one link with state, display id, title and verb", () => {
  const out = list([target]);
  expect(out).toContain('href="/team/browse/MOB-1"');
  for (const text of ["MOB-1", "Fix login", translate("ai.result.created"), "min-h-11"]) expect(out).toContain(text);
  expect(out).not.toContain("create_work_item");
});

test("a target the viewer cannot see shows no title and no link", () => {
  const out = list([]);
  expect(out).toContain(translate("ai.result.unavailable"));
  expect(out).not.toContain("Fix login");
  expect(out).not.toContain("href=");
});

test("deleted targets are not links; archived ones are marked", () => {
  const deleted = list([{ ...target, status: "deleted" }]);
  expect(deleted).toContain(translate("ai.result.status.deleted"));
  expect(deleted).not.toContain("href=");
  const archived = list([{ ...target, status: "archived" }]);
  expect(archived).toContain(translate("ai.result.status.archived"));
  expect(archived).toContain("href=");
});

test("while resolving, or without a target, the row is a readable label", () => {
  expect(list(undefined)).toContain(translate("ai.action.create_work_item"));
  const none = list([], [appliedResult("create_view", {}, {})]);
  expect(none).toContain(translate("ai.action.create_view"));
  expect(none).not.toContain("create_view");
});

test("a bulk change reserves one row per target while titles are loading", () => {
  const bulk = appliedResult("bulk_update_work_items", { workItemIds: ["a", "b"] }, {});
  const links = [target, { ...target, ref: "b", id: "b", displayId: "MOB-2" }];
  expect(list(undefined, [bulk]).match(/<li>/g)).toHaveLength(2);
  expect(list(links, [bulk]).match(/<li>/g)).toHaveLength(2);
});

test("paths for each kind", () => {
  const of = (kind: "wiki_page" | "cycle" | "module" | "project", projectKey: string | null = "MOB") => targetPath("team", { ...target, kind, projectKey });
  expect(of("wiki_page")).toBe("/team/projects/MOB/pages/a");
  expect(of("wiki_page", null)).toBe("/team/wiki/a");
  expect(of("cycle")).toBe("/team/projects/MOB/cycles/a");
  expect(of("module")).toBe("/team/projects/MOB/modules/a");
  expect(of("project")).toBe("/team/projects/MOB/issues");
});

test("display ids in an answer link only when resolved, and never inside code or links", () => {
  const text = "**MOB-1** and MOB-2, `MOB-1`, [MOB-1](https://example.test)";
  expect(displayIdsIn(text)).toEqual(["MOB-1", "MOB-2"]);
  const out = render(React.createElement(Markdown, { text, links: new Map([["MOB-1", "/team/browse/MOB-1"]]) }));
  expect(out.match(/href="\/team\/browse\/MOB-1"/g)).toHaveLength(1);
  expect(out).toContain("MOB-2");
  expect(out).toContain('href="https://example.test"');
});
