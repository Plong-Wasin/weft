import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createProjectActions, createSearchActions, createWikiActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

// The "[[" picker lists what search_work_items and search_wiki_pages return for its query: these tests pin the rows a
// non-member, a Guest and a member see, and the project key each Project Page carries.
const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const items = createWorkItemActions(transaction);
  const wiki = createWikiActions(transaction);
  const search = createSearchActions(transaction);
  const mobile = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const secret = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
  await items.createWorkItem.handler({ userId: member.id }, { projectId: mobile.id, title: "Dark mode toggle" });
  await items.createWorkItem.handler({ userId: member.id }, { projectId: secret.id, title: "Dark mode secret" });
  await wiki.createWikiPage.handler({ userId: member.id }, { workspaceId: workspace.id, projectId: mobile.id, title: "Dark mode guide", access: "public" });
  await wiki.createWikiPage.handler({ userId: member.id }, { workspaceId: workspace.id, projectId: secret.id, title: "Dark mode draft", access: "public" });
  await wiki.createWikiPage.handler({ userId: member.id }, { workspaceId: workspace.id, title: "Dark mode handbook", access: "public" });
  // What the picker asks for, with the picker's own limit.
  const picker = async (userId: string, query: string) => ({
    works: (await search.searchWorkItems.handler({ userId }, { workspaceId: workspace.id, query, limit: 8 })).map((row) => row.displayId),
    pages: (await wiki.searchWikiPages.handler({ userId }, { workspaceId: workspace.id, query, limit: 8 })).map((row) => ({ title: row.title, projectKey: row.projectKey })),
  });
  return { workspace, member, outsider, guest, mobile, secret, picker };
}

test.concurrent("the link picker lists only the Work items and pages the person can open", async () => {
  await withRollback(db, async (transaction) => {
    const { member, outsider, guest, picker, workspace } = await setup(transaction);
    const search = createSearchActions(transaction);
    const titles = async (userId: string) => (await search.searchWorkItems.handler({ userId }, { workspaceId: workspace.id, query: "dark mode", limit: 8 })).map((row) => row.title).sort();
    // A Work item of a public project another person belongs to is listed; a private project's Work item is not.
    expect(await titles(outsider.id)).toEqual(["Dark mode toggle"]);
    expect(await titles(guest.id)).toEqual(["Dark mode toggle"]);
    expect(await titles(member.id)).toEqual(["Dark mode secret", "Dark mode toggle"]);
    // A Project Page is listed only to members of its project; a Wiki page only when it is public or shared with the person.
    expect((await picker(outsider.id, "dark mode")).pages.map((page) => page.title)).toEqual(["Dark mode handbook"]);
    expect((await picker(guest.id, "dark mode")).pages.map((page) => page.title)).toEqual(["Dark mode handbook"]);
    expect((await picker(member.id, "dark mode")).pages.map((page) => page.title).sort()).toEqual(["Dark mode draft", "Dark mode guide", "Dark mode handbook"]);
  });
});

test.concurrent("the picker's page rows carry the project key of a Project Page and none for a Wiki page", async () => {
  await withRollback(db, async (transaction) => {
    const { member, picker } = await setup(transaction);
    const rows = (await picker(member.id, "dark mode")).pages;
    expect(rows.find((page) => page.title === "Dark mode guide")?.projectKey).toBe("MOB");
    expect(rows.find((page) => page.title === "Dark mode draft")?.projectKey).toBe("SEC");
    expect(rows.find((page) => page.title === "Dark mode handbook")?.projectKey).toBeNull();
  });
});

test.concurrent("the picker's Work item rows carry the key that the link label starts with", async () => {
  await withRollback(db, async (transaction) => {
    const { member, outsider, picker } = await setup(transaction);
    expect((await picker(member.id, "dark mode")).works).toContain("MOB-1");
    expect((await picker(outsider.id, "MOB-1")).works).toEqual(["MOB-1"]);
    expect((await picker(outsider.id, "SEC-1")).works).toEqual([]);
  });
});
