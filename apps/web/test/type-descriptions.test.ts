import { afterEach, expect, test } from "bun:test";
import { defaultTypeDescriptions, resources, setLocale } from "@weft/shared";
import { collectionLabel, typeDescriptionText } from "../src/type-descriptions";

afterEach(() => setLocale("en"));

test("the Task type and each suggested type show their Thai description in the Thai interface", () => {
  setLocale("th");
  expect(typeDescriptionText({ name: "Task", description: "The default type for every work item" })).toBe(resources.th["types.default.task"]);
  for (const [key, suggestion] of Object.entries(defaultTypeDescriptions)) {
    expect(typeDescriptionText({ name: suggestion.name, description: suggestion.description }), key).toBe(resources.th[`types.default.${key}` as never]);
    expect(resources.th[`types.default.${key}` as never], key).not.toBe(suggestion.description);
  }
});

test("the same default types show their English description in the English interface", () => {
  setLocale("en");
  expect(typeDescriptionText({ name: "Task", description: "The default type for every work item" })).toBe("The default type for every work item");
  expect(typeDescriptionText({ name: "Bug", description: defaultTypeDescriptions.bug.description })).toBe(defaultTypeDescriptions.bug.description);
});

test("an edited description stays exactly as typed in both languages", () => {
  for (const locale of ["en", "th"] as const) {
    setLocale(locale);
    expect(typeDescriptionText({ name: "Task", description: "  Our team's own line.  " })).toBe("  Our team's own line.  ");
    expect(typeDescriptionText({ name: "Bug", description: "ทีมเราใช้คำนี้" })).toBe("ทีมเราใช้คำนี้");
  }
});

test("an empty description of a default type shows the catalog text, and an empty custom type shows nothing", () => {
  setLocale("th");
  expect(typeDescriptionText({ name: "Bug", description: "" })).toBe(resources.th["types.default.bug"]);
  expect(typeDescriptionText({ name: "Feature", description: "" })).toBe("");
});

test("the Thai word for Modules is the same in the sidebar, the Properties panel and the feature list", () => {
  expect(resources.th["modules.title"]).toBe(resources.th["workItems.modules"]);
  expect(resources.th["features.modules"]).toBe(resources.th["workItems.modules"]);
});

test("the default Wiki collection shows its Thai name, and a collection of the team's own keeps its name", () => {
  setLocale("th");
  expect(collectionLabel({ name: "Wiki", isDefault: true })).toBe(resources.th["wiki.title"]);
  expect(collectionLabel({ name: "Wiki", isDefault: false })).toBe("Wiki");
  expect(collectionLabel({ name: "Handbook", isDefault: false })).toBe("Handbook");
});
