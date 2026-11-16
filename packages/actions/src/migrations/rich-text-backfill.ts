import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { commentVersions, comments, projects, workItemDescriptionVersions, workItems, wikiPageVersions, wikiPages, type Database } from "@weft/db";
import { ActionError } from "../members";
import { WRITTEN_FORM_MAX_INPUT_LENGTH, WRITTEN_FORM_STORED_READ_LIMIT } from "../markdown-doc";
import { prepareRichTextGuarded, WRITTEN_FORM_REQUEST_TIMEOUT_MS } from "../written-form-pool";
import { plainTextWrittenForm } from "../rich-markdown";
import { normalizeAssetImages, wikiContentFromYState } from "../wiki-yjs";
import { plainText, workItemMarkdownOptions } from "../work-items";
import { rebuildPageOutlinks, rebuildWorkItemOutlinks } from "../outlinks";
import { commentMarkdownOptions } from "../comments";

const OUTLINKS_KEY = "written-form-v2-outlinks";
type Failure = { table: string; id: string; reason: string };
type BackfillWarning = { table: string; id: string; code: string; message: string };
type BackfillCounts = Record<"workItems" | "descriptionVersions" | "comments" | "commentVersions" | "wikiPages" | "wikiPageVersions", number>;
/** A row too long, too complex or too slow to convert is stored as escaped plain text, keeps its legacy columns, and is listed here instead of aborting the deploy. */
export type DegradedRow = { table: string; id: string; reason: string };
/** `rows` is every row converted, `seconds` the total time of the run, and `writeSeconds` the part spent inside the write transaction. */
export type RichTextBackfillReport = { counts: BackfillCounts; failures: Failure[]; warnings: BackfillWarning[]; degraded: DegradedRow[]; rows: number; seconds: number; writeSeconds: number; outlinks: { workItems: number; pages: number; seconds: number } };
export class RichTextBackfillError extends Error {
  constructor(readonly failures: Failure[]) {
    super(`Written form backfill failed for ${failures.length} row(s):\n${failures.map(({ table, id, reason }) => `${table} ${id}: ${reason}`).join("\n")}`);
    this.name = "RichTextBackfillError";
  }
}

type Conversion = { doc?: unknown; table: keyof BackfillCounts; id: string; markdown: string; text: string };
const databaseTable: Record<keyof BackfillCounts, string> = {
  workItems: "work_items", descriptionVersions: "work_item_description_versions", comments: "comments",
  commentVersions: "comment_versions", wikiPages: "wiki_pages", wikiPageVersions: "wiki_page_versions",
};

function emptyDocument() { return { type: "doc", content: [] }; }
function textFromDocument(document: unknown) { return plainText(document); }
/** The reference tokens of a document, in Written form syntax, for deciding which references to look up (no serialisation or parse). */
function referenceSourceText(document: unknown): string {
  const parts: string[] = [];
  const stack: unknown[] = [document];
  while (stack.length) {
    const node = stack.pop() as { type?: string; text?: string; marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>; content?: unknown[] } | null;
    if (!node || typeof node !== "object") continue;
    if (node.type === "text" && typeof node.text === "string") {
      const link = node.marks?.find((mark) => mark.type === "link" && mark.attrs?.kind && mark.attrs?.targetId);
      parts.push(link ? `[[${String(link.attrs?.target ?? node.text).trim()}|${String(link.attrs?.kind)}:${String(link.attrs?.targetId)}]]` : node.text);
    }
    if (Array.isArray(node.content)) for (let index = node.content.length - 1; index >= 0; index--) stack.push(node.content[index]);
  }
  return parts.join("\n");
}
function needsReferenceResolution(markdown: string) {
  const withoutStableIds = markdown.replace(/(?<!!)\[\[[^\]|]+\|(?:work-item|page|wiki):[0-9a-f-]{36}\]\]/gi, "");
  return /(?<!!)\[\[[^\]]+\]\]|(?<![A-Z0-9_])[A-Z][A-Z0-9]{1,11}-\d+(?![A-Z0-9_-])/.test(withoutStableIds);
}

/** Preflight all old representations, then write every result and derived Outlink in the caller's transaction. */
export async function backfillRichText(db: Database, options: { dryRun?: boolean; batchSize?: number; rowTimeoutMs?: number; beforeWrite?: () => Promise<void>; withTransaction?: <T>(run: (transaction: Database) => Promise<T>) => Promise<T> } = {}): Promise<RichTextBackfillReport> {
  const dryRun = options.dryRun === true;
  const runStarted = performance.now();
  const outlinkReport = { workItems: 0, pages: 0, seconds: 0 };
  const finish = (report: Omit<RichTextBackfillReport, "rows" | "seconds" | "writeSeconds" | "outlinks">, writeSeconds = 0): RichTextBackfillReport => ({ ...report, rows: Object.values(report.counts).reduce((sum, value) => sum + value, 0), seconds: (performance.now() - runStarted) / 1000, writeSeconds, outlinks: outlinkReport });
  const batchSize = Math.max(1, options.batchSize ?? 200);
  /** Read a table in id order, one batch at a time, so no table is ever loaded whole. Nothing is written while reading, so the cursor is stable. */
  async function* batches<Row extends { id: string }>(read: (after: string | undefined, limit: number) => Promise<Row[]>) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await read(cursor, batchSize);
      if (!rows.length) return;
      yield rows;
      cursor = rows.at(-1)!.id;
    }
  }
  const counts: BackfillCounts = { workItems: 0, descriptionVersions: 0, comments: 0, commentVersions: 0, wikiPages: 0, wikiPageVersions: 0 };
  const failures: Failure[] = [];
  const warnings: BackfillWarning[] = [];
  const degraded: DegradedRow[] = [];
  const conversions: Conversion[] = [];
  const [completed] = await db.execute<{ completed: boolean }>(sql`select exists(select 1 from rich_text_backfill_state where key = 'written-form-v1') as completed`);
  const stateKey = (key: string) => db.execute<{ done: boolean }>(sql`select exists(select 1 from rich_text_backfill_state where key = ${key}) as done`);
  if (completed?.completed) {
    // The data was written but the process may have stopped before the Outlinks were rebuilt: that step is idempotent, so a rerun finishes it.
    if (!dryRun && !(await stateKey(OUTLINKS_KEY))[0]?.done) await rebuildOutlinksAfterCommit(db, "all");
    return finish({ counts, failures, warnings, degraded });
  }

  const prepare = async (table: keyof BackfillCounts, id: string, document: unknown, context: { userId?: string | null; workspaceId?: string; projectId?: string | null }) => {
    try {
      if ((table === "comments" || table === "commentVersions") && (!document || typeof document !== "object" || (document as { type?: unknown }).type !== "doc")) {
        throw new Error("legacy row has no Tiptap document");
      }
      const source = document ?? emptyDocument();
      const sourceWritten = referenceSourceText(source);
      const markdownOptions = context.userId && context.workspaceId && needsReferenceResolution(sourceWritten)
        ? table === "comments" || table === "commentVersions"
          ? (await commentMarkdownOptions(db, context.userId, context.workspaceId, context.projectId ?? undefined)).options
          : await workItemMarkdownOptions(db, context.userId, context.workspaceId, context.projectId ?? undefined, sourceWritten)
        : {};
      let prepared;
      const started = performance.now();
      try { prepared = await prepareRichTextGuarded(source, undefined, table, "markdown", markdownOptions, "derived", {}, { lane: "backfill", ...(options.rowTimeoutMs ? { timeoutMs: options.rowTimeoutMs } : {}) }); }
      catch (error) {
        if (!(error instanceof ActionError) || !["input-too-complex", "input-too-long", "nesting-too-deep"].includes(error.code ?? "")) throw error;
        // Never abort a deploy for one heavy row: keep the legacy columns, store its text as escaped plain paragraphs, and list the row.
        const text = textFromDocument(source);
        const plain = { type: "doc", content: text.split("\n").map((line) => ({ type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {}) })) };
        const plainMarkdown = plainTextWrittenForm(plain);
        // The write cap applies to NEW writes, never to the conversion of existing data: a legacy row is stored in full (and read back whole, the read limit being 1,000,000) with no stored document,
        // so its legacy document keeps serving until its first edit, which is then refused with a clear message naming the limit. Over the read limit its Markdown stays empty and the legacy columns serve.
        if (plainMarkdown.length > WRITTEN_FORM_STORED_READ_LIMIT) {
          degraded.push({ table: databaseTable[table], id, reason: `too-large-to-convert: ${error.code}: ${error.message} The Written form would be ${plainMarkdown.length.toLocaleString("en-US")} characters, over the ${WRITTEN_FORM_STORED_READ_LIMIT.toLocaleString("en-US")} read limit; the Markdown column is left empty and the legacy column serves` });
          return;
        }
        degraded.push({ table: databaseTable[table], id, reason: `${error.code}: ${error.message}${plainMarkdown.length > WRITTEN_FORM_MAX_INPUT_LENGTH ? ` Stored in full (${plainMarkdown.length.toLocaleString("en-US")} characters, over the ${WRITTEN_FORM_MAX_INPUT_LENGTH.toLocaleString("en-US")} write cap); the legacy document keeps serving until the first edit` : ""}` });
        conversions.push({ table, id, markdown: plainMarkdown, text });
        counts[table]++;
        return;
      }
      if (performance.now() - started > WRITTEN_FORM_REQUEST_TIMEOUT_MS) warnings.push({ table: databaseTable[table], id, code: "slow-conversion", message: `This row took ${Math.round(performance.now() - started)} ms to convert, longer than a request may take; reading it can be slow.` });
      const rowWarnings = prepared.warningDetails.map((warning) => ({ table: databaseTable[table], id, ...warning }));
      warnings.push(...rowWarnings);
      conversions.push({ table, id, markdown: prepared.markdown, text: textFromDocument(prepared.document), doc: prepared.document });
      counts[table]++;
    } catch (error) {
      failures.push({ table: databaseTable[table], id, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  for await (const rows of batches((after, limit) => db.select({ id: workItems.id, document: workItems.description, userId: workItems.createdBy, workspaceId: projects.workspaceId, projectId: workItems.projectId })
    .from(workItems).innerJoin(projects, eq(projects.id, workItems.projectId)).where(and(isNull(workItems.descriptionMarkdown), ...(after ? [gt(workItems.id, after)] : []))).orderBy(asc(workItems.id)).limit(limit))) {
    for (const row of rows) await prepare("workItems", row.id, row.document, row);
  }

  for await (const rows of batches((after, limit) => db.select({ id: workItemDescriptionVersions.id, document: workItemDescriptionVersions.content, userId: workItems.createdBy, workspaceId: projects.workspaceId, projectId: workItems.projectId })
    .from(workItemDescriptionVersions).innerJoin(workItems, eq(workItems.id, workItemDescriptionVersions.workItemId)).innerJoin(projects, eq(projects.id, workItems.projectId))
    .where(and(isNull(workItemDescriptionVersions.contentMarkdown), ...(after ? [gt(workItemDescriptionVersions.id, after)] : []))).orderBy(asc(workItemDescriptionVersions.id)).limit(limit))) {
    for (const row of rows) await prepare("descriptionVersions", row.id, row.document, row);
  }

  for await (const rows of batches((after, limit) => db.select({ id: comments.id, document: comments.body, authorId: comments.authorId, workspaceId: comments.workspaceId, projectId: comments.projectId })
    .from(comments).where(and(isNull(comments.bodyMarkdown), ...(after ? [gt(comments.id, after)] : []))).orderBy(asc(comments.id)).limit(limit))) {
    for (const row of rows) await prepare("comments", row.id, row.document, { userId: row.authorId, workspaceId: row.workspaceId, projectId: row.projectId });
  }

  for await (const rows of batches((after, limit) => db.select({ id: commentVersions.id, document: commentVersions.body, userId: comments.authorId, workspaceId: comments.workspaceId, projectId: comments.projectId })
    .from(commentVersions).innerJoin(comments, eq(comments.id, commentVersions.commentId)).where(and(isNull(commentVersions.bodyMarkdown), ...(after ? [gt(commentVersions.id, after)] : []))).orderBy(asc(commentVersions.id)).limit(limit))) {
    for (const row of rows) await prepare("commentVersions", row.id, row.document, row);
  }

  for await (const rows of batches((after, limit) => db.select({ id: wikiPages.id, content: wikiPages.content, state: wikiPages.ydocState, userId: wikiPages.ownerId, workspaceId: wikiPages.workspaceId, projectId: wikiPages.projectId })
    .from(wikiPages).where(and(eq(wikiPages.contentMarkdown, ""), ...(after ? [gt(wikiPages.id, after)] : []))).orderBy(asc(wikiPages.id)).limit(limit))) {
    for (const row of rows) {
      try {
        const document = row.state ? wikiContentFromYState(row.state) : normalizeAssetImages(row.content ?? emptyDocument());
        await prepare("wikiPages", row.id, document, row);
      } catch (error) { failures.push({ table: databaseTable.wikiPages, id: row.id, reason: error instanceof Error ? error.message : String(error) }); }
    }
  }

  for await (const pageVersionRows of batches((after, limit) => db.select({ id: wikiPageVersions.id, content: wikiPageVersions.content, state: wikiPageVersions.ydocState, pageId: wikiPageVersions.pageId })
    .from(wikiPageVersions).where(and(eq(wikiPageVersions.contentMarkdown, ""), ...(after ? [gt(wikiPageVersions.id, after)] : []))).orderBy(asc(wikiPageVersions.id)).limit(limit))) {
    const pageIds = [...new Set(pageVersionRows.map(({ pageId }) => pageId))];
    const pages = await db.select({ id: wikiPages.id, userId: wikiPages.ownerId, workspaceId: wikiPages.workspaceId, projectId: wikiPages.projectId }).from(wikiPages).where(inArray(wikiPages.id, pageIds));
    const pageContext = new Map(pages.map((page) => [page.id, page]));
    for (const row of pageVersionRows) {
      try {
        const document = row.state ? wikiContentFromYState(row.state) : normalizeAssetImages(row.content ?? emptyDocument());
        await prepare("wikiPageVersions", row.id, document, pageContext.get(row.pageId) ?? {});
      } catch (error) { failures.push({ table: databaseTable.wikiPageVersions, id: row.id, reason: error instanceof Error ? error.message : String(error) }); }
    }
  }

  if (failures.length) {
    failures.sort((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
    if (!dryRun) throw new RichTextBackfillError(failures);
    return finish({ counts, failures, warnings, degraded });
  }
  if (dryRun) return finish({ counts, failures, warnings, degraded });

  await options.beforeWrite?.();
  // Every conversion is done above, outside any transaction. Only the writes (and the Outlinks and state that depend on them) run inside the one short transaction.
  const byTable = (table: keyof BackfillCounts) => conversions.filter((entry) => entry.table === table);
  const write = async (db: Database) => {
    const [again] = await db.execute<{ completed: boolean }>(sql`select exists(select 1 from rich_text_backfill_state where key = 'written-form-v1') as completed`);
    if (again?.completed) return;
    for (const row of byTable("workItems")) await db.update(workItems).set({ descriptionMarkdown: row.markdown, descriptionText: row.text, ...(row.doc ? { descriptionDoc: row.doc } : {}) }).where(and(eq(workItems.id, row.id), isNull(workItems.descriptionMarkdown)));
    for (const row of byTable("descriptionVersions")) await db.update(workItemDescriptionVersions).set({ contentMarkdown: row.markdown, contentText: row.text }).where(and(eq(workItemDescriptionVersions.id, row.id), isNull(workItemDescriptionVersions.contentMarkdown)));
    for (const row of byTable("comments")) {
      await db.update(comments).set({ bodyMarkdown: row.markdown, bodyText: row.text }).where(and(eq(comments.id, row.id), isNull(comments.bodyMarkdown)));
    }
    for (const row of byTable("commentVersions")) await db.update(commentVersions).set({ bodyMarkdown: row.markdown, bodyText: row.text }).where(and(eq(commentVersions.id, row.id), isNull(commentVersions.bodyMarkdown)));
    for (const row of byTable("wikiPages")) {
      await db.update(wikiPages).set({ contentMarkdown: row.markdown, contentText: row.text }).where(and(eq(wikiPages.id, row.id), eq(wikiPages.contentMarkdown, "")));
    }
    for (const row of byTable("wikiPageVersions")) await db.update(wikiPageVersions).set({ contentMarkdown: row.markdown, contentText: row.text }).where(and(eq(wikiPageVersions.id, row.id), eq(wikiPageVersions.contentMarkdown, "")));
    await db.execute(sql`insert into rich_text_backfill_state (key) values ('written-form-v1') on conflict do nothing`);
    // ALTER TABLE takes an ACCESS EXCLUSIVE lock held until commit, so these are the last statements of the transaction.
    // A comment too large to convert keeps an empty Markdown column (its legacy body serves): the constraint is applied only when no such row is left.
    const [pending] = await db.execute<{ left: number }>(sql`select (select count(*) from comments where body_markdown is null) + (select count(*) from comment_versions where body_markdown is null) as left`);
    if (Number(pending?.left ?? 0) === 0) {
      await db.execute(sql`alter table comments alter column body_markdown set not null`);
      await db.execute(sql`alter table comment_versions alter column body_markdown set not null`);
    }
  };
  const writeStarted = performance.now();
  if (options.withTransaction) await options.withTransaction(write); else await write(db);
  const writeSeconds = (performance.now() - writeStarted) / 1000;
  // Outlinks come after the commit and only for the rows that were converted (idempotent and resumable: see OUTLINKS_KEY).
  const sources = { workItems: new Set(byTable("workItems").map(({ id }) => id)), pages: new Set(byTable("wikiPages").map(({ id }) => id)) };
  const commentIds = byTable("comments").map(({ id }) => id);
  for (let index = 0; index < commentIds.length; index += batchSize) {
    const owners = await db.select({ workItemId: comments.workItemId, pageId: comments.wikiPageId }).from(comments).where(inArray(comments.id, commentIds.slice(index, index + batchSize)));
    for (const owner of owners) { if (owner.workItemId) sources.workItems.add(owner.workItemId); if (owner.pageId) sources.pages.add(owner.pageId); }
  }
  await rebuildOutlinksAfterCommit(db, sources);
  return finish({ counts, failures, warnings, degraded }, writeSeconds);

  async function rebuildOutlinksAfterCommit(target: Database, only: "all" | { workItems: Set<string>; pages: Set<string> }) {
    const started = performance.now();
    const run = async (ids: string[], rebuild: (id: string) => Promise<unknown>, counter: "workItems" | "pages") => {
      for (let index = 0; index < ids.length; index += batchSize) {
        for (const id of ids.slice(index, index + batchSize)) await rebuild(id);
        outlinkReport[counter] += Math.min(batchSize, ids.length - index);
      }
    };
    const every = async (table: typeof workItems | typeof wikiPages) => { const ids: string[] = []; for await (const rows of batches((after, limit) => target.select({ id: table.id }).from(table).where(after ? gt(table.id, after) : undefined).orderBy(asc(table.id)).limit(limit))) ids.push(...rows.map(({ id }) => id)); return ids; };
    await run(only === "all" ? await every(workItems) : [...only.workItems], (id) => rebuildWorkItemOutlinks(target, id), "workItems");
    await run(only === "all" ? await every(wikiPages) : [...only.pages], (id) => rebuildPageOutlinks(target, id), "pages");
    await target.execute(sql`insert into rich_text_backfill_state (key) values (${OUTLINKS_KEY}) on conflict do nothing`);
    outlinkReport.seconds = (performance.now() - started) / 1000;
  }
}
