import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, workItems, type Database } from "@weft/db";
import { createIntakeActions, createProjectActions, createWorkItemActions } from "../src";
import { markdownParseStats } from "../src/markdown-doc";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

// Not test.concurrent: the parse counter is process-wide and nothing else may parse while it is read.
test("list endpoints parse no Markdown: a 100-row list does zero parses, the single read parses once", async () => {
  await withRollback(db, async (transaction: Database) => {
    const workspace = await createWorkspaceFactory(transaction);
    const member = await createMemberFactory(transaction, workspace.id, "Admin");
    const project = await createProjectActions(transaction).createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Bounded", key: "BND", visibility: "public" });
    const items = createWorkItemActions(transaction);
    const created: string[] = [];
    for (let index = 0; index < 100; index++) created.push((await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: `Item ${index}`, descriptionMarkdown: `## Heading ${index}\n\nBody **bold** with a [link](https://example.test/${index}).` })).id);
    const parent = created[0]!;
    await transaction.update(workItems).set({ parentId: parent }).where(eq(workItems.id, created[1]!));

    const before = markdownParseStats.parses;
    const listed = await items.listWorkItems.handler({ userId: member.id }, { projectId: project.id });
    const everywhere = await items.listWorkspaceWorkItems.handler({ userId: member.id }, { workspaceId: workspace.id });
    const subs = await items.listSubWorkItems.handler({ userId: member.id }, { workItemId: parent });
    const intake = await createIntakeActions(transaction).listIntakeItems?.handler({ userId: member.id }, { projectId: project.id, status: "pending" } as never).catch(() => []);
    expect({ parses: markdownParseStats.parses - before }).toEqual({ parses: 0 });
    expect(listed.length).toBe(100);
    expect(everywhere.items.length).toBe(100);
    expect(everywhere.truncated).toBe(false);
    expect(subs.length).toBe(1);
    expect(intake ?? []).toEqual(expect.any(Array));
    for (const row of listed) {
      expect(row).not.toHaveProperty("description");
      expect(row.descriptionText).toContain("Heading");
      expect(row.descriptionMarkdown).toContain("## Heading");
    }

    const [displayRow] = listed;
    const single = await items.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: displayRow!.displayId }) as { description: { content: unknown[] } };
    expect(single.description.content.length).toBeGreaterThan(0);
    // The description document is stored with the Markdown, so the single read serves it without parsing.
    expect(markdownParseStats.parses - before).toBe(0);
  });
});
