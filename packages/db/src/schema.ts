import { type AnyPgColumn, bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  locale: text("locale").notNull().default("en"),
  /** A bot user created for an Agent: it has no credentials and never signs in. */
  isAgent: boolean("is_agent").notNull().default(false),
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
});

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("Admin"),
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
  /** True: opened to every project, including ones created later. Otherwise only the rows of `agent_projects`. */
  allProjects: boolean("all_projects").notNull().default(false),
  maxToolCalls: integer("max_tool_calls").notNull().default(25),
  maxTokens: integer("max_tokens").notNull().default(200000),
  timeoutSeconds: integer("timeout_seconds").notNull().default(600),
  /** Provider-reported tokens per calendar month; null means no budget. */
  monthlyTokenBudget: integer("monthly_token_budget"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.workspaceId)]);

export const agentProjects = pgTable("agent_projects", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.agentId, table.projectId] })]);

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
  sortOrder: doublePrecision("sort_order").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
}, (table) => [index().on(table.userId)]);

export const comments = pgTable("comments", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  body: jsonb("body").notNull(),
  bodyText: text("body_text").notNull(),
  /** The top-level comment this one replies to; replies are one level deep. */
  parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [index().on(table.workItemId, table.createdAt), index().on(table.parentId)]);

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
export const wikiPages = pgTable("wiki_pages", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => wikiPages.id, { onDelete: "set null" }),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: jsonb("content"),
  contentText: text("content_text").notNull().default(""),
  access: text("access").notNull().default("public"),
  sortOrder: doublePrecision("sort_order").notNull().default(0),
  lockedBy: text("locked_by").references(() => users.id, { onDelete: "set null" }),
  lockExpiresAt: timestamp("lock_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [index().on(table.workspaceId, table.parentId)]);

export const wikiPageVersions = pgTable("wiki_page_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  pageId: uuid("page_id").notNull().references(() => wikiPages.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: jsonb("content"),
  contentText: text("content_text").notNull().default(""),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index().on(table.pageId, table.createdAt)]);

/** Links a wiki page to a project: the project's Pages are the pages linked to it. */
export const wikiPageProjects = pgTable("wiki_page_projects", {
  pageId: uuid("page_id").notNull().references(() => wikiPages.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  linkedBy: text("linked_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.pageId, table.projectId] }), index().on(table.projectId)]);

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
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.jobId, table.userId), index().on(table.userId, table.workspaceId, table.createdAt)]);
export const aiChats = pgTable("ai_chats", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /** Chat mode: "ask" (Read actions only) or "build" (Read plus proposed Write actions). */
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
  chatId: uuid("chat_id").notNull().references(() => aiChats.id, { onDelete: "cascade" }),
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
}, (table) => [index().on(table.chatId), index().on(table.expiresAt)]);

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
export const activeRunStatuses = ["queued", "running", "waiting_confirmation", "awaiting_input", "stopping"] as const;

/** One execution of an Agent on a work item, on behalf of the Originator (the person who assigned or mentioned it). */
export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workItemId: uuid("work_item_id").notNull().references(() => workItems.id, { onDelete: "cascade" }),
  /** Null once the Agent is deleted; the Run stays as history. */
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  originatorId: text("originator_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The comment whose mention started the Run: the request the Agent answers. Null for a Run started by assignment, or once the comment is gone. */
  commentId: uuid("comment_id").references(() => comments.id, { onDelete: "set null" }),
  status: text("status").notNull().default("queued"),
  /** Why a failed Run failed: a short machine code such as `tool_call_limit`, `token_limit`, `timeout`, `model_error`. */
  failureReason: text("failure_reason"),
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

