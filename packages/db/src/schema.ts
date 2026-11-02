import { type AnyPgColumn, bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique, uuid, customType } from "drizzle-orm/pg-core";

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  locale: text("locale").notNull().default("en"),
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
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({ dataType: () => "bytea", toDriver: (value) => Buffer.from(value), fromDriver: (value) => new Uint8Array(value) });

export const wikiPages = pgTable("wiki_pages", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => wikiPages.id, { onDelete: "set null" }),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: jsonb("content"),
  contentText: text("content_text").notNull().default(""),
  ydocState: bytea("ydoc_state"),
  access: text("access").notNull().default("public"),
  sortOrder: doublePrecision("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [index().on(table.workspaceId, table.parentId), index().on(table.projectId)]);

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
