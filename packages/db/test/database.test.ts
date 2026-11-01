import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, schema } from "../src";
import { createWorkspaceFactory, withRollback } from "../src/test-helpers";

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
