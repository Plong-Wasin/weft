import { expect, test } from "bun:test";
import { defaultTypeIcon, resolveTypeIcon, resources, searchTypeIcons, typeIconGroups, typeIconList, typeIcons } from "../src/index";

const nameIn = (locale: "en" | "th") => (key: string) => (resources[locale] as Record<string, string>)[`types.icon.${key}`] ?? key;

test("the shared list has at least 60 icons, each in a named group, with the six original keys present", () => {
  expect(typeIconList.length).toBeGreaterThanOrEqual(60);
  expect(new Set(typeIcons).size).toBe(typeIcons.length);
  for (const key of ["task", "bug", "request", "approval", "document", "group"]) expect(typeIcons as readonly string[]).toContain(key);
  for (const entry of typeIconList) expect(typeIconGroups).toContain(entry.group);
  const groupsUsed = new Set(typeIconList.map((entry) => entry.group));
  expect([...groupsUsed].sort()).toEqual([...typeIconGroups].sort());
});

test("every icon has an English and a Thai name in the catalog", () => {
  for (const key of typeIcons) {
    expect(typeof (resources.en as Record<string, string>)[`types.icon.${key}`]).toBe("string");
    expect(typeof (resources.th as Record<string, string>)[`types.icon.${key}`]).toBe("string");
  }
  for (const group of typeIconGroups) {
    expect(typeof (resources.en as Record<string, string>)[`types.iconGroup.${group}`]).toBe("string");
    expect(typeof (resources.th as Record<string, string>)[`types.iconGroup.${group}`]).toBe("string");
  }
});

test("search matches the icon name and keywords in English, and keywords in Thai", () => {
  const en = nameIn("en");
  expect(searchTypeIcons("rocket", en).map((entry) => entry.key)).toContain("rocket");
  expect(searchTypeIcons("ROCKET", en).map((entry) => entry.key)).toContain("rocket");
  expect(searchTypeIcons("deploy", en).map((entry) => entry.key)).toContain("rocket");
  expect(searchTypeIcons("hand helping", en).map((entry) => entry.key)).toEqual(["hand-helping"]);
  expect(searchTypeIcons("ปลั๊กอิน", nameIn("th")).map((entry) => entry.key)).toContain("puzzle");
  expect(searchTypeIcons("เอกสาร", nameIn("th")).map((entry) => entry.key)).toContain("document");
});

test("an empty query matches every icon, and a query no icon has returns nothing", () => {
  expect(searchTypeIcons("   ", nameIn("en")).length).toBe(typeIconList.length);
  expect(searchTypeIcons("zzqqxx", nameIn("en"))).toEqual([]);
});

test("a stored key that is not in the list falls back to the task icon; known keys pass through", () => {
  expect(defaultTypeIcon).toBe("task");
  expect(resolveTypeIcon("retired-icon")).toBe("task");
  expect(resolveTypeIcon("")).toBe("task");
  expect(resolveTypeIcon("rocket")).toBe("rocket");
  expect(resolveTypeIcon("bug")).toBe("bug");
});
