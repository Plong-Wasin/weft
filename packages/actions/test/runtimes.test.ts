import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createApiTokenActions, createRuntimeActions } from "../src";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("a Daemon registers one private Runtime per detected CLI and workspace", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Member");
    const actions = createRuntimeActions(tx);
    const { id: tokenId } = await createApiTokenActions(tx).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const daemon = await actions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1.0", agentClis: ["claude", "codex"] });
    expect(daemon.runtimes).toHaveLength(2);
    expect(daemon.runtimes.map((runtime) => runtime.agentCli).sort()).toEqual(["claude", "codex"]);
    expect(daemon.runtimes.every((runtime) => runtime.ownerId === owner.id && !runtime.shared && runtime.online)).toBe(true);
    expect((await actions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1.0", agentClis: ["claude", "codex"] })).runtimes.map((r) => r.id)).toEqual(daemon.runtimes.map((r) => r.id));
  });
});

test.concurrent("members see their private and shared Runtimes, but private Runtimes stay hidden", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Member");
    const { id: tokenId } = await createApiTokenActions(tx).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const actions = createRuntimeActions(tx);
    const { runtimes } = await actions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1.0", agentClis: ["claude", "codex"] });
    const mine = await actions.listRuntimes.handler({ userId: owner.id }, { workspaceId: workspace.id });
    expect(mine).toHaveLength(2);
    expect(await actions.listRuntimes.handler({ userId: admin.id }, { workspaceId: workspace.id })).toEqual([]);
    await actions.shareRuntime.handler({ userId: owner.id }, { runtimeId: runtimes[0]!.id });
    expect(await actions.listRuntimes.handler({ userId: admin.id }, { workspaceId: workspace.id })).toMatchObject([{ id: runtimes[0]!.id, shared: true, ownerId: owner.id }]);
    await expect(actions.unshareRuntime.handler({ userId: admin.id }, { runtimeId: runtimes[0]!.id })).rejects.toMatchObject({ status: 403 });
    await actions.unshareRuntime.handler({ userId: owner.id }, { runtimeId: runtimes[0]!.id });
    expect(await actions.listRuntimes.handler({ userId: admin.id }, { workspaceId: workspace.id })).toEqual([]);
  });
});

test.concurrent("Runtime presence expires after 150 seconds and the Daemon heartbeat restores it", async () => {
  await withRollback(db, async (tx) => {
    let current = new Date("2026-11-03T00:00:00.000Z");
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Member");
    const { id: tokenId } = await createApiTokenActions(tx).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const actions = createRuntimeActions(tx, () => current);
    const { daemonId } = await actions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    expect((await actions.listRuntimes.handler({ userId: owner.id }, { workspaceId: workspace.id }))[0]!.online).toBe(true);
    current = new Date(current.getTime() + 150_001);
    expect((await actions.listRuntimes.handler({ userId: owner.id }, { workspaceId: workspace.id }))[0]!.online).toBe(false);
    await actions.heartbeat({ userId: owner.id }, daemonId);
    expect((await actions.listRuntimes.handler({ userId: owner.id }, { workspaceId: workspace.id }))[0]!.online).toBe(true);
  });
});
