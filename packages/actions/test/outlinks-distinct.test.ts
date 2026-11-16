import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createCommentActions, createOutlinkActions, createProjectActions, createWikiActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

// A target linked from the description and from two comments is ONE Outlink and ONE Backlink, for every kind of caller.
test("list_outlinks and list_backlinks return each target and each source once, whatever number of parts link it", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const member = await createMemberFactory(tx, workspace.id, "Member");
    const guest = await createMemberFactory(tx, workspace.id, "Guest");
    const projects = createProjectActions(tx);
    const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Dup", key: "DUP", visibility: "public" });
    for (const user of [member, guest]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: user === guest ? "Guest" : "Member" });
    const work = createWorkItemActions(tx), comments = createCommentActions(tx), wiki = createWikiActions(tx);
    const target = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Target" });
    const page = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, projectId: project.id, title: "Linked page", contentMarkdown: "page" });
    const ref = `[[Target|work-item:${target.id}]] [[Linked page|page:${page.id}]]`;
    const source = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Source", descriptionMarkdown: `Text ${ref}` });
    await comments.createComment.handler({ userId: admin.id }, { workItemId: source.id, bodyMarkdown: `One ${ref}` });
    await comments.createComment.handler({ userId: admin.id }, { workItemId: source.id, bodyMarkdown: `Two ${ref}` });
    const actions = createOutlinkActions(tx);
    const callers: Array<[string, { userId: string }]> = [["owner", { userId: admin.id }], ["member", { userId: member.id }], ["guest", { userId: guest.id }], ["API token", { userId: member.id, apiTokenId: "token-1", source: "api" } as { userId: string }]];
    for (const [who, context] of callers) {
      const out = await actions.listOutlinks.handler(context, { kind: "work-item", id: source.id });
      expect({ who, titles: out.map((row) => row.title).sort() }).toEqual({ who, titles: ["Linked page", "Target"] });
      const back = await actions.listBacklinks.handler(context, { kind: "work-item", id: target.id });
      expect({ who, titles: back.map((row) => row.title) }).toEqual({ who, titles: ["Source"] });
    }
  });
}, 120_000);
