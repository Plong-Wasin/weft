import { afterAll, expect, test } from "bun:test";
import { createDatabase, schema } from "@weft/db";
import { createWorkspaceAction } from "../src";
import { createUserFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("signup stays open until the first workspace exists", async () => {
  await withRollback(db, async (transaction) => {
    const user = await createUserFactory(transaction);
    const action = createWorkspaceAction(transaction, { allowSignup: false, allowWorkspaceCreation: false });
    expect(await action.canSignUp()).toBe(true);
    await action.handler({ userId: user.id }, { name: "First", slug: `first-${crypto.randomUUID()}` });
    expect(await action.canSignUp()).toBe(false);
  });
});

test.concurrent("workspace creation gate blocks extra workspaces but permits the first", async () => {
  await withRollback(db, async (transaction) => {
    const user = await createUserFactory(transaction, { createdAt: new Date("2025-01-01T00:00:00Z") });
    const secondUser = await createUserFactory(transaction, { createdAt: new Date("2025-01-02T00:00:00Z") });
    const action = createWorkspaceAction(transaction, { allowSignup: true, allowWorkspaceCreation: false });
    const firstSlug = `first-${crypto.randomUUID()}`;
    await action.handler({ userId: user.id }, { name: "First", slug: firstSlug });
    await expect(action.handler({ userId: secondUser.id }, { name: "Second", slug: `second-${crypto.randomUUID()}` }))
      .rejects.toThrow("Workspace creation is disabled");
  });
});

test.concurrent("signup gate rejects open signup when a workspace already exists", async () => {
  await withRollback(db, async (transaction) => {
    const action = createWorkspaceAction(transaction, { allowSignup: false, allowWorkspaceCreation: true });
    const user = await createUserFactory(transaction);
    await action.handler({ userId: user.id }, { name: "First", slug: `first-${crypto.randomUUID()}` });
    expect(await action.canSignUp()).toBe(false);
  });
});
