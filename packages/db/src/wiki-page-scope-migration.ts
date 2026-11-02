import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./index";
import { assets, wikiPageVersions, wikiPages } from "./schema";

export interface WikiPageScopeMigrationReport {
  sourcePages: number;
  wikiPages: number;
  projectPages: number;
  copies: number;
  versionsToCopy: number;
  scopeChanges: number;
}
type LegacyPageProject = { pageId: string; projectId: string; workspaceId: string; linkedBy: string; createdAt: Date };

/** Projects each existing page tree into its destination scopes without writing anything. */
export async function getWikiPageScopeMigrationReport(db: Database, workspaceId?: string): Promise<WikiPageScopeMigrationReport> {
  const [legacyTable] = await db.execute<{ ready: boolean }>(sql`select to_regclass('wiki_page_projects') is not null as ready`);
  if (!legacyTable?.ready) {
    const rows = await db.select({ projectId: wikiPages.projectId }).from(wikiPages)
      .where(workspaceId ? eq(wikiPages.workspaceId, workspaceId) : undefined);
    const projectPages = rows.filter((page) => page.projectId !== null).length;
    return { sourcePages: rows.length, wikiPages: rows.length - projectPages, projectPages, copies: 0, versionsToCopy: 0, scopeChanges: 0 };
  }
  const pages = await db.select({ id: wikiPages.id, parentId: wikiPages.parentId }).from(wikiPages)
    .where(workspaceId ? eq(wikiPages.workspaceId, workspaceId) : undefined);
  const pageIds = pages.map((page) => page.id);
  if (!pageIds.length) return { sourcePages: 0, wikiPages: 0, projectPages: 0, copies: 0, versionsToCopy: 0, scopeChanges: 0 };
  const [linkRows, versions] = await Promise.all([
    db.execute<LegacyPageProject>(sql`
      select page_id as "pageId", project_id as "projectId", workspace_id as "workspaceId", linked_by as "linkedBy", created_at as "createdAt"
      from wiki_page_projects where page_id in (${sql.join(pageIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by created_at, project_id`),
    db.select({ pageId: wikiPageVersions.pageId }).from(wikiPageVersions).where(inArray(wikiPageVersions.pageId, pageIds)),
  ]);
  const links = Array.from(linkRows);
  const children = new Map<string, string[]>();
  for (const page of pages) if (page.parentId) children.set(page.parentId, [...(children.get(page.parentId) ?? []), page.id]);
  const projectsByPage = new Map<string, typeof links>();
  for (const link of links) projectsByPage.set(link.pageId, [...(projectsByPage.get(link.pageId) ?? []), link]);
  const versionsByPage = new Map<string, number>();
  for (const version of versions) versionsByPage.set(version.pageId, (versionsByPage.get(version.pageId) ?? 0) + 1);

  let wikiPagesCount = 0;
  let projectPages = 0;
  let copies = 0;
  let versionsToCopy = 0;
  let scopeChanges = 0;
  let visitedPages = 0;
  const visitTree = (pageId: string, scopes: string[]) => {
    visitedPages++;
    const copyCount = Math.max(0, scopes.length - 1);
    const expectedProjects = new Set(scopes.filter((scope) => scope !== ""));
    const currentProjects = new Set((projectsByPage.get(pageId) ?? []).map((link) => link.projectId));
    scopeChanges += [...expectedProjects].filter((projectId) => !currentProjects.has(projectId)).length;
    scopeChanges += [...currentProjects].filter((projectId) => !expectedProjects.has(projectId)).length;
    if (scopes.length === 1 && scopes[0] === "") wikiPagesCount++;
    else projectPages += scopes.length;
    copies += copyCount;
    versionsToCopy += (versionsByPage.get(pageId) ?? 0) * copyCount;
    for (const childId of children.get(pageId) ?? []) visitTree(childId, scopes);
  };
  for (const page of pages) {
    if (page.parentId) continue;
    const projectIds = (projectsByPage.get(page.id) ?? []).map((link) => link.projectId);
    visitTree(page.id, projectIds.length === 0 ? [""] : projectIds);
  }
  if (visitedPages !== pages.length) throw new Error("Wiki page scope migration cannot process an orphaned or cyclic page tree");
  return { sourcePages: pages.length, wikiPages: wikiPagesCount, projectPages, copies, versionsToCopy, scopeChanges };
}

/** Applies the projected scope split, preserving each original page and its first destination. */
export async function migrateWikiPageScopes(db: Database, dryRun = true, workspaceId?: string, copyAssetObject?: (sourceKey: string, destinationKey: string) => Promise<void>): Promise<WikiPageScopeMigrationReport> {
  const report = await getWikiPageScopeMigrationReport(db, workspaceId);
  if (dryRun) return report;
  const [legacyTable] = await db.execute<{ ready: boolean }>(sql`select to_regclass('wiki_page_projects') is not null as ready`);
  if (!legacyTable?.ready) throw new Error("The legacy wiki page project table is already retired");
  return db.transaction(async (transaction) => {
    const database = transaction as unknown as Database;
    await database.execute(sql`alter table wiki_pages add column if not exists project_id uuid references projects(id) on delete cascade`);
    const [pages, linkRows] = await Promise.all([
      database.select({
        id: wikiPages.id, workspaceId: wikiPages.workspaceId, projectId: wikiPages.projectId, parentId: wikiPages.parentId,
        ownerId: wikiPages.ownerId, title: wikiPages.title, content: wikiPages.content, contentText: wikiPages.contentText,
        access: wikiPages.access, sortOrder: wikiPages.sortOrder, createdAt: wikiPages.createdAt,
        updatedAt: wikiPages.updatedAt, deletedAt: wikiPages.deletedAt,
      }).from(wikiPages).where(workspaceId ? eq(wikiPages.workspaceId, workspaceId) : undefined),
      database.execute<LegacyPageProject>(sql`
        select page_id as "pageId", project_id as "projectId", workspace_id as "workspaceId", linked_by as "linkedBy", created_at as "createdAt"
        from wiki_page_projects ${workspaceId ? sql`where workspace_id = ${workspaceId}::uuid` : sql``} order by created_at, project_id`),
    ]);
    const links = Array.from(linkRows);
    const sourcePageIds = pages.map((page) => page.id);
    const versions = sourcePageIds.length ? await database.select({
      id: wikiPageVersions.id, pageId: wikiPageVersions.pageId, title: wikiPageVersions.title,
      content: wikiPageVersions.content, contentText: wikiPageVersions.contentText,
      createdBy: wikiPageVersions.createdBy, createdAt: wikiPageVersions.createdAt,
    }).from(wikiPageVersions).where(inArray(wikiPageVersions.pageId, sourcePageIds)) : [];
    const sourceAssets = sourcePageIds.length ? await database.select().from(assets).where(and(
      eq(assets.ownerType, "wiki_page"), inArray(assets.ownerId, sourcePageIds), eq(assets.status, "uploaded"),
    )) : [];
    const relevantVersions = versions.filter((version) => sourcePageIds.includes(version.pageId));
    const byId = new Map(pages.map((page) => [page.id, page]));
    const children = new Map<string, string[]>();
    for (const page of pages) if (page.parentId) children.set(page.parentId, [...(children.get(page.parentId) ?? []), page.id]);
    const projectsByPage = new Map<string, LegacyPageProject[]>();
    for (const link of links) projectsByPage.set(link.pageId, [...(projectsByPage.get(link.pageId) ?? []), link]);
    const versionsByPage = new Map<string, typeof versions>();
    for (const version of relevantVersions) versionsByPage.set(version.pageId, [...(versionsByPage.get(version.pageId) ?? []), version]);
    const insertedVersions: Array<{ version: (typeof versions)[number]; pageId: string }> = [];
    const scopeKey = (projectId: string | null) => projectId ?? "wiki";
    const visitedPages = new Set<string>();

    const visit = async (pageId: string, scopes: Array<string | null>, parentTargets: Map<string, string> | null) => {
      const page = byId.get(pageId);
      if (!page) return;
      visitedPages.add(pageId);
      const targets = new Map<string, string>();
      for (let index = 0; index < scopes.length; index++) {
        const projectId = scopes[index]!;
        const targetId = index === 0 ? page.id : crypto.randomUUID();
        targets.set(scopeKey(projectId), targetId);
        const parentId = parentTargets?.get(scopeKey(projectId)) ?? null;
        if (index === 0) {
          await database.update(wikiPages).set({ parentId, projectId }).where(eq(wikiPages.id, page.id));
          await database.update(assets).set({ projectId }).where(and(eq(assets.ownerType, "wiki_page"), eq(assets.ownerId, pageId)));
        } else {
          // Raw SQL naming only the legacy columns: this script runs before the later migrations, and a Drizzle insert would list every current column.
          await database.execute(sql`insert into wiki_pages (id, workspace_id, project_id, parent_id, owner_id, title, content, content_text, access, sort_order, created_at, updated_at, deleted_at) values (
            ${targetId}::uuid, ${page.workspaceId}::uuid, ${projectId}::uuid, ${parentId}::uuid, ${page.ownerId}, ${page.title},
            ${page.content === null ? sql`null` : sql`${JSON.stringify(page.content)}::jsonb`}, ${page.contentText}, ${page.access}, ${page.sortOrder},
            ${page.createdAt.toISOString()}::timestamptz, ${page.updatedAt.toISOString()}::timestamptz, ${page.deletedAt ? page.deletedAt.toISOString() : null}::timestamptz)`);
          for (const asset of sourceAssets.filter((row) => row.ownerId === pageId)) {
            if (!copyAssetObject) throw new Error("Asset object copier is required to split Pages with image assets");
            const assetId = crypto.randomUUID();
            const storageKey = `${asset.workspaceId}/${assetId}`;
            await copyAssetObject(asset.storageKey, storageKey);
            await database.insert(assets).values({
              id: assetId, workspaceId: asset.workspaceId, projectId, ownerType: "wiki_page", ownerId: targetId,
              uploaderId: asset.uploaderId, storageKey, filename: asset.filename, contentType: asset.contentType,
              size: asset.size, status: "uploaded", createdAt: asset.createdAt, uploadedAt: asset.uploadedAt,
            });
          }
          for (const version of versionsByPage.get(pageId) ?? []) {
            insertedVersions.push({ version, pageId: targetId });
          }
        }
      }
      for (const childId of children.get(pageId) ?? []) await visit(childId, scopes, targets);
    };

    for (const page of pages) {
      if (page.parentId !== null) continue;
      const rootProjects = (projectsByPage.get(page.id) ?? []).map((link) => link.projectId);
      await visit(page.id, rootProjects.length ? rootProjects : [null], null);
    }
    if (visitedPages.size !== pages.length) throw new Error("Wiki page scope migration cannot process an orphaned or cyclic page tree");
    for (const { version, pageId } of insertedVersions) {
      await database.execute(sql`insert into wiki_page_versions (page_id, title, content, content_text, created_by, created_at) values (
        ${pageId}::uuid, ${version.title}, ${version.content === null ? sql`null` : sql`${JSON.stringify(version.content)}::jsonb`}, ${version.contentText},
        ${version.createdBy}, ${version.createdAt.toISOString()}::timestamptz)`);
    }
    if (!workspaceId) await database.execute(sql`drop table if exists wiki_page_projects`);
    return report;
  });
}
