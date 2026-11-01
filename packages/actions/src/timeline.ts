import { Type } from "@sinclair/typebox";
import type { Database } from "@weft/db";
import { createCommentActions } from "./comments";
import { createWorkItemActions, type ActivitySource } from "./work-items";

type Context = { userId: string; source?: ActivitySource };

/**
 * One feed of a work item: Comments (replies nested under their parent) and Activity, merged by time.
 * The comment_* Activity rows hold only a comment id and are left out: the comment itself is the entry.
 * Comments come from list_comments, so a deleted comment (and its replies) never appears; versions are never included.
 */
export function createTimelineActions(db: Database) {
  const comments = createCommentActions(db);
  const work = createWorkItemActions(db);
  const commentEntry = Type.Composite([comments.listComments.output.items, Type.Object({ replies: Type.Array(comments.listComments.output.items) })]);
  const entry = Type.Object({
    kind: Type.Union([Type.Literal("comment"), Type.Literal("activity")]),
    createdAt: Type.String(),
    comment: Type.Union([commentEntry, Type.Null()]),
    activity: Type.Union([work.listWorkItemActivities.output.items, Type.Null()]),
  });
  return {
    listTimeline: {
      name: "list_timeline", kind: "read" as const,
      input: Type.Object({
        workItemId: Type.String({ format: "uuid" }),
        filter: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("comments"), Type.Literal("updates")])),
        sort: Type.Optional(Type.Union([Type.Literal("newest"), Type.Literal("oldest")])),
      }),
      output: Type.Array(entry),
      handler: async (context: Context, input: { workItemId: string; filter?: "all" | "comments" | "updates"; sort?: "newest" | "oldest" }) => {
        const filter = input.filter ?? "all";
        const [rows, log] = await Promise.all([
          comments.listComments.handler(context, { workItemId: input.workItemId }),
          work.listWorkItemActivities.handler(context, { workItemId: input.workItemId }),
        ]);
        const entries: Array<{ kind: "comment" | "activity"; createdAt: string; comment: (typeof rows[number] & { replies: typeof rows }) | null; activity: (typeof log)[number] | null }> = [];
        if (filter !== "updates") {
          for (const row of rows.filter((candidate) => candidate.parentId === null)) entries.push({ kind: "comment", createdAt: row.createdAt, comment: { ...row, replies: rows.filter((reply) => reply.parentId === row.id) }, activity: null });
        }
        if (filter !== "comments") {
          for (const row of log.filter((candidate) => !candidate.field.startsWith("comment_"))) entries.push({ kind: "activity", createdAt: row.createdAt, comment: null, activity: row });
        }
        entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return (input.sort ?? "oldest") === "newest" ? entries.reverse() : entries;
      },
    },
  };
}
