import { workspaces } from "./schema";
import type { Database } from "./index";

export async function createWorkspaceFactory(db: Database, overrides: Partial<{ name: string; slug: string }> = {}) {
  const [workspace] = await db.insert(workspaces).values({
    name: overrides.name ?? "Test workspace",
    slug: overrides.slug ?? `test-${crypto.randomUUID()}`,
  }).returning();
  return workspace;
}

export async function withRollback<T>(db: Database, callback: (transaction: Database) => Promise<T>): Promise<T> {
  const rollback = Symbol("rollback");
  try {
    await db.transaction(async (transaction) => {
      const result = await callback(transaction as unknown as Database);
      throw { rollback, result };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "rollback" in error && error.rollback === rollback) {
      return (error as unknown as { result: T }).result;
    }
    throw error;
  }
  throw new Error("Transaction unexpectedly committed");
}
