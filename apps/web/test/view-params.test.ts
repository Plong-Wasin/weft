import { expect, test } from "bun:test";
import { defaultParams, parseLayoutParams, serializeLayoutParams } from "../src/work-item-layout";
import { differsFromView, paramsToSettings, viewToParams, type SavedView } from "../src/view-params";

const view = (patch: Partial<SavedView> = {}): SavedView => ({
  id: "v", projectId: "p", scope: "project", workspaceId: "w", name: "Hot", description: "", query: "priority = high", layout: "board", groupBy: "priority", orderBy: "title", orderDirection: "desc",
  properties: ["state", "id"], access: "public", ownerId: "u", createdAt: "", updatedAt: "", ...patch,
});

test("a View's settings become Layout params and come back unchanged", () => {
  const params = viewToParams(view());
  expect(params).toEqual({ layout: "board", group: "priority", sort: "title", dir: "desc", q: "priority = high", props: ["state", "id"] });
  expect(paramsToSettings(params)).toEqual({ query: "priority = high", layout: "board", groupBy: "priority", orderBy: "title", orderDirection: "desc", properties: ["state", "id"] });
});

test("a Calendar View reopens with its Calendar layout", () => {
  const saved = view({ layout: "calendar" });
  const params = viewToParams(saved);
  expect(params.layout).toBe("calendar");
  expect(paramsToSettings(params).layout).toBe("calendar");
});

test("the URL round trip keeps every stored setting, including the order of properties", () => {
  const params = viewToParams(view());
  expect(parseLayoutParams(serializeLayoutParams(params))).toEqual(params);
});

test("a View with default settings serializes to the bare URL and parses back to the defaults", () => {
  const params = viewToParams(view({ query: "", layout: "list", groupBy: "state", orderBy: "manual", orderDirection: "asc", properties: [...defaultParams.props] }));
  expect(serializeLayoutParams(params)).toBe("");
  expect(parseLayoutParams("")).toEqual(params);
});

test("differsFromView is true only when an applied setting differs from the stored one", () => {
  const saved = view();
  expect(differsFromView(saved, viewToParams(saved))).toBe(false);
  expect(differsFromView(saved, { ...viewToParams(saved), group: "state" })).toBe(true);
  expect(differsFromView(saved, { ...viewToParams(saved), q: "priority = low" })).toBe(true);
  expect(differsFromView(saved, { ...viewToParams(saved), props: ["id", "state"] })).toBe(true);
});
