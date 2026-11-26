import { Type, type Static } from "@sinclair/typebox";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@weft/db";
import { cycles, modules, projectKeyAliases, projects, wikiPages, workItems, workItemStates } from "@weft/db";
import { assertFeatureEnabled } from "./features";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { triageGroup } from "./triage";
import { requireWikiPageAccess } from "./wiki";

const uuid = () => Type.String({ format: "uuid" });
export const targetKinds = ["work_item", "wiki_page", "cycle", "module", "project"] as const;
export type TargetKind = (typeof targetKinds)[number];
const kindSchema = Type.Union(targetKinds.map((kind) => Type.Literal(kind)));
const targetOutput = Type.Object({
  kind: kindSchema,
  /** The id or display id exactly as asked, so the caller can match its request. */
  ref: Type.String(),
  id: Type.String(),
  status: Type.Union([Type.Literal("available"), Type.Literal("archived"), Type.Literal("deleted")]),
  title: Type.String(),
  displayId: Type.Union([Type.String(), Type.Null()]),
  /** Null for a workspace wiki page. */
  projectKey: Type.Union([Type.String(), Type.Null()]),
  stateGroup: Type.Union([Type.String(), Type.Null()]),
});
export type ResolvedTarget = Static<typeof targetOutput>;

const statusOf = (row: { deletedAt?: Date | null; archivedAt: Date | null }): ResolvedTarget["status"] => row.deletedAt ? "deleted" : row.archivedAt ? "archived" : "available";

/**
 * Names the things a link points at, as the caller may see them now. Anything the caller may not open, or that does not exist,
 * is left out without a reason, so a title never leaks and the two cases cannot be told apart.
 */
export function createTargetActions(db: Database) {
  return {
    resolveTargets: {
      name: "resolve_targets", kind: "read" as const,
      input: Type.Object({
        workspaceId: uuid(),
        refs: Type.Optional(Type.Array(Type.Object({ kind: kindSchema, id: uuid() }), { maxItems: 200 })),
        displayIds: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9]{1,11}-[0-9]{1,9}$" }), { maxItems: 200 })),
      }),
      output: Type.Array(targetOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string; refs?: Array<{ kind: TargetKind; id: string }>; displayIds?: string[] }): Promise<ResolvedTarget[]> => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        /** Null for anything refused; any other failure is a real error. */
        const allowed = async <T>(check: () => Promise<T>): Promise<T | null> => {
          try { return await check(); } catch (error) { if (error instanceof ActionError) return null; throw error; }
        };
        const opened = new Map<string, Promise<typeof projects.$inferSelect | null>>();
        const projectOf = (projectId: string) => {
          let found = opened.get(projectId);
          if (!found) {
            found = allowed(async () => (await requireProjectAccess(db, context.userId, projectId, "read")).project)
              .then((project) => project?.workspaceId === input.workspaceId ? project : null);
            opened.set(projectId, found);
          }
          return found;
        };
        const workItem = async (ref: string, row: typeof workItems.$inferSelect | undefined): Promise<ResolvedTarget | null> => {
          if (!row) return null;
          const project = await projectOf(row.projectId);
          if (!project) return null;
          const [state] = await db.select({ group: workItemStates.group }).from(workItemStates).where(eq(workItemStates.id, row.stateId));
          // A work item waiting in Intake has no page of its own.
          if (state?.group === triageGroup) return null;
          return { kind: "work_item", ref, id: row.id, status: statusOf(row), title: row.title, displayId: `${project.key}-${row.sequence}`, projectKey: project.key, stateGroup: state?.group ?? null };
        };
        const byKind: Record<TargetKind, (id: string) => Promise<ResolvedTarget | null>> = {
          work_item: async (id) => workItem(id, (await db.select().from(workItems).where(eq(workItems.id, id)))[0]),
          cycle: async (id) => {
            const [row] = await db.select().from(cycles).where(eq(cycles.id, id));
            const project = row && await projectOf(row.projectId);
            if (!project || !await allowed(async () => { assertFeatureEnabled(project, "cycles"); return true; })) return null;
            return { kind: "cycle", ref: id, id, status: statusOf(row), title: row.name, displayId: null, projectKey: project.key, stateGroup: null };
          },
          module: async (id) => {
            const [row] = await db.select().from(modules).where(eq(modules.id, id));
            const project = row && await projectOf(row.projectId);
            if (!project || !await allowed(async () => { assertFeatureEnabled(project, "modules"); return true; })) return null;
            return { kind: "module", ref: id, id, status: statusOf(row), title: row.name, displayId: null, projectKey: project.key, stateGroup: null };
          },
          wiki_page: async (id) => {
            const row = await allowed(() => requireWikiPageAccess(db, context.userId, id, "read", { includeDeleted: true }));
            if (!row || row.workspaceId !== input.workspaceId) return null;
            const project = row.projectId ? await projectOf(row.projectId) : null;
            return { kind: "wiki_page", ref: id, id, status: statusOf(row), title: row.title, displayId: null, projectKey: project?.key ?? null, stateGroup: null };
          },
          project: async (id) => {
            const project = await projectOf(id);
            return project ? { kind: "project", ref: id, id, status: statusOf({ archivedAt: project.archivedAt }), title: project.name, displayId: null, projectKey: project.key, stateGroup: null } : null;
          },
        };
        const found: Array<ResolvedTarget | null> = [];
        // One at a time: the handler may run inside a transaction.
        for (const ref of input.refs ?? []) found.push(await byKind[ref.kind](ref.id));
        const written = (input.displayIds ?? []).map((ref) => { const dash = ref.lastIndexOf("-"); return { ref, key: ref.slice(0, dash).toUpperCase(), sequence: Number(ref.slice(dash + 1)) }; });
        if (written.length) {
          const keys = [...new Set(written.map((entry) => entry.key))];
          const aliases = await db.select({ key: projectKeyAliases.key, id: projectKeyAliases.projectId }).from(projectKeyAliases)
            .where(and(eq(projectKeyAliases.workspaceId, input.workspaceId), inArray(projectKeyAliases.key, keys)));
          const current = await db.select({ key: projects.key, id: projects.id }).from(projects).where(and(eq(projects.workspaceId, input.workspaceId), inArray(projects.key, keys)));
          // A current key wins over an old one, as in get_work_item.
          const projectIds = new Map([...aliases, ...current].map((entry) => [entry.key, entry.id]));
          for (const entry of written) {
            const projectId = projectIds.get(entry.key);
            if (!projectId || entry.sequence > 2_147_483_647) continue;
            const [row] = await db.select().from(workItems).where(and(eq(workItems.projectId, projectId), eq(workItems.sequence, entry.sequence)));
            found.push(await workItem(entry.ref, row));
          }
        }
        return found.filter((target) => target !== null);
      },
    },
  };
}
