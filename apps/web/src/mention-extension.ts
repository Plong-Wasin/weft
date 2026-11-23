import type { RefObject } from "react";
import Mention from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import { accessReasonText } from "./access-reason";
import { mentionRender } from "./suggest-list";

export type MentionPerson = { userId: string; name: string; isAgent?: boolean; codeCapable?: boolean; hasAccess?: boolean; accessReason?: string | null; accessAsk?: "owner" | "admin" | null; accessOwnerName?: string | null };

export function mentionExtension(people: RefObject<MentionPerson[]>) {
  // The key is shared with the list, so an outside pointer-down can exit this suggestion.
  const pluginKey = new PluginKey("mentionSuggestion");
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: {
      char: "@",
      pluginKey,
      items: ({ query }: { query: string }) => (people.current ?? []).filter((person) => person.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(!!a.isAgent) - Number(!!b.isAgent) || a.name.localeCompare(b.name)).slice(0, 8).map((person) => ({ id: person.userId, label: person.name, isAgent: person.isAgent, codeCapable: person.codeCapable, unavailable: !!person.isAgent && person.hasAccess === false, unavailableReason: accessReasonText(person) })),
      render: mentionRender("wiki.mentionMembers", pluginKey),
    },
  });
}
