import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDatabase, type Database } from "@weft/db";
import { createWikiActions } from "../src";
import { richTextTextContent } from "../src/rich-markdown";
import { markdownToDocWithWarnings } from "../src/markdown-doc";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { plainTextLines } from "./support/plain-text-fuzz";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === "node_modules" || name === "test" || name === "dist") return [];
  return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
});

test("only the verified Written form path calls the bare serialiser (richTextMarkdown) on the server", () => {
  const root = join(import.meta.dir, "../../..");
  const allowed = new Set(["packages/actions/src/written-form.ts", "packages/actions/src/rich-markdown.ts"]);
  const offenders = [...sourceFiles(join(root, "packages")), ...["live", "api", "mcp", "cli", "worker"].flatMap((app) => sourceFiles(join(root, "apps", app)))]
    .map((path) => path.slice(root.length + 1))
    .filter((path) => !allowed.has(path) && /\brichTextMarkdown\(/.test(readFileSync(join(root, path), "utf8")));
  expect(offenders).toEqual([]);
});

const page = (wiki: ReturnType<typeof createWikiActions>, userId: string, workspaceId: string, extra: Record<string, unknown>) => wiki.createWikiPage.handler({ userId }, { workspaceId, title: "Round trip", ...extra } as never);

test("an Agent that reads a Page as Markdown and writes it back unchanged corrupts nothing", async () => {
  await withRollback(db, async (transaction: Database) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const wiki = createWikiActions(transaction);
    for (const text of ["Use <https://example.com> here", "See www.example.com/a_b_c for details", "email me@x.org or https://a.b/c_d_e"]) {
      const created = await page(wiki, owner.id, workspace.id, { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } });
      const read = await wiki.getWikiPage.handler({ userId: owner.id }, { pageId: created.id });
      expect(richTextTextContent(markdownToDocWithWarnings(read.contentMarkdown, { trustedSource: true }).document), text).toEqual(richTextTextContent(read.content));
      const rewritten = await wiki.updateWikiPage.handler({ userId: owner.id }, { pageId: created.id, contentMarkdown: read.contentMarkdown });
      expect(rewritten.contentText, text).toBe(text);
      const again = await wiki.getWikiPage.handler({ userId: owner.id }, { pageId: created.id });
      expect(again.contentText, text).toBe(text);
      expect(again.contentMarkdown, text).toBe(read.contentMarkdown);
    }
  });
});

test("the Page read path hands out Markdown that reads back to the same text for the token fuzz", async () => {
  await withRollback(db, async (transaction: Database) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const wiki = createWikiActions(transaction);
    const lines = plainTextLines(300, 31337).map((text) => text.replace(/\n/g, " "));
    const content = { type: "doc", content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) };
    const created = await page(wiki, owner.id, workspace.id, { content });
    const { sanitizeWrittenDocument } = await import("../src/rich-markdown");
    // Written straight into the live state, as the live server does: no write-time verification of the Markdown column.
    const { wikiYStateFromContent } = await import("../src");
    const { wikiPages } = await import("@weft/db");
    const { eq } = await import("drizzle-orm");
    await transaction.update(wikiPages).set({ ydocState: wikiYStateFromContent(content), content, contentMarkdown: "" }).where(eq(wikiPages.id, created.id));
    const read = await wiki.getWikiPage.handler({ userId: owner.id }, { pageId: created.id });
    expect(richTextTextContent(markdownToDocWithWarnings(read.contentMarkdown, { trustedSource: true }).document)).toEqual(richTextTextContent(sanitizeWrittenDocument(content).document));
  });
}, 60_000);
