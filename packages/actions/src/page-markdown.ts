import { Type } from "@sinclair/typebox";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { wikiPages, type Database } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { prepareRichTextGuarded } from "./written-form-pool";

/** Test seam: runs after a page was converted and before its Markdown is written. */
export const rebuildPageMarkdownHooks: { beforeWrite?: (pageId: string) => Promise<void> } = {};

export function createPageMarkdownActions(db: Database) {
  return {
    rebuildPageMarkdown: {
      name: "rebuild_page_markdown", kind: "write" as const,
      // A live save that hit a conversion limit keeps the document and flags the Markdown stale. This recomputes it for one Page or for stale Pages of a Workspace, at most `limit` pages
      // per call (default 25), and says how many are left: call again until `remaining` is 0. A page that was saved again while it converted is left stale, because the newer save wins.
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }), pageId: Type.Optional(Type.String({ format: "uuid" })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), after: Type.Optional(Type.String({ format: "uuid", description: "The `next` of the previous call: continue after this page id." })) }),
      output: Type.Object({
        next: Type.Union([Type.String(), Type.Null()]), pagesRebuilt: Type.Integer(), pagesStillStale: Type.Array(Type.Object({ pageId: Type.String(), code: Type.String() })),
        pagesChangedMeanwhile: Type.Integer(), remaining: Type.Integer(),
      }),
      handler: async (context: { userId: string }, input: { workspaceId: string; pageId?: string; limit?: number; after?: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
        const stale = and(eq(wikiPages.workspaceId, input.workspaceId), eq(wikiPages.markdownStale, true), isNull(wikiPages.deletedAt), ...(input.pageId ? [eq(wikiPages.id, input.pageId)] : []));
        // Pages are taken in id order from the cursor: a page that cannot be converted is listed and passed, so it cannot block the pages behind it.
        const batch = await db.select({ id: wikiPages.id, content: wikiPages.content }).from(wikiPages).where(and(stale, ...(input.after ? [gt(wikiPages.id, input.after)] : []))).orderBy(asc(wikiPages.id)).limit(limit);
        let pagesRebuilt = 0, pagesChangedMeanwhile = 0;
        const stillStale: Array<{ pageId: string; code: string }> = [];
        for (const page of batch) {
          try {
            // Converted one page at a time, outside any transaction, on the long lane under the admin's own key: it cannot hold the workers that serve other people's requests.
            const prepared = await prepareRichTextGuarded(page.content, undefined, "content", "contentMarkdown", {}, "derived", {}, { lane: "request", group: "long", key: `user:${context.userId}`, deadlineMs: 120_000 });
            await rebuildPageMarkdownHooks.beforeWrite?.(page.id);
            // The write only lands if the page still holds the content that was converted: a live save that arrived meanwhile wins, and the page stays stale.
            const written = await db.update(wikiPages).set({ contentMarkdown: prepared.markdown, markdownStale: false })
              .where(and(eq(wikiPages.id, page.id), eq(wikiPages.markdownStale, true), sql`${wikiPages.content} = ${JSON.stringify(page.content)}::jsonb`)).returning({ id: wikiPages.id });
            if (!written.length) { pagesChangedMeanwhile++; continue; }
            pagesRebuilt++;
          } catch (error) {
            if (!(error instanceof ActionError)) throw error;
            stillStale.push({ pageId: page.id, code: error.code ?? "error" });
          }
        }
        const next = batch.length ? batch[batch.length - 1]!.id : null;
        // `remaining` counts the stale pages behind the cursor; pages that failed or changed are behind it already, so a failing page is never counted twice.
        const [left] = await db.select({ value: sql<number>`count(*)::int` }).from(wikiPages).where(and(stale, ...(next ? [gt(wikiPages.id, next)] : input.after ? [gt(wikiPages.id, input.after)] : [])));
        return { next: (left?.value ?? 0) > 0 ? next : null, pagesRebuilt, pagesStillStale: stillStale, pagesChangedMeanwhile, remaining: left?.value ?? 0 };
      },
    },
  };
}
