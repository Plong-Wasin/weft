import { and, eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import type { Database } from "@weft/db";
import { confirmations, cycles, intakeItems, modules, projects, views, wikiPages, workItems } from "@weft/db";
import { createActionList } from "./registry";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { liveWorkItems } from "./triage";

/** A Confirmation card stays valid for 24 hours. */
export const confirmationTtlMs = 24 * 60 * 60 * 1000;

/**
 * Write actions the AI may propose: work items, wiki pages, and the phase 2 structures (Cycles, Modules,
 * Intake, Relations, comment replies, project feature toggles). Each is a Write action, so it only ever runs
 * after the user confirms its card. Everything else (project create/delete, members, tokens, workspaces, so
 * `delete_project` and `delete_workspace` too) is not offered.
 */
export const aiWriteActions = [
  "create_work_item", "update_work_item", "move_work_item", "delete_work_item",
  "create_wiki_page", "update_wiki_page", "move_wiki_page", "delete_wiki_page",
  "create_cycle", "update_cycle", "add_cycle_items", "remove_cycle_items", "transfer_cycle_items", "archive_cycle", "delete_cycle",
  "create_module", "update_module", "add_module_items", "remove_module_items", "archive_module", "unarchive_module", "delete_module",
  "submit_intake_item", "update_intake_item", "accept_intake_item", "reject_intake_item", "snooze_intake_item", "duplicate_intake_item",
  "create_work_item_relation", "remove_work_item_relation",
  "create_view", "update_view", "delete_view",
  "create_comment",
  "set_project_features",
] as const;

/** Write actions a workspace Guest may also run (the action's own project check decides); every other proposal needs workspace write. */
const guestAllowedActions = new Set(["submit_intake_item"]);
const roleFor = (action: string) => guestAllowedActions.has(action) ? "read" as const : "write" as const;

export type ConfirmationStatus = "pending" | "confirmed" | "rejected" | "failed" | "expired";
export interface DiffEntry { field: string; before: unknown; after: unknown }
export interface ConfirmationCard {
  id: string; chatId: string; action: string; input: Record<string, unknown>;
  status: ConfirmationStatus; expiresAt: string; result: unknown; error?: string;
}
export type ConfirmOutcome =
  | { status: "confirmed"; result: unknown }
  | { status: "changed"; diff: DiffEntry[] }
  | { status: "expired" | "already_resolved" }
  | { status: "failed"; error: string };

type Snapshot = Record<string, unknown> | null;
type Row = typeof confirmations.$inferSelect;

/** The fields the user should see change between proposal and confirm; null when the action has no existing target. */
async function snapshotOf(db: Database, userId: string, input: Record<string, unknown>): Promise<Snapshot> {
  if (typeof input.workItemId === "string") {
    const [item] = await db.select().from(workItems).where(and(eq(workItems.id, input.workItemId), liveWorkItems));
    if (!item) throw new ActionError("Work item not found", 404);
    await requireProjectAccess(db, userId, item.projectId, "read");
    return { title: item.title, description: item.descriptionText, stateId: item.stateId, priority: item.priority, parentId: item.parentId, startDate: item.startDate, dueDate: item.dueDate };
  }
  if (typeof input.pageId === "string") {
    const [page] = await db.select().from(wikiPages).where(eq(wikiPages.id, input.pageId));
    if (!page || page.deletedAt) throw new ActionError("Wiki page not found", 404);
    await requireWorkspaceRole(db, userId, page.workspaceId, "read");
    if (page.access === "private" && page.ownerId !== userId) throw new ActionError("Wiki page not found", 404);
    return { title: page.title, content: page.contentText, parentId: page.parentId };
  }
  return null;
}

const targetKeys = ["workItemId", "pageId", "cycleId", "moduleId", "intakeItemId", "viewId", "projectId"] as const;

async function workspaceOfTarget(db: Database, input: Record<string, unknown>): Promise<string | null> {
  if (typeof input.workItemId === "string") return (await db.select({ id: workItems.workspaceId }).from(workItems).where(eq(workItems.id, input.workItemId)))[0]?.id ?? null;
  if (typeof input.pageId === "string") return (await db.select({ id: wikiPages.workspaceId }).from(wikiPages).where(eq(wikiPages.id, input.pageId)))[0]?.id ?? null;
  if (typeof input.cycleId === "string") return (await db.select({ id: cycles.workspaceId }).from(cycles).where(eq(cycles.id, input.cycleId)))[0]?.id ?? null;
  if (typeof input.moduleId === "string") return (await db.select({ id: modules.workspaceId }).from(modules).where(eq(modules.id, input.moduleId)))[0]?.id ?? null;
  if (typeof input.intakeItemId === "string") return (await db.select({ id: intakeItems.workspaceId }).from(intakeItems).where(eq(intakeItems.id, input.intakeItemId)))[0]?.id ?? null;
  if (typeof input.viewId === "string") return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.viewId) ? null : (await db.select({ id: views.workspaceId }).from(views).where(eq(views.id, input.viewId)))[0]?.id ?? null;
  if (typeof input.projectId === "string") return (await db.select({ id: projects.workspaceId }).from(projects).where(eq(projects.id, input.projectId)))[0]?.id ?? null;
  return null;
}

function diffOf(before: Snapshot, after: Snapshot): DiffEntry[] {
  if (!before || !after) return [];
  return Object.keys(after).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])).map((field) => ({ field, before: before[field], after: after[field] }));
}

/**
 * Confirmation cards for AI-proposed Write actions. A proposal only stores the exact input; the
 * action runs on confirm, as the proposing user, with source "ai" and the chat id.
 */
export function createConfirmationStore(db: Database, options: { now?: () => Date; /** @internal Test seam: replaces the registry list. Production code never passes it. */ actions?: ReturnType<typeof createActionList> } = {}) {
  const now = options.now ?? (() => new Date());
  const actions = new Map((options.actions ?? createActionList(db)).filter((action) => (aiWriteActions as readonly string[]).includes(action.name)).map((action) => [action.name, action]));

  function card(row: Row): ConfirmationCard {
    const expired = row.status === "pending" && row.expiresAt.getTime() <= now().getTime();
    return {
      id: row.id, chatId: row.chatId, action: row.action, input: row.input as Record<string, unknown>,
      status: expired ? "expired" : row.status as ConfirmationStatus, expiresAt: row.expiresAt.toISOString(), result: row.result ?? null,
      ...(row.status === "failed" && row.result ? { error: (row.result as { error?: string }).error } : {}),
    };
  }
  async function load(userId: string, id: string) {
    const [row] = await db.select().from(confirmations).where(and(eq(confirmations.id, id), eq(confirmations.userId, userId)));
    if (!row) throw new ActionError("Confirmation not found", 404);
    return row;
  }

  return {
    async propose(input: { userId: string; workspaceId: string; chatId: string; action: string; input: Record<string, unknown> }): Promise<ConfirmationCard> {
      const action = actions.get(input.action);
      if (!action) throw new ActionError(`The AI cannot propose "${input.action}"`, 403);
      // The chat's workspace is injected where the action takes one, so the model never picks it.
      const payload: Record<string, unknown> = { ...input.input, ...("workspaceId" in (action.input as unknown as { properties: object }).properties ? { workspaceId: input.workspaceId } : {}) };
      if (!Value.Check(action.input, payload)) {
        const [first] = [...Value.Errors(action.input, payload)];
        throw new ActionError(`Invalid input: ${first?.path ?? ""} ${first?.message ?? ""}`.trim(), 400);
      }
      const data: Record<string, unknown> = { ...payload };
      await requireWorkspaceRole(db, input.userId, input.workspaceId, roleFor(input.action));
      // Every target id the input carries must be in the chat's workspace: extra keys must not hide a foreign target behind a local one.
      for (const key of targetKeys) {
        if (typeof data[key] === "string" && await workspaceOfTarget(db, { [key]: data[key] }) !== input.workspaceId) throw new ActionError("Target not found in this workspace", 404);
      }
      const snapshot = await snapshotOf(db, input.userId, data);
      const [row] = await db.insert(confirmations).values({
        workspaceId: input.workspaceId, chatId: input.chatId, userId: input.userId, action: input.action,
        input: data, snapshot, expiresAt: new Date(now().getTime() + confirmationTtlMs),
      }).returning();
      return card(row!);
    },

    async get(userId: string, id: string): Promise<ConfirmationCard | null> {
      try { return card(await load(userId, id)); } catch (error) { if (error instanceof ActionError) return null; throw error; }
    },

    /**
     * Runs the proposal after re-validating it: expiry, then the target's live state (a diff is
     * returned until the user acknowledges it), then the action's own permission check.
     */
    async confirm(userId: string, id: string, options: { acknowledgeChanges?: boolean } = {}): Promise<ConfirmOutcome> {
      const row = await load(userId, id);
      if (row.status !== "pending") return { status: "already_resolved" };
      if (row.expiresAt.getTime() <= now().getTime()) return { status: "expired" };
      const action = actions.get(row.action)!;
      const input = row.input as Record<string, unknown>;
      /** Records an ActionError as the card's failure. Anything else is not the user's problem and is not recorded here. */
      const failWith = async (error: ActionError) => {
        await db.update(confirmations).set({ status: "failed", result: { error: error.message }, resolvedAt: now() }).where(eq(confirmations.id, id));
        return { status: "failed", error: error.message } as const;
      };
      // Before the claim: a refusal (expired target, lost permission) fails the card; a transient error (database hiccup) leaves it pending to retry.
      try {
        if (row.snapshot) {
          const diff = diffOf(row.snapshot as Snapshot, await snapshotOf(db, userId, input));
          if (diff.length > 0 && !options.acknowledgeChanges) return { status: "changed", diff };
        }
        await requireWorkspaceRole(db, userId, row.workspaceId, roleFor(row.action));
      } catch (error) {
        if (error instanceof ActionError) return failWith(error);
        throw error;
      }
      // Claim before running so two confirms cannot both execute.
      const [claimed] = await db.update(confirmations).set({ status: "confirmed", resolvedAt: now() })
        .where(and(eq(confirmations.id, id), eq(confirmations.status, "pending"))).returning({ id: confirmations.id });
      if (!claimed) return { status: "already_resolved" };
      let result: unknown;
      try {
        result = await action.handler({ userId, source: "ai", chatId: row.chatId }, input as never);
      } catch (error) {
        // The action did not complete: never leave the card "confirmed" without a result. Unexpected errors still surface as server errors.
        if (error instanceof ActionError) return failWith(error);
        await db.update(confirmations).set({ status: "failed", result: { error: "Action failed" }, resolvedAt: now() }).where(eq(confirmations.id, id));
        throw error;
      }
      // The action ran. Failing to store its result must not mark the card failed, or the user would run it twice.
      await db.update(confirmations).set({ result: result ?? null }).where(eq(confirmations.id, id));
      return { status: "confirmed", result };
    },

    async reject(userId: string, id: string): Promise<ConfirmationCard> {
      const row = await load(userId, id);
      if (row.status === "pending") {
        await db.update(confirmations).set({ status: "rejected", resolvedAt: now() }).where(and(eq(confirmations.id, id), eq(confirmations.status, "pending")));
      }
      return card(await load(userId, id));
    },
  };
}
