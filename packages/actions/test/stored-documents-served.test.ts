import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createCommentActions, createProjectActions, createWikiActions, createWorkItemActions, dispatchLog } from "../src";
import { markdownParseStats } from "../src/markdown-doc";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

// A comment, a comment version and a Page comment carry their document: reading them parses nothing, however heavy the shape (no worker job, no main-thread parse).
const shapes = ["run `x` www.a.com and snake__case__word", "see [[note]] and **bold** `code`", `${"a long line without a break ".repeat(120)}`, "```js\nconst a = 1;\n```\n\nwww.example.org"];

test("list_comments, list_comment_versions and list_wiki_page_comments serve stored documents without parsing", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const project = await createProjectActions(tx).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Served", key: "SV", visibility: "public" });
    const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Thread" });
    const comments = createCommentActions(tx), wiki = createWikiActions(tx);
    const created = [];
    for (let index = 0; index < 20; index++) created.push(await comments.createComment.handler({ userId: owner.id }, { workItemId: item.id, bodyMarkdown: `${shapes[index % shapes.length]} ${index}` }));
    for (let version = 0; version < 3; version++) await comments.updateComment.handler({ userId: owner.id }, { commentId: created[0]!.id, bodyMarkdown: `${shapes[1]} edit ${version}` });
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, projectId: project.id, title: "P", contentMarkdown: "page" });
    for (let index = 0; index < 8; index++) await wiki.createWikiPageComment.handler({ userId: owner.id }, { pageId: page.id, anchor: `a${index}`, bodyMarkdown: `${shapes[index % shapes.length]} page ${index}` });
    const parsesBefore = markdownParseStats.parses, jobsBefore = dispatchLog.length;
    const listed = await comments.listComments.handler({ userId: owner.id }, { workItemId: item.id }) as Array<{ body: { type: string }; markdown: string }>;
    const versions = await comments.listCommentVersions.handler({ userId: owner.id }, { commentId: created[0]!.id }) as Array<{ body: { type: string } }>;
    const pageComments = await wiki.listWikiPageComments.handler({ userId: owner.id }, { pageId: page.id }) as Array<{ body: { type: string } }>;
    expect(listed).toHaveLength(20);
    expect(listed.every((row) => row.body.type === "doc")).toBe(true);
    expect(versions).toHaveLength(3);
    expect(versions.every((row) => row.body.type === "doc")).toBe(true);
    expect(pageComments).toHaveLength(8);
    expect({ parses: markdownParseStats.parses - parsesBefore, jobs: dispatchLog.length - jobsBefore }).toEqual({ parses: 0, jobs: 0 });
  });
}, 120_000);
