import { afterAll, expect, test } from "bun:test";
import { assets, createDatabase } from "@weft/db";
import { createActionList, createWikiActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** These tests change the process environment, so they are `test.serial` and live in a file of their own. */
async function inProduction(secret: string | undefined, run: () => Promise<void>) {
  const saved = { NODE_ENV: Bun.env.NODE_ENV, S3_SECRET_KEY: Bun.env.S3_SECRET_KEY };
  const set = (name: string, value: string | undefined) => { if (value === undefined) delete Bun.env[name]; else Bun.env[name] = value; };
  set("NODE_ENV", "production");
  set("S3_SECRET_KEY", secret);
  try { await run(); } finally { for (const [name, value] of Object.entries(saved)) set(name, value); }
}

test.serial("building the Action list needs no S3 secret in production", async () => {
  await inProduction(undefined, async () => {
    expect(() => createActionList(db, { integrations: true, outboundWebhooks: true })).not.toThrow();
  });
});

for (const [label, secret] of [["a missing", undefined], ["the default", "weft-secret"]] as const) {
  test.serial(`an Action that uses storage fails in production with ${label} S3_SECRET_KEY`, async () => {
    await withRollback(db, async (tx) => {
      const workspace = await createWorkspaceFactory(tx);
      const member = await createMemberFactory(tx, workspace.id, "Member");
      const page = await createWikiActions(tx).createWikiPage.handler({ userId: member.id }, { workspaceId: workspace.id, title: "With a file" });
      const assetId = crypto.randomUUID();
      await tx.insert(assets).values({ id: assetId, workspaceId: workspace.id, projectId: null, ownerType: "wiki_page", ownerId: page.id, uploaderId: member.id, storageKey: `${workspace.id}/${assetId}`, filename: "file.png", contentType: "image/png", size: 10, status: "uploaded", uploadedAt: new Date() });
      await inProduction(secret, async () => {
        await expect(createWikiActions(tx).duplicateWikiPage.handler({ userId: member.id }, { pageId: page.id })).rejects.toThrow("S3_SECRET_KEY is unset");
      });
    });
  });
}
