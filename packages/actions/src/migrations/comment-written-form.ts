import { eq, inArray, isNull, sql } from "drizzle-orm";
import { writtenFormNodeAllowlist } from "../written-form";
import { writtenFormOfSync, writtenFormWarnings } from "../rich-markdown";
import { markdownToDoc } from "../markdown-doc";
import type { Database } from "@weft/db";
import { commentMentions, commentVersions, comments, users } from "@weft/db";

function convert(body: unknown, table: string, id: string): string {
  if (!body || typeof body !== "object" || (body as { type?: unknown }).type !== "doc") {
    throw new Error(`${table} row ${id} has no Tiptap document and cannot be converted to Written form`);
  }
  const markdownWarnings = writtenFormWarnings(body);
  const markdown = writtenFormOfSync(body);
  if (markdownWarnings.length) throw new Error(`${table} row ${id} cannot be converted to Written form: ${markdownWarnings.join(", ")}`);
  const scan = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const value = node as { type?: string; content?: unknown[] };
    return !writtenFormNodeAllowlist.has(value.type ?? "") || (value.content ?? []).some(scan);
  };
  if (scan(body)) throw new Error(`${table} row ${id} contains an unsupported document node`);
  return markdown;
}

function bodyText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { type?: string; text?: string; attrs?: { label?: unknown; alt?: unknown }; content?: unknown[] };
  if (typeof value.text === "string") return value.text;
  if (value.type === "mention") return typeof value.attrs?.label === "string" ? value.attrs.label : "";
  if (value.type === "assetImage") return typeof value.attrs?.alt === "string" ? value.attrs.alt : "";
  const children = (value.content ?? []).map(bodyText);
  return value.type === "doc" ? children.filter(Boolean).join("\n") : children.join("");
}

function mentionIds(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const value = node as { type?: string; attrs?: { id?: unknown }; content?: unknown[] };
  return [...new Set([...(value.type === "mention" && typeof value.attrs?.id === "string" ? [value.attrs.id] : []), ...(value.content ?? []).flatMap(mentionIds)])];
}

/** Backfills both comment tables as one transaction and identifies any row that blocks conversion. */
export async function backfillCommentWrittenForms(db: Database) {
  await db.transaction(async (transaction) => {
    const database = transaction as unknown as Database;
    const commentRows = await database.select({ id: comments.id, authorId: comments.authorId, body: comments.body }).from(comments).where(isNull(comments.bodyMarkdown));
    const versionRows = await database.select({ id: commentVersions.id, body: commentVersions.body }).from(commentVersions).where(isNull(commentVersions.bodyMarkdown));
    const convertedComments = commentRows.map((row) => {
      const markdown = convert(row.body, "comments", row.id);
      const document = markdownToDoc(markdown);
      return { id: row.id, authorId: row.authorId, markdown, bodyText: bodyText(document), mentionedUserIds: mentionIds(document).filter((id) => id !== row.authorId) };
    });
    const convertedVersions = versionRows.map((row) => {
      const markdown = convert(row.body, "comment_versions", row.id);
      return { id: row.id, markdown, bodyText: bodyText(markdownToDoc(markdown)) };
    });
    const allMentionIds = [...new Set(convertedComments.flatMap((row) => row.mentionedUserIds))];
    const existingMentionIds = new Set(allMentionIds.length ? (await database.select({ id: users.id }).from(users).where(inArray(users.id, allMentionIds))).map(({ id }) => id) : []);
    for (const row of convertedComments) {
      await database.update(comments).set({ bodyMarkdown: row.markdown, bodyText: row.bodyText }).where(eq(comments.id, row.id));
      await database.delete(commentMentions).where(eq(commentMentions.commentId, row.id));
      const mentionIds = row.mentionedUserIds.filter((id) => existingMentionIds.has(id));
      if (mentionIds.length) await database.insert(commentMentions).values(mentionIds.map((userId) => ({ commentId: row.id, userId })));
    }
    for (const row of convertedVersions) await database.update(commentVersions).set({ bodyMarkdown: row.markdown, bodyText: row.bodyText }).where(eq(commentVersions.id, row.id));
    await database.execute(sql`alter table comments alter column body_markdown set not null`);
    await database.execute(sql`alter table comment_versions alter column body_markdown set not null`);
  });
}
