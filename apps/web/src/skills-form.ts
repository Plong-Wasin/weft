export type SkillDraft = { name: string; description: string; instructions: string };
export type SkillValidationKey = "skills.nameRequired" | "skills.nameFormat" | "skills.descriptionRequired" | "skills.descriptionLimit" | "skills.instructionsRequired" | "skills.instructionsLimit";

/** Returns the first user-facing validation message key for a Skill form draft. */
export function validateSkillDraft(draft: SkillDraft): SkillValidationKey | null {
  if (!draft.name.trim()) return "skills.nameRequired";
  if (draft.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name)) return "skills.nameFormat";
  if (!draft.description.trim()) return "skills.descriptionRequired";
  if (draft.description.length > 1024) return "skills.descriptionLimit";
  if (!draft.instructions.trim()) return "skills.instructionsRequired";
  if (draft.instructions.length > 8000) return "skills.instructionsLimit";
  return null;
}
