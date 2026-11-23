import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { commentVersions, comments, createDatabase, wikiPages, workItemDescriptionVersions, workItems, type Database } from "@weft/db";
import { createCommentActions, createProjectActions, createWikiActions, createWorkItemActions, withWrittenFormKey } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

// Bodies that all need a worker (backtick, www., double underscore, [[, a very long line). Each read handler must return every row for a caller that holds a user key,
// whether the caller is a browser session or an API token: a stored row was validated when it was written, so a read is never refused for load.
const shapes = [
  (i: number) => `run \`x${i}\` www.a${i}.com`, (i: number) => `snake__case__${i} and f(x)`, (i: number) => `see [[note ${i}]] and **bold**`,
  (i: number) => `${"a long line without a break ".repeat(120)} ${i}`, (i: number) => `\`\`\`js\nconst a${i} = 1;\n\`\`\`\n\nwww.example${i}.org`,
];
const bodyOf = (i: number) => shapes[i % shapes.length]!(i);
const paragraph = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const callers = [["session user (owner)", undefined, "owner"], ["API token user (owner)", "token-1", "owner"], ["guest session user", undefined, "guest"], ["guest API token user", "token-2", "guest"]] as const;
const underKey = <T>(token: string | undefined, run: () => Promise<T>) => withWrittenFormKey("user:reader", run, token);

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const owner = await createMemberFactory(transaction, workspace.id, "Admin");
  const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Keys", key: "KEY", visibility: "public" });
  const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Thread" });
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  await createProjectActions(transaction).addProjectMember.handler({ userId: owner.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  return { workspace, owner, project, item, guest };
}

test.serial("list_comments returns a 100-comment thread whose bodies all need a worker to every session and API-token caller", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, item, guest } = await setup(transaction);
    const actionsOf = createCommentActions(transaction);
    for (let index = 0; index < 100; index++) {
      const comment = await actionsOf.createComment.handler({ userId: owner.id }, { workItemId: item.id, body: paragraph(`row ${index}`) });
      await transaction.update(comments).set({ bodyMarkdown: bodyOf(index), bodyText: `row ${index}` }).where(eq(comments.id, comment.id));
    }
    for (const [who, token, role] of callers) {
      const reader = role === "guest" ? guest : owner;
      const listed = await underKey(token, () => actionsOf.listComments.handler({ userId: reader.id }, { workItemId: item.id })) as Array<{ markdown: string }>;
      expect(listed, who).toHaveLength(100);
      expect(listed.map((row) => row.markdown), who).toEqual(Array.from({ length: 100 }, (_, index) => bodyOf(index)));
    }
  });
}, 120_000);

test.serial("list_wiki_page_comments returns 30 comments with replies to every session and API-token caller", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, owner, guest } = await setup(transaction);
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Thread page", content: paragraph("page") });
    for (let index = 0; index < 30; index++) {
      const comment = await wiki.createWikiPageComment.handler({ userId: owner.id }, { pageId: page.id, anchor: `a${index}`, body: paragraph(`c${index}`) }) as { id: string };
      await transaction.update(comments).set({ bodyMarkdown: bodyOf(index), bodyText: `c${index}` }).where(eq(comments.id, comment.id));
      const reply = await wiki.replyWikiPageComment.handler({ userId: owner.id }, { commentId: comment.id, body: paragraph(`r${index}`) }) as { id: string };
      await transaction.update(comments).set({ bodyMarkdown: bodyOf(index + 1), bodyText: `r${index}` }).where(eq(comments.id, reply.id));
    }
    for (const [who, token, role] of callers) {
      const reader = role === "guest" ? guest : owner;
      const listed = await underKey(token, () => wiki.listWikiPageComments.handler({ userId: reader.id }, { pageId: page.id })) as Array<{ bodyMarkdown: string; replies: Array<{ bodyMarkdown: string }> }>;
      expect(listed, who).toHaveLength(30);
      expect(listed.every((row) => row.replies.length === 1), who).toBe(true);
      expect(listed.map((row) => row.bodyMarkdown).sort(), who).toEqual(Array.from({ length: 30 }, (_, index) => bodyOf(index)).sort());
      expect(listed.map((row) => row.replies[0]!.bodyMarkdown).sort(), who).toEqual(Array.from({ length: 30 }, (_, index) => bodyOf(index + 1)).sort());
    }
  });
}, 120_000);

test.serial("version reads return every page to owners and guests retain their comment-version denial", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, item, guest } = await setup(transaction);
    const actionsOf = createCommentActions(transaction);
    const comment = await actionsOf.createComment.handler({ userId: owner.id }, { workItemId: item.id, body: paragraph("x") });
    for (let index = 0; index < 100; index++) {
      await transaction.insert(commentVersions).values({ commentId: comment.id, body: paragraph("v"), bodyMarkdown: bodyOf(index), bodyText: `v${index}`, createdAt: new Date(Date.now() - index * 1_000), writtenAt: new Date() });
      await transaction.insert(workItemDescriptionVersions).values({ workItemId: item.id, contentMarkdown: bodyOf(index), contentText: `d${index}`, createdBy: owner.id, createdAt: new Date(Date.now() - index * 1_000) });
    }
    const items = createWorkItemActions(transaction);
    const pageThrough = async (read: (after?: string) => Promise<Array<{ id: string }>>) => {
      const seen: string[] = [];
      for (let page = 0; page < 20; page++) { const rows = await read(seen.at(-1)); if (!rows.length) break; seen.push(...rows.map((row) => row.id)); }
      return seen;
    };
    for (const [who, token, role] of callers) {
      const reader = role === "guest" ? guest : owner;
      const readCommentVersions = () => underKey(token, () => pageThrough((after) => actionsOf.listCommentVersions.handler({ userId: reader.id }, { commentId: comment.id, limit: 100, ...(after ? { after } : {}) }) as Promise<Array<{ id: string }>>));
      // Comment versions are for the author and workspace Admins: a Guest is refused by design (a 403, not a load refusal).
      if (role === "guest") await expect(readCommentVersions(), who).rejects.toThrow("Only the author and workspace Admins");
      else expect(new Set(await readCommentVersions()).size, who).toBe(100);
      const descriptionSeen = await underKey(token, () => pageThrough((after) => items.listWorkItemDescriptionVersions.handler({ userId: reader.id }, { workItemId: item.id, limit: 100, ...(after ? { after } : {}) }) as Promise<Array<{ id: string }>>));
      expect(new Set(descriptionSeen).size, who).toBe(100);
    }
  });
}, 120_000);

test.serial("get_work_item, get_wiki_page and work item lists return rows whose Markdown needs a worker to every caller", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, owner, project, item, guest } = await setup(transaction);
    const items = createWorkItemActions(transaction);
    const wiki = createWikiActions(transaction);
    const ids: string[] = [item.id];
    for (let index = 0; index < 40; index++) ids.push((await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: `Item ${index}` })).id);
    for (const [index, id] of ids.entries()) await transaction.update(workItems).set({ descriptionMarkdown: bodyOf(index), descriptionText: `d${index}` }).where(eq(workItems.id, id));
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Stored page", content: paragraph("p") });
    await transaction.update(wikiPages).set({ ydocState: null, contentMarkdown: bodyOf(4), content: paragraph("stale") }).where(eq(wikiPages.id, page.id));
    for (const [who, token, role] of callers) {
      const reader = role === "guest" ? guest : owner;
      const reads = await underKey(token, async () => {
        const many = await Promise.all(ids.slice(0, 30).map((id, index) => items.getWorkItem.handler({ userId: reader.id }, { workspaceId: workspace.id, displayId: `KEY-${index + 1}` })));
        const read = await wiki.getWikiPage.handler({ userId: reader.id }, { pageId: page.id });
        const listed = await items.listWorkItems.handler({ userId: reader.id }, { projectId: project.id }) as Array<{ descriptionMarkdown: string }>;
        return { many, read, listed };
      });
      expect(reads.many, who).toHaveLength(30);
      expect(reads.listed, who).toHaveLength(41);
      expect(reads.read.contentMarkdown, who).toContain("const a4 = 1;");
    }
  });
}, 180_000);
