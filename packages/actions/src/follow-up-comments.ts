import { and, desc, eq, gte, isNull } from "drizzle-orm";
import type { Database } from "@weft/db";
import { comments, users } from "@weft/db";

/** A Follow-up Run's prompt carries at most this many comments (ADR 0013). */
export const followUpCommentLimit = 20;
/** ...and at most this many bytes of their text and markers, with room left for the header and the note (ADR 0013). */
export const followUpByteLimit = 64 * 1024;
const reservedBytes = 512;

/**
 * The comments a Follow-up Run answers: every comment on its work item written since the active Run it waited for began, oldest first.
 * When the newest comments do not fit the limits, the older ones are left out and a note says how many. Returns null for a Run that is not a Follow-up Run.
 * `boundary` is the random id the markers carry, so no comment can close its own block.
 */
export async function followUpCommentBlock(database: Database, run: { workItemId: string | null; followUpSince: Date | null }, boundary: string): Promise<string | null> {
  if (!run.workItemId || !run.followUpSince) return null;
  const rows = await database.select({ text: comments.bodyText, author: users.name }).from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(and(eq(comments.workItemId, run.workItemId), gte(comments.createdAt, run.followUpSince), isNull(comments.deletedAt)))
    .orderBy(desc(comments.createdAt), desc(comments.id));
  const render = (author: string, text: string) => `<comment id="${boundary}">\n${author}: ${text}\n</comment id="${boundary}">`;
  const budget = followUpByteLimit - reservedBytes;
  const picked: string[] = [];
  let used = 0;
  for (const row of rows) {
    if (picked.length >= followUpCommentLimit) break;
    let entry = render(row.author, row.text);
    if (used + Buffer.byteLength(entry) + 1 > budget) {
      // A comment that does not fit ends the list, so the kept comments stay contiguous, except for the newest one, which keeps as much as fits.
      if (picked.length > 0) break;
      const room = budget - Buffer.byteLength(render(row.author, "")) - 1;
      entry = render(row.author, Buffer.from(row.text).subarray(0, Math.max(0, room)).toString("utf8"));
    }
    picked.unshift(entry);
    used += Buffer.byteLength(entry) + 1;
  }
  const left = rows.length - picked.length;
  const note = left > 0 ? `${left} earlier comments were left out (the limit is 20 comments or 64 KiB).` : "";
  return ["Comments written since the previous Run began, oldest first:", ...picked, note].filter((line) => line.length > 0).join("\n");
}
