/**
 * The default Work item types and their one-line descriptions, in English. The server stores the English text when a project creates
 * its Task type and when an admin adds a suggestion. The web shows the catalog text (`types.default.<key>`) in the interface language
 * while the stored text is still one of these English texts, or empty; an edited description is shown exactly as typed.
 */
export const defaultTypeDescriptions = {
  task: { name: "Task", description: "The default type for every work item" },
  bug: { name: "Bug", description: "Something that works wrongly and needs fixing." },
  request: { name: "Request", description: "Someone asks for something new or for a change." },
  approval: { name: "Approval", description: "Needs a yes or no from a named person before work goes on." },
  document: { name: "Document", description: "A text to write or review, such as a plan, a policy or a report." },
  "big-task": { name: "Big task", description: "A large piece of work that groups smaller tasks under it." },
} as const;

export type DefaultTypeKey = keyof typeof defaultTypeDescriptions;

/**
 * The default type a stored description stands for: the one whose English text it equals, or, for an empty description, the one whose
 * name the type carries. Null for any other text, which then stays as typed.
 */
export function defaultTypeKeyOf(type: { name: string; description: string }): DefaultTypeKey | null {
  const stored = type.description.trim();
  const keys = Object.keys(defaultTypeDescriptions) as DefaultTypeKey[];
  if (stored === "") return keys.find((key) => defaultTypeDescriptions[key].name.toLowerCase() === type.name.trim().toLowerCase()) ?? null;
  return keys.find((key) => defaultTypeDescriptions[key].description === stored) ?? null;
}
