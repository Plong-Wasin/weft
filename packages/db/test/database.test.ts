import { afterAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase, schema } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../src/test-helpers";
import { createProjectActions } from "../../actions/src";
import { getWikiPageScopeMigrationReport, migrateWikiPageScopes } from "../src/wiki-page-scope-migration";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("a real Postgres test transaction rolls back its factory data", async () => {
  const slug = `rollback-${crypto.randomUUID()}`;
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction, { name: "Rollback workspace", slug });
    expect(workspace.name).toBe("Rollback workspace");
    expect(await transaction.select().from(schema.workspaces).where(eq(schema.workspaces.slug, slug))).toHaveLength(1);
  });
  expect(await db.select().from(schema.workspaces).where(eq(schema.workspaces.slug, slug))).toHaveLength(0);
});

test.concurrent("wiki scope migration dry-run counts root scopes, inherited children, and copied versions", async () => {
  await withRollback(db, async (tx) => {
    // Model the legacy table only inside this rollback transaction; current schema has project_id on wiki_pages.
    await tx.execute(sql`create temporary table wiki_page_projects (
      page_id uuid not null, project_id uuid not null, workspace_id uuid not null, linked_by text not null,
      created_at timestamptz not null default now(), primary key (page_id, project_id)
    )`);
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Member");
    const actions = createProjectActions(tx);
    const projectA = await actions.createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "A", key: "AAA", visibility: "public" });
    const projectB = await actions.createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "B", key: "BBB", visibility: "public" });
    const [wikiRoot, oneProject, manyProjects, child] = await tx.insert(schema.wikiPages).values([
      { workspaceId: workspace.id, ownerId: owner.id, title: "Wiki" },
      { workspaceId: workspace.id, ownerId: owner.id, title: "One project" },
      { workspaceId: workspace.id, ownerId: owner.id, title: "Two projects" },
      { workspaceId: workspace.id, ownerId: owner.id, title: "Inherited child" },
    ]).returning();
    await tx.update(schema.wikiPages).set({ parentId: manyProjects!.id }).where(eq(schema.wikiPages.id, child!.id));
    await tx.execute(sql`insert into wiki_page_projects (page_id, project_id, workspace_id, linked_by) values
      (${oneProject!.id}, ${projectA.id}, ${workspace.id}, ${owner.id}),
      (${manyProjects!.id}, ${projectA.id}, ${workspace.id}, ${owner.id}),
      (${manyProjects!.id}, ${projectB.id}, ${workspace.id}, ${owner.id})`);
    await tx.insert(schema.wikiPageVersions).values([
      { pageId: manyProjects!.id, title: "v1", contentText: "v1", createdBy: owner.id },
      { pageId: child!.id, title: "v1 child", contentText: "v1", createdBy: owner.id },
    ]);
    const dryRun = await migrateWikiPageScopes(tx, true, workspace.id);
    expect(dryRun).toEqual({
      sourcePages: 4, wikiPages: 1, projectPages: 5, copies: 2, versionsToCopy: 2, scopeChanges: 2,
    });
    expect(await tx.select().from(schema.wikiPages).where(eq(schema.wikiPages.title, "Two projects"))).toHaveLength(1);
    expect(await migrateWikiPageScopes(tx, false, workspace.id)).toEqual(dryRun);
    const pageCopies = await tx.select().from(schema.wikiPages).where(eq(schema.wikiPages.title, "Two projects"));
    const childCopies = await tx.select().from(schema.wikiPages).where(eq(schema.wikiPages.title, "Inherited child"));
    expect((await tx.select().from(schema.wikiPages).where(eq(schema.wikiPages.id, wikiRoot!.id)))[0]!.projectId).toBeNull();
    expect((await tx.select().from(schema.wikiPages).where(eq(schema.wikiPages.id, oneProject!.id)))[0]!.projectId).toBe(projectA.id);
    expect(pageCopies).toHaveLength(2);
    expect(childCopies).toHaveLength(2);
    expect(new Set(childCopies.map((page) => page.parentId))).toEqual(new Set(pageCopies.map((page) => page.id)));
    const copiedVersionCounts = await tx.select({ pageId: schema.wikiPageVersions.pageId }).from(schema.wikiPageVersions)
      .where(inArray(schema.wikiPageVersions.pageId, [...pageCopies, ...childCopies].map((page) => page.id)));
    expect(copiedVersionCounts).toHaveLength(4);
    expect(pageCopies.map((page) => page.projectId).sort()).toEqual([projectA.id, projectB.id].sort());
    expect(childCopies.map((page) => page.projectId).sort()).toEqual([projectA.id, projectB.id].sort());
  });
});
