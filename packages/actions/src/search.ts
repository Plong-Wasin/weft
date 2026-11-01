import { Type } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { requireWorkspaceRole } from "./members";

const resultOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), displayId: Type.String(), title: Type.String(),
  snippet: Type.String(), stateId: Type.String(), priority: Type.String(),
});

const defaultLimit = 25;
const maxLimit = 100;

/** Escapes LIKE wildcards so the query is matched literally. */
export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function snippetOf(text: string, query: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 40);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 120)}`;
}

export function createSearchActions(db: Database) {
  return {
    searchWorkItems: {
      name: "search_work_items", kind: "read" as const,
      input: Type.Object({
        workspaceId: Type.String({ format: "uuid" }),
        query: Type.String({ minLength: 1, maxLength: 200 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxLimit })),
      }),
      output: Type.Array(resultOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string; query: string; limit?: number }) => {
        const role = await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const query = input.query.trim();
        if (query.length === 0) return [];
        const limit = input.limit ?? defaultLimit;
        const pattern = `%${escapeLike(query)}%`;
        const displayMatch = /^([A-Za-z][A-Za-z0-9]{1,11})-(\d+)$/.exec(query);
        const key = displayMatch ? displayMatch[1]!.toUpperCase() : null;
        const sequence = displayMatch ? Number(displayMatch[2]) : null;
        // Workspace Admins see every project; others see public projects and the private ones they belong to.
        const visible = role === "Admin"
          ? sql`true`
          : sql`(p.visibility = 'public' or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = ${context.userId}))`;
        const rows = await db.execute<{
          id: string; project_id: string; key: string; sequence: number; title: string; description_text: string; state_id: string; priority: string;
        }>(sql`
          select w.id, w.project_id, p.key, w.sequence, w.title, w.description_text, w.state_id, w.priority
          from work_items w
          join projects p on p.id = w.project_id
          where w.workspace_id = ${input.workspaceId}
            and w.deleted_at is null
            and ${visible}
            and (
              w.title ilike ${pattern}
              or w.description_text ilike ${pattern}
              or to_tsvector('english', w.title || ' ' || w.description_text) @@ plainto_tsquery('english', ${query})
              or (${key}::text is not null and w.sequence = ${sequence}::int and (
                p.key = ${key}
                or exists (select 1 from project_key_aliases a where a.project_id = p.id and a.workspace_id = p.workspace_id and a.key = ${key})
              ))
            )
          order by
            (${key}::text is not null and w.sequence = ${sequence}::int and (
              p.key = ${key}
              or exists (select 1 from project_key_aliases a where a.project_id = p.id and a.workspace_id = p.workspace_id and a.key = ${key})
            )) desc,
            (w.title ilike ${pattern}) desc,
            w.created_at asc, p.key asc, w.sequence asc
          limit ${limit}
        `);
        return [...rows].map((row) => ({
          id: row.id, projectId: row.project_id, displayId: `${row.key}-${row.sequence}`, title: row.title,
          snippet: snippetOf(row.description_text, query), stateId: row.state_id, priority: row.priority,
        }));
      },
    },
  };
}
