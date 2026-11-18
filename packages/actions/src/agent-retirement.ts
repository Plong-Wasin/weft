import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "@weft/db";
import {
  activities, aiChats, assets, collections, comments, cycles, estimates, exports as exportRows,
  intakeItems, modules, outboundWebhooks, projects, recurrences, runs, skills, views, webLinks, wikiPages, wikiPageTemplates, wikiPageVersions, workItemDescriptionVersions,
  workItemIntegrations, workItemPages, workItemRelations, workItems,
} from "@weft/db";

/**
 * What deleting an Agent would destroy: the content its bot user wrote or created. The Agent delete action refuses while any of
 * it exists, and the Agent settings page shows the same counts before an admin confirms. Keys are the database table and column
 * of each cascading reference to the user table; the schema guard test keeps this file in step with the schema.
 */
export const agentContentKinds = [
  "comments", "deletedComments", "workItems", "descriptionVersions", "workItemPages", "relations", "webLinks", "integrations", "activities", "runs",
  "wikiCollections", "wikiPages", "wikiTemplates", "wikiVersions", "cycles", "modules", "intakeItems", "estimates", "views", "projects",
  "outboundWebhooks", "assets", "aiChats", "exports", "skills", "recurrences",
] as const;
export type AgentContentKind = (typeof agentContentKinds)[number];
export type AgentContentCounts = Record<AgentContentKind, number>;

/** Cascading user references whose rows are content: each one is counted under the kinds listed. */
export const agentContentColumns: Record<string, readonly AgentContentKind[]> = {
  "comments.author_id": ["comments", "deletedComments"],
  "work_items.created_by": ["workItems"],
  "work_item_description_versions.created_by": ["descriptionVersions"],
  "work_item_pages.created_by": ["workItemPages"],
  "work_item_relations.created_by": ["relations"],
  "web_links.created_by": ["webLinks"],
  "work_item_integrations.created_by": ["integrations"],
  "activities.actor_id": ["activities"],
  "runs.originator_id": ["runs"],
  "wiki_collections.owner_id": ["wikiCollections"],
  "wiki_pages.owner_id": ["wikiPages"],
  "wiki_page_templates.created_by": ["wikiTemplates"],
  "wiki_page_versions.created_by": ["wikiVersions"],
  "cycles.created_by": ["cycles"],
  "modules.created_by": ["modules"],
  "intake_items.created_by": ["intakeItems"],
  "estimates.created_by": ["estimates"],
  "views.owner_id": ["views"],
  "projects.created_by": ["projects"],
  "outbound_webhooks.created_by": ["outboundWebhooks"],
  "assets.uploader_id": ["assets"],
  "ai_chats.user_id": ["aiChats"],
  "exports.owner_id": ["exports"],
  "skills.owner_id": ["skills"],
  "recurrences.creator_id": ["recurrences"],
};

/** Cascading user references that are not content; deleting the Agent may remove them, with the reason kept here. */
export const agentNonContentColumns: Record<string, string> = {
  "account.user_id": "Sign-in credential of the bot user; an Agent has none in practice.",
  "agent_access.user_id": "Access row: who may use the Agent, not content.",
  "agents.user_id": "The Agent's own row and settings.",
  "agents.created_by": "The Agent's own settings: who set it up.",
  "ai_requests.user_id": "Usage meter row for AI chat requests; no authored content.",
  "api_tokens.user_id": "Credential; revoked with the Agent.",
  "comment_mentions.user_id": "Mention: a pointer to a comment, not content.",
  "confirmations.user_id": "Pending confirmation of an AI action; it expires and is not content.",
  "daemons.owner_id": "Daemon registration (a credential), not authored content.",
  "module_members.user_id": "Membership row.",
  "notification_emails.user_id": "Notification addressed to the Agent; not content.",
  "notification_emails.actor_id": "Notification record naming the Agent as actor; not content.",
  "notifications.user_id": "Notification addressed to the Agent; not content.",
  "notifications.actor_id": "Notification record naming the Agent as actor; not content.",
  "oauth_access_token.user_id": "OAuth credential; revoked with the Agent.",
  "oauth_client.user_id": "OAuth client registration (a credential), not authored content.",
  "oauth_consent.user_id": "OAuth grant; revoked with the Agent.",
  "oauth_refresh_token.user_id": "OAuth credential; revoked with the Agent.",
  "project_members.user_id": "Membership row.",
  "project_preferences.user_id": "Personal view preferences of the bot user.",
  "runtimes.owner_id": "Runtime registration, not authored content; Runs keep their own Runtime label.",
  "session.user_id": "Login session; not content.",
  "triggers.creator_id": "Schedule or event rule of the Agent; it goes with the Agent's own Trigger rows.",
  "wiki_collection_members.user_id": "Membership row.",
  "wiki_page_favorites.user_id": "Personal bookmark.",
  "wiki_page_shares.user_id": "Share grant: access row, not content.",
  "work_item_assignees.user_id": "Assignment: a pointer to a work item, not content.",
  "workspace_invites.created_by": "Pending invitation that expires; not content.",
  "workspace_members.user_id": "Membership row.",
};

const tally = async (query: Promise<Array<{ value: number }>>) => Number((await query)[0]?.value ?? 0);

const counters: Record<AgentContentKind, (database: Database, userId: string) => Promise<number>> = {
  comments: (database, userId) => tally(database.select({ value: count() }).from(comments).where(and(eq(comments.authorId, userId), isNull(comments.deletedAt)))),
  deletedComments: (database, userId) => tally(database.select({ value: count() }).from(comments).where(and(eq(comments.authorId, userId), isNotNull(comments.deletedAt)))),
  workItems: (database, userId) => tally(database.select({ value: count() }).from(workItems).where(eq(workItems.createdBy, userId))),
  descriptionVersions: (database, userId) => tally(database.select({ value: count() }).from(workItemDescriptionVersions).where(eq(workItemDescriptionVersions.createdBy, userId))),
  workItemPages: (database, userId) => tally(database.select({ value: count() }).from(workItemPages).where(eq(workItemPages.createdBy, userId))),
  relations: (database, userId) => tally(database.select({ value: count() }).from(workItemRelations).where(eq(workItemRelations.createdBy, userId))),
  webLinks: (database, userId) => tally(database.select({ value: count() }).from(webLinks).where(eq(webLinks.createdBy, userId))),
  integrations: (database, userId) => tally(database.select({ value: count() }).from(workItemIntegrations).where(eq(workItemIntegrations.createdBy, userId))),
  activities: (database, userId) => tally(database.select({ value: count() }).from(activities).where(eq(activities.actorId, userId))),
  runs: (database, userId) => tally(database.select({ value: count() }).from(runs).where(eq(runs.originatorId, userId))),
  wikiCollections: (database, userId) => tally(database.select({ value: count() }).from(collections).where(eq(collections.ownerId, userId))),
  wikiPages: (database, userId) => tally(database.select({ value: count() }).from(wikiPages).where(eq(wikiPages.ownerId, userId))),
  wikiTemplates: (database, userId) => tally(database.select({ value: count() }).from(wikiPageTemplates).where(eq(wikiPageTemplates.createdBy, userId))),
  wikiVersions: (database, userId) => tally(database.select({ value: count() }).from(wikiPageVersions).where(eq(wikiPageVersions.createdBy, userId))),
  cycles: (database, userId) => tally(database.select({ value: count() }).from(cycles).where(eq(cycles.createdBy, userId))),
  modules: (database, userId) => tally(database.select({ value: count() }).from(modules).where(eq(modules.createdBy, userId))),
  intakeItems: (database, userId) => tally(database.select({ value: count() }).from(intakeItems).where(eq(intakeItems.createdBy, userId))),
  estimates: (database, userId) => tally(database.select({ value: count() }).from(estimates).where(eq(estimates.createdBy, userId))),
  views: (database, userId) => tally(database.select({ value: count() }).from(views).where(eq(views.ownerId, userId))),
  projects: (database, userId) => tally(database.select({ value: count() }).from(projects).where(eq(projects.createdBy, userId))),
  outboundWebhooks: (database, userId) => tally(database.select({ value: count() }).from(outboundWebhooks).where(eq(outboundWebhooks.createdBy, userId))),
  assets: (database, userId) => tally(database.select({ value: count() }).from(assets).where(eq(assets.uploaderId, userId))),
  aiChats: (database, userId) => tally(database.select({ value: count() }).from(aiChats).where(eq(aiChats.userId, userId))),
  exports: (database, userId) => tally(database.select({ value: count() }).from(exportRows).where(eq(exportRows.ownerId, userId))),
  skills: (database, userId) => tally(database.select({ value: count() }).from(skills).where(eq(skills.ownerId, userId))),
  recurrences: (database, userId) => tally(database.select({ value: count() }).from(recurrences).where(eq(recurrences.creatorId, userId))),
};

/** The content an Agent's bot user wrote or created, per kind. The Agent delete refusal and the settings page both read this. */
export async function agentContentCounts(database: Database, userId: string): Promise<AgentContentCounts> {
  const counts = {} as AgentContentCounts;
  // Sequential: the queries share one transaction connection.
  for (const kind of agentContentKinds) counts[kind] = await counters[kind](database, userId);
  return counts;
}

export function totalAgentContent(counts: AgentContentCounts) {
  return agentContentKinds.reduce((sum, kind) => sum + counts[kind], 0);
}
