import { afterAll, expect, test } from "bun:test";
import { translate } from "@weft/shared";
import { createDatabase } from "@weft/db";
import { createCommentActions, createProjectActions, createWikiActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

// The Written form drops text alignment. The save tells the user so in plain words, in English and Thai, whatever way the aligned text arrived.
const aligned = { type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "centred" }] }] };

test("the save warning for dropped alignment names alignment in English and Thai", () => {
  expect(translate("editor.warning.attributeNotPersisted", "en")).toContain("text alignment");
  expect(translate("editor.warning.attributeNotPersisted", "th")).toContain("การจัดแนวข้อความ");
});

test("a work item description, a comment and a Page with aligned text each say the text alignment was not kept", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const project = await createProjectActions(tx).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Align", key: "AL", visibility: "public" });
    const item: any = await createWorkItemActions(tx).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "A", description: aligned });
    const comment: any = await createCommentActions(tx).createComment.handler({ userId: owner.id }, { workItemId: item.id, body: aligned });
    const page: any = await createWikiActions(tx).createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, projectId: project.id, title: "P", content: aligned });
    for (const details of [item.descriptionMarkdownWarningDetails, comment.markdownWarningDetails, page.contentMarkdownWarningDetails]) {
      expect(details).toContainEqual({ code: "attribute-not-persisted", message: "The text alignment was not kept." });
    }
  });
}, 60_000);
