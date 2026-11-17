import { expect, test } from "bun:test";
import { translate } from "@weft/shared";
import { referenceGroup, referenceHits, referenceLabel, referencePlace } from "../src/reference-picker";

test("a Work item link reads as its key and title, a page as its title", () => {
  expect(referenceLabel({ kind: "work-item", id: "a", displayId: "MOB-12", title: "Dark mode toggle" })).toBe("MOB-12 Dark mode toggle");
  expect(referenceLabel({ kind: "page", id: "b", title: "Project handbook", projectKey: "MOB" })).toBe("Project handbook");
  expect(referenceLabel({ kind: "wiki", id: "c", title: "Team handbook", projectKey: null })).toBe("Team handbook");
});

test("rows keep Work items first, then Project Pages, then Wiki pages, so each kind sits under one heading", () => {
  const hits = referenceHits(
    [{ id: "w1", displayId: "MOB-1", title: "Login" }],
    [
      { id: "wiki1", title: "Team handbook", projectId: null, projectKey: null },
      { id: "p1", title: "Release plan", projectId: "proj", projectKey: "MOB" },
    ],
  );
  expect(hits.map((hit) => hit.kind)).toEqual(["work-item", "page", "wiki"]);
  expect(hits.map(referenceGroup)).toEqual(["reference.groupWorkItems", "reference.groupProjectPages", "reference.groupWikiPages"]);
});

test("the place under a row is the key of a Work item and the project of a Project Page; a Wiki page has none", () => {
  expect(referencePlace({ kind: "work-item", id: "a", displayId: "MOB-12", title: "x" })).toBe("MOB-12");
  expect(referencePlace({ kind: "page", id: "b", title: "x", projectKey: "MOB" })).toBe(`${translate("palette.inProject")} MOB`);
  expect(referencePlace({ kind: "wiki", id: "c", title: "x", projectKey: null })).toBeNull();
});
