import { expect, test } from "bun:test";
import type { Project } from "../src/types";
import { dropWithinGroup, moveWithinGroup, orderAsPreferences, sortProjects, type ProjectPreference } from "../src/shell/project-preferences";

const project = (key: string, name: string): Project => ({ id: `id-${key}`, key, name, visibility: "public", archived: false, role: "Member", features: { cycles: true, modules: true, intake: true } as Project["features"] });
const alpha = project("ALP", "Alpha");
const beta = project("BET", "Beta");
const gamma = project("GAM", "Gamma");
const projects = [gamma, alpha, beta];
const pref = (projectId: string, patch: Partial<ProjectPreference> = {}): ProjectPreference => ({ projectId, starred: false, position: null, expanded: false, ...patch });

test("never-ordered projects sort by name; ordered ones come first in their saved order; stars form the top group", () => {
  expect(sortProjects(projects, []).others.map((p) => p.key)).toEqual(["ALP", "BET", "GAM"]);
  const prefs = [pref(gamma.id, { position: 0 }), pref(beta.id, { position: 1, starred: true }), pref(alpha.id, { position: 2 })];
  const { starred, others } = sortProjects(projects, prefs);
  expect(starred.map((p) => p.key)).toEqual(["BET"]);
  expect(others.map((p) => p.key)).toEqual(["GAM", "ALP"]);
});

test("a project with no position goes after the ordered ones, by name", () => {
  const prefs = [pref(gamma.id, { position: 0 })];
  expect(sortProjects(projects, prefs).others.map((p) => p.key)).toEqual(["GAM", "ALP", "BET"]);
});

test("moving up or down stays inside the group; the ends refuse to move", () => {
  const prefs = [pref(alpha.id, { starred: true }), pref(beta.id, { starred: true })];
  expect(moveWithinGroup(projects, prefs, beta.id, -1)).toEqual([beta.id, alpha.id, gamma.id]);
  expect(moveWithinGroup(projects, prefs, alpha.id, -1)).toBeNull();
  expect(moveWithinGroup(projects, prefs, beta.id, 1)).toBeNull();
  expect(moveWithinGroup(projects, prefs, gamma.id, -1)).toBeNull();
  expect(moveWithinGroup(projects, prefs, gamma.id, 1)).toBeNull();
});

test("dragging onto another project of the same group takes its place; across groups nothing happens", () => {
  const prefs = [pref(alpha.id, { starred: true }), pref(beta.id, { starred: true })];
  expect(dropWithinGroup(projects, prefs, beta.id, alpha.id)).toEqual([beta.id, alpha.id, gamma.id]);
  expect(dropWithinGroup(projects, prefs, gamma.id, alpha.id)).toBeNull();
  expect(dropWithinGroup(projects, prefs, alpha.id, gamma.id)).toBeNull();
  expect(dropWithinGroup(projects, prefs, alpha.id, alpha.id)).toBeNull();
});

test("a saved order gives every listed project its index and clears the rest", () => {
  const prefs = [pref(gamma.id, { position: 0, starred: true, expanded: true })];
  expect(orderAsPreferences(prefs, [alpha.id, beta.id])).toEqual([
    { projectId: gamma.id, starred: true, position: null, expanded: true },
    { projectId: alpha.id, starred: false, position: 0, expanded: false },
    { projectId: beta.id, starred: false, position: 1, expanded: false },
  ]);
});
