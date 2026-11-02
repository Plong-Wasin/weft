import { expect, test } from "bun:test";
import { validateSkillDraft } from "../src/skills-form";

const valid = { name: "weekly-summary", description: "Summarize the week", instructions: "Write a concise summary." };

test("accepts a valid Skill draft and enforces the documented limits", () => {
  expect(validateSkillDraft(valid)).toBeNull();
  expect(validateSkillDraft({ ...valid, name: " " })).toBe("skills.nameRequired");
  expect(validateSkillDraft({ ...valid, name: "Bad Name" })).toBe("skills.nameFormat");
  expect(validateSkillDraft({ ...valid, name: "a".repeat(65) })).toBe("skills.nameFormat");
  expect(validateSkillDraft({ ...valid, description: "" })).toBe("skills.descriptionRequired");
  expect(validateSkillDraft({ ...valid, description: "x".repeat(1025) })).toBe("skills.descriptionLimit");
  expect(validateSkillDraft({ ...valid, instructions: "" })).toBe("skills.instructionsRequired");
  expect(validateSkillDraft({ ...valid, instructions: "x".repeat(8001) })).toBe("skills.instructionsLimit");
});
