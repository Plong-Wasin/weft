import { type AnyPgColumn, bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique, uniqueIndex, uuid, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  locale: text("locale").notNull().default("en"),
  /** A bot user created for an Agent: it has no credentials and never signs in. */
  isAgent: boolean("is_agent").notNull().default(false),
  /** Set by a workspace Admin's forced reset: every Action is refused until the person chooses a new password. */
  forcePasswordReset: boolean("force_password_reset").notNull().default(false),
  /** Plain-language reason for the last sign-out an Admin caused; shown once at the next sign-in. */
  securityNotice: text("security_notice"),
  /** Notification kinds this person gets by email. Empty means no notification emails. */
  emailNotificationKinds: text("email_notification_kinds").array().notNull().default(sql`ARRAY['assignment','mention','reply','run_result']::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  allowAutopilot: boolean("allow_autopilot").notNull().default(false),
  runtimeRunsPerPersonPerHour: integer("runtime_runs_per_person_per_hour").notNull().default(30),
  runtimeRunsPerAgentPerHour: integer("runtime_runs_per_agent_per_hour").notNull().default(30),
});

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("Admin"),
  /** Set while a workspace Admin has suspended the person: their requests in this workspace are refused and their Runs stopped. */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Configuration of an Agent; the Agent itself is the bot user in `user_id`, a workspace member that is not a person. */
export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  instructions: text("instructions").notNull().default(""),
  model: text("model").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  autopilot: boolean("autopilot").notNull().default(false),
  allowProjectActions: boolean("allow_project_actions").notNull().default(false),
  allowMemberActions: boolean("allow_member_actions").notNull().default(false),
  allowFeatureActions: boolean("allow_feature_actions").notNull().default(false),
  allowExportActions: boolean("allow_export_actions").notNull().default(false),
  /** True: opened to every project, including ones created later. Otherwise only the rows of `agent_projects`. */
  allProjects: boolean("all_projects").notNull().default(false),
  maxToolCalls: integer("max_tool_calls").notNull().default(25),
  maxTokens: integer("max_tokens").notNull().default(200000),
  timeoutSeconds: integer("timeout_seconds").notNull().default(1800),
  /** Provider-reported tokens per calendar month; null means no budget. */
  monthlyTokenBudget: integer("monthly_token_budget"),
  runtimeId: uuid("runtime_id").references(() => runtimes.id, { onDelete: "set null" }),
  runtimeProfileId: uuid("runtime_profile_id").references(() => runtimeProfiles.id, { onDelete: "set null" }),
  cliModel: text("cli_model"),
  maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(6),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.workspaceId)]);

export const agentProjects = pgTable("agent_projects", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.agentId, table.projectId] })]);

/** People allowed to assign or mention an Agent; initialized to the least-privilege defaults. */
export const agentAccess = pgTable("agent_access", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.agentId, table.userId] })]);

export const workspaceInvites = pgTable("workspace_invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  role: text("role").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  name: text("name").notNull(),
  visibility: text("visibility").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  workItemSequence: integer("work_item_sequence").notNull().default(0),
  /** Project feature toggles: off hides the feature and rejects its Actions, the data is kept. */
  cyclesEnabled: boolean("cycles_enabled").notNull().default(true),
  modulesEnabled: boolean("modules_enabled").notNull().default(true),
  intakeEnabled: boolean("intake_enabled").notNull().default(true),
  /** When a linked pull or merge request merges, move its work item to the project's done state. Off by default. */
  mergedPrMovesToDone: boolean("merged_pr_moves_to_done").notNull().default(false),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.workspaceId, table.key)]);

export const projectKeyAliases = pgTable("project_key_aliases", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.workspaceId, table.key)]);

export const projectMembers = pgTable("project_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.projectId, table.userId)]);

export const workItemStates = pgTable("work_item_states", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  group: text("state_group").notNull(),
  sortOrder: integer("sort_order").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
// SQL-only, kept in migration 0026: partial unique index work_item_states_one_triage_idx on (project_id) WHERE state_group = 'triage'
// (one Triage state per project); it is not declared here so the schema does not drift from the migration SQL.
}, (table) => [unique().on(table.projectId, table.name)]);

export const workItems = pgTable("work_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  title: text("title").notNull(),
  description: jsonb("description"),
  descriptionText: text("description_text").notNull().default(""),
  stateId: uuid("state_id").notNull().references(() => workItemStates.id),
  priority: text("priority").notNull().default("none"),
  /** The Estimate point sizing this work item; null when unsized. Cleared when its point is deleted. */
  estimatePointId: uuid("estimate_point_id").references((): AnyPgColumn => estimatePoints.id, { onDelete: "set null" }),
  sortOrder: doublePrecision("sort_order").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set when the work item enters a state of the completed group, cleared when it leaves (trigger in migration 0063); cancelled does not set it. */
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  parentId: uuid("parent_id").references((): AnyPgColumn => workItems.id, { onDelete: "set null" }),
  startDate: date("start_date"),
  dueDate: date("due_date"),
}, (table) => [unique().on(table.projectId, table.sequence), index().on(table.projectId, table.sortOrder), index().on(table.projectId, table.stateId, table.sortOrder), index().on(table.parentId)]);

export const workItemDescriptionVersions = pgTable("work_item_description_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  content: jsonb("content"),
  contentText: text("content_text").notNull().default(""),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.workItemId, table.createdAt)]);

export const labels = pgTable("labels", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#6b7280"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.projectId, table.name)]);

export const workItemAssignees = pgTable("work_item_assignees", {
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.workItemId, table.userId] })]);

export const workItemLabels = pgTable("work_item_labels", {
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.workItemId, table.labelId] })]);

export const activities = pgTable("activities", {
  id: uuid("id").defaultRandom().primaryKey(),
  seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  /** Null for workspace-level entities such as wiki pages. */
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  field: text("field").notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  actorId: text("actor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  chatId: uuid("chat_id"),
  /** Set when an Agent made the change: the Run, and the person whose permissions it used. */
  runId: uuid("run_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
  originatorId: text("originator_id").references(() => users.id, { onDelete: "set null" }),
  /** Set on every Activity written by one Bulk edit, so the timeline can show they came together. */
  bulkEditId: uuid("bulk_edit_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.entityType, table.entityId, table.seq)]);

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  daemonOnly: boolean("daemon_only").notNull().default(false),
}, (table) => [index().on(table.userId)]);

/** A signed-in CLI process which owns local Runtimes. */
export const daemons = pgTable("daemons", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull(),
  tokenId: uuid("token_id").notNull().references(() => apiTokens.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex().on(table.tokenId)]);

/** A Runtime is one CLI offered by a Daemon to one workspace. */
export const runtimes = pgTable("runtimes", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  daemonId: uuid("daemon_id").notNull().references(() => daemons.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  agentCli: text("agent_cli").notNull(),
  shared: boolean("shared").notNull().default(false),
  enforceSandbox: boolean("enforce_sandbox").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex().on(table.workspaceId, table.daemonId, table.agentCli), index().on(table.workspaceId, table.shared)]);

/** A Daemon-owned permission profile for one CLI Runtime. */
export const runtimeProfiles = pgTable("runtime_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  runtimeId: uuid("runtime_id").notNull().references(() => runtimes.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sandbox: text("sandbox").notNull().default("full"),
  filesystemAllowlist: jsonb("filesystem_allowlist").$type<string[]>().notNull().default([]),
  networkAllowlist: jsonb("network_allowlist").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex().on(table.runtimeId, table.name), index().on(table.runtimeId)]);

export const comments = pgTable("comments", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  workItemId: uuid("work_item_id").references(() => workItems.id, { onDelete: "cascade" }),
  wikiPageId: uuid("wiki_page_id").references(() => wikiPages.id, { onDelete: "cascade" }),
  anchor: text("anchor"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  authorId: text("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  body: jsonb("body").notNull(),
  bodyText: text("body_text").notNull(),
  /** The top-level comment this one replies to; replies are one level deep. */
  parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  /** The Run whose Agent wrote this comment. */
  runId: uuid("run_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [index().on(table.workItemId, table.createdAt), index().on(table.wikiPageId, table.createdAt), index().on(table.parentId)]);

/** The body a comment had before an edit. Readable only by the author and workspace Admins; removed with the comment. */
export const commentVersions = pgTable("comment_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  commentId: uuid("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
  body: jsonb("body").notNull(),
  bodyText: text("body_text").notNull(),
  /** When this body was written: the comment's previous edit time, or its creation time. */
  writtenAt: timestamp("written_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.commentId, table.createdAt)]);

export const commentMentions = pgTable("comment_mentions", {
  commentId: uuid("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.commentId, table.userId] }), index().on(table.userId)]);

export const assets = pgTable("assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  /** Null for wiki page assets: wiki pages are workspace-level. */
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  /** The one owning entity: "work_item" (attachments, description images), "comment" or "wiki_page". */
  ownerType: text("owner_type").notNull(),
  ownerId: uuid("owner_id").notNull(),
  uploaderId: text("uploader_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull().unique(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
}, (table) => [index().on(table.ownerType, table.ownerId)]);
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({ dataType: () => "bytea", toDriver: (value) => Buffer.from(value), fromDriver: (value) => new Uint8Array(value) });

export const collections = pgTable("wiki_collections", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("📚"),
  visibility: text("visibility").notNull().default("public"),
  isDefault: boolean("is_default").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.workspaceId, table.deletedAt)]);

export const collectionMembers = pgTable("wiki_collection_members", {
  collectionId: uuid("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.collectionId, table.userId] })]);

/** Workspace-wide reusable page content; only workspace Admins manage templates. */
export const wikiPageTemplates = pgTable("wiki_page_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: jsonb("content"),
  contentText: text("content_text").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.workspaceId, table.createdAt)]);

export const wikiPages = pgTable("wiki_pages", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  collectionId: uuid("collection_id").references(() => collections.id, { onDelete: "set null" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => wikiPages.id, { onDelete: "set null" }),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: jsonb("content"),
  contentText: text("content_text").notNull().default(""),
  ydocState: bytea("ydoc_state"),
  publishedTokenHash: text("published_token_hash").unique(),
  access: text("access").notNull().default("public"),
  sortOrder: doublePrecision("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [index().on(table.workspaceId, table.parentId), index().on(table.projectId)]);

export const wikiPageShares = pgTable("wiki_page_shares", {
  pageId: uuid("page_id").notNull().references(() => wikiPages.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.pageId, table.userId] }), index().on(table.userId)]);


export const wikiPageVersions = pgTable("wiki_page_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  pageId: uuid("page_id").notNull().references(() => wikiPages.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: jsonb("content"),
  contentText: text("content_text").notNull().default(""),
  ydocState: bytea("ydoc_state"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.pageId, table.createdAt)]);

export const wikiPageFavorites = pgTable("wiki_page_favorites", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  pageId: uuid("page_id").notNull().references(() => wikiPages.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.pageId] }), index().on(table.pageId)]);

/** A work item may point at any Page or Wiki page its members can read. */
export const workItemPages = pgTable("work_item_pages", {
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  pageId: uuid("page_id").notNull().references(() => wikiPages.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.workItemId, table.pageId] }), index().on(table.pageId)]);

export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
  dedupeKey: text("dedupe_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [index().on(table.status, table.runAt)]);

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  workItemId: uuid("work_item_id").references(() => workItems.id, { onDelete: "cascade" }),
  wikiPageId: uuid("wiki_page_id").references(() => wikiPages.id, { onDelete: "cascade" }),
  commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
  recurrenceId: uuid("recurrence_id").references(() => recurrences.id, { onDelete: "cascade" }),
  detail: text("detail"),
  jobId: uuid("job_id").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.jobId, table.userId), index().on(table.userId, table.workspaceId, table.createdAt)]);
/** A notification waiting for the next email digest. Rows are written only for kinds the recipient chose; the digest job marks them sent. */
export const notificationEmails = pgTable("notification_emails", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  workItemId: uuid("work_item_id").references(() => workItems.id, { onDelete: "cascade" }),
  wikiPageId: uuid("wiki_page_id").references(() => wikiPages.id, { onDelete: "cascade" }),
  commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
  /** For run_result: the Run's final status. */
  detail: text("detail"),
  /** The notify job that produced the row; with userId it keeps a retried job from queueing twice. Null for Run results. */
  jobId: uuid("job_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.jobId, table.userId), index().on(table.userId, table.sentAt, table.createdAt), index().on(table.createdAt)]);
export const aiChats = pgTable("ai_chats", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /** Chat mode: Ask, Build, or Autopilot. */
  mode: text("mode").notNull().default("build"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.userId, table.workspaceId, table.updatedAt)]);

export const aiMessages = pgTable("ai_messages", {
  id: text("id").primaryKey(),
  chatId: uuid("chat_id").notNull().references(() => aiChats.id, { onDelete: "cascade" }),
  seq: serial("seq").notNull(),
  role: text("role").notNull(),
  parts: jsonb("parts").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.chatId, table.seq)]);

/** One row per accepted AI chat request: the rate-limit ledger. The client never chooses these ids, so a replayed message id cannot dodge the cap. */
export const aiRequests = pgTable("ai_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.userId, table.createdAt)]);

export const confirmations = pgTable("confirmations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  /** The AI chat that proposed it; null for a Confirmation proposed by a Run. */
  chatId: uuid("chat_id").references(() => aiChats.id, { onDelete: "cascade" }),
  /** The Run that proposed it, which waits on the decision; null for a chat's. */
  runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
  /** The Run's tool call this Confirmation answers. */
  toolCallId: text("tool_call_id"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  input: jsonb("input").notNull(),
  /** Target state when proposed; compared with the live state on confirm. Null for creates. */
  snapshot: jsonb("snapshot"),
  status: text("status").notNull().default("pending"),
  result: jsonb("result"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [index().on(table.chatId), index().on(table.runId), index().on(table.expiresAt)]);

/** One row per linked pair. `blocked_by` reads "work_item_id is blocked by related_work_item_id"; the inverse view is `blocks`. duplicate and relates_to are symmetric. */
export const workItemRelations = pgTable("work_item_relations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  relatedWorkItemId: uuid("related_work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
// SQL-only, kept in migration 0020 because drizzle cannot express it without changing the SQL: unique index
// work_item_relations_pair_unique on (LEAST(work_item_id, related_work_item_id), GREATEST(work_item_id, related_work_item_id)).
}, (table) => [index().on(table.workItemId), index().on(table.relatedWorkItemId)]);

/** An external HTTP(S) resource attached to a work item. */
export const webLinks = pgTable("web_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  title: text("title"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.workItemId)]);

export const workItemIntegrations = pgTable("work_item_integrations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  /** The webhook secret sealed by integration-secrets.ts; only the server reads it. */
  secretSealed: text("secret_sealed").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.workspaceId, table.provider)]);

export const workItemIntegrationRepositories = pgTable("work_item_integration_repositories", {
  id: uuid("id").defaultRandom().primaryKey(),
  integrationId: uuid("integration_id").notNull().references(() => workItemIntegrations.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.integrationId, table.fullName)]);

export const workItemIntegrationDeliveries = pgTable("work_item_integration_deliveries", {
  integrationId: uuid("integration_id").notNull().references(() => workItemIntegrations.id, { onDelete: "cascade" }),
  deliveryId: text("delivery_id").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.integrationId, table.deliveryId] })]);

export const workItemPullRequests = pgTable("work_item_pull_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  repository: text("repository").notNull(),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  state: text("state").notNull(),
  checks: text("checks").notNull().default("none"),
  headSha: text("head_sha"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.workItemId, table.provider, table.repository, table.number), index().on(table.provider, table.repository, table.number)]);

export const cycles = pgTable("cycles", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set only on a completed Cycle; the Cycle keeps its work items and drops out of the default list. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  /** Soft delete: the row stays, its membership rows are removed, and every read treats it as gone. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [index().on(table.projectId, table.startDate)]);

/** The primary key on work_item_id is what keeps a work item in at most one Cycle. */
export const cycleItems = pgTable("cycle_items", {
  workItemId: uuid("work_item_id").primaryKey().references(() => workItems.id, { onDelete: "cascade" }),
  cycleId: uuid("cycle_id").notNull().references(() => cycles.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.cycleId)]);

export const modules = pgTable("modules", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Set by hand, never computed: backlog, planned, in-progress, paused, completed, cancelled. */
  status: text("status").notNull().default("backlog"),
  leadId: text("lead_id").references(() => users.id, { onDelete: "set null" }),
  startDate: date("start_date"),
  endDate: date("end_date"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  /** Soft delete: the Module disappears, its work items stay. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.projectId, table.createdAt)]);

export const moduleMembers = pgTable("module_members", {
  moduleId: uuid("module_id").notNull().references(() => modules.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.moduleId, table.userId] })]);

/** Many Modules per work item: the key is the pair (a work item has at most one Cycle but any number of Modules). */
export const moduleItems = pgTable("module_items", {
  moduleId: uuid("module_id").notNull().references(() => modules.id, { onDelete: "cascade" }),
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.moduleId, table.workItemId] }), index().on(table.workItemId)]);

/** One row per work item submitted to Intake. The work item itself lives in the Triage state group until accepted. A snoozed row counts as pending again once `snoozed_till` has passed. */
export const intakeItems = pgTable("intake_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workItemId: uuid("work_item_id").notNull().unique().references(() => workItems.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull().default("pending"),
  snoozedTill: timestamp("snoozed_till", { withTimezone: true }),
  duplicateTo: uuid("duplicate_to").references(() => workItems.id, { onDelete: "set null" }),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.projectId, table.outcome)]);

/** A saved View: a PQL filter, a layout, grouping, ordering and visible properties of one project. It never stores work item data. */
export const views = pgTable("views", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  /** Null for a workspace View, which spans every project the viewer can access. */
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  /** project or workspace. */
  scope: text("scope").notNull().default("project"),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** The PQL filter, the single stored form of the filters. */
  query: text("query").notNull().default(""),
  layout: text("layout").notNull().default("list"),
  groupBy: text("group_by").notNull().default("state"),
  subGroupBy: text("sub_group_by").notNull().default("none"),
  orderBy: text("order_by").notNull().default("manual"),
  orderDirection: text("order_direction").notNull().default("asc"),
  /** Visible properties in display order. */
  properties: jsonb("properties").$type<string[]>().notNull(),
  /** public: every project member sees it; private: only its owner. */
  access: text("access").notNull().default("public"),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.projectId, table.createdAt)]);

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    sectorIdentifier: text("sector_identifier"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes")
      .array()
      .default([]),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    frontchannelLogoutUri: text("frontchannel_logout_uri"),
    frontchannelLogoutSessionRequired: boolean(
      "frontchannel_logout_session_required",
    ),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (table) => [index("oauthClient_userId_idx").on(table.userId)],
);

export const oauthResource = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean(
    "dpop_bound_access_tokens_required",
  ).default(false),
  disabled: boolean("disabled").default(false),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("oauthClientResource_clientId_idx").on(table.clientId),
    index("oauthClientResource_resourceId_idx").on(table.resourceId),
    unique().on(table.clientId, table.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at"),
    revoked: timestamp("revoked"),
    rotatedAt: timestamp("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at"),
    authTime: timestamp("auth_time"),
    acr: text("acr"),
    amr: text("amr").array(),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauthRefreshToken_clientId_idx").on(table.clientId),
    index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
    index("oauthRefreshToken_userId_idx").on(table.userId),
    index("oauthRefreshToken_authorizationCodeId_idx").on(
      table.authorizationCodeId,
    ),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at"),
    revoked: timestamp("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauthAccessToken_clientId_idx").on(table.clientId),
    index("oauthAccessToken_sessionId_idx").on(table.sessionId),
    index("oauthAccessToken_userId_idx").on(table.userId),
    index("oauthAccessToken_authorizationCodeId_idx").on(
      table.authorizationCodeId,
    ),
    index("oauthAccessToken_refreshId_idx").on(table.refreshId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("oauthConsent_clientId_idx").on(table.clientId),
    index("oauthConsent_userId_idx").on(table.userId),
  ],
);

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});

/** Statuses of a Run that still hold the work item: at most one such Run exists per work item. */
export const activeRunStatuses = ["queued", "dispatched", "running", "waiting_confirmation", "awaiting_input", "stopping"] as const;

/** One execution of an Agent on a work item, on behalf of the Originator (the person who assigned or mentioned it). */
export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workItemId: uuid("work_item_id").references(() => workItems.id, { onDelete: "cascade" }),
  /** Null once the Agent is deleted; the Run stays as history. */
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  originatorId: text("originator_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The comment whose mention started the Run: the request the Agent answers. Null for a Run started by assignment, or once the comment is gone. */
  commentId: uuid("comment_id").references(() => comments.id, { onDelete: "set null" }),
  triggerId: uuid("trigger_id").references(() => triggers.id, { onDelete: "set null" }),
  status: text("status").notNull().default("queued"),
  runtimeId: uuid("runtime_id").references(() => runtimes.id, { onDelete: "set null" }),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  finalOutput: text("final_output"),
  /** Why a failed Run failed: a short machine code such as `tool_call_limit`, `token_limit`, `timeout`, `model_error`. */
  failureReason: text("failure_reason"),
  /** The Run this one repeats: set by a manual rerun and by an automatic retry. */
  rerunOfId: uuid("rerun_of_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
  /** How many automatic retries came before this Run in its chain; 0 for a Run a person started or reran. */
  attempt: integer("attempt").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [index().on(table.workItemId), index().on(table.agentId, table.status)]);

/** One step of a Run's transcript. The transcript is the source of truth: a resumed Run rebuilds its conversation from these rows. */
export const runMessages = pgTable("run_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  /** `thought`, `action`, `tool_result`, `confirmation`, `response`, `elicitation` or `error`. */
  type: text("type").notNull(),
  toolName: text("tool_name"),
  /** Pairs an `action` with its `tool_result`. */
  toolCallId: text("tool_call_id"),
  input: jsonb("input"),
  output: jsonb("output"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("run_messages_run_id_seq_unique").on(table.runId, table.seq)]);


/** The scale a project sizes work items with: at most one per project. `enabled` hides it and refuses writes without losing the points. */
export const estimates = pgTable("estimates", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().unique().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** points (numbers kept as text) or categories (free labels). */
  type: text("type").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Hashed, short-lived credentials issued to a Runtime Run. */
export const runTokens = pgTable("run_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }).unique(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const triggers = pgTable("triggers", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  creatorId: text("creator_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  eventType: text("event_type"),
  schedule: text("schedule"),
  expression: text("expression"),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  paused: boolean("paused").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.agentId, table.projectId)]);

/** A scheduled template that creates Work items. */
export const recurrences = pgTable("recurrences", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  creatorId: text("creator_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  template: jsonb("template").notNull(),
  schedule: text("schedule").notNull(),
  interval: integer("interval").notNull().default(1),
  timezone: text("timezone").notNull().default("UTC"),
  status: text("status").notNull().default("active"),
  endDate: date("end_date"),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  pausedReason: text("paused_reason"),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  lastWarning: text("last_warning"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.projectId, table.status)]);

/** One value of an Estimate, 2 to 6 per Estimate; `position` is the display order. */
export const estimatePoints = pgTable("estimate_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  estimateId: uuid("estimate_id").notNull().references(() => estimates.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  value: text("value").notNull(),
}, (table) => [index().on(table.estimateId, table.position)]);

/** Reusable text instructions; Personal rows belong to one member, Workspace rows are shared. */
export const skills = pgTable("skills", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  instructions: text("instructions").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("skills_personal_name_unique").on(table.workspaceId, table.ownerId, table.name).where(sql`${table.scope} = 'personal'`),
  uniqueIndex("skills_workspace_name_unique").on(table.workspaceId, table.name).where(sql`${table.scope} = 'workspace'`),
  index().on(table.workspaceId, table.scope),
]);

/** Workspace Skills enabled for an Agent. A cascading join keeps deleted Skills and Agents detached. */
export const agentSkills = pgTable("agent_skills", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.agentId, table.skillId] }), index().on(table.skillId)]);

/** A file of one member's work items for chosen projects, built by the `export_build` job and kept in the Asset storage. Visible only to its owner. */
export const exports = pgTable("exports", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The project ids chosen at request time, sorted. */
  projectIds: jsonb("project_ids").$type<string[]>().notNull(),
  format: text("format").notNull(),
  status: text("status").notNull().default("queued"),
  failureReason: text("failure_reason"),
  fileKey: text("file_key"),
  fileSize: bigint("file_size", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Set by the cleanup job once the stored file is deleted; the row stays in the list. */
  expiredAt: timestamp("expired_at", { withTimezone: true }),
}, (table) => [index().on(table.workspaceId, table.ownerId, table.createdAt)]);
