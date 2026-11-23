import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, apiTokens, cliDevices, createDatabase, daemons, runs, runtimes, workspaces, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions, daemonForCredential, mintApiToken, sweepRuntimeRuns } from "../src";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function enrolledDevice(transaction: Parameters<Parameters<typeof withRollback>[1]>[0], ownerId: string, hostname: string) {
  const tokens = createApiTokenActions(transaction);
  const issued = await tokens.createApiToken.handler({ userId: ownerId }, { name: `CLI @ ${hostname}` });
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(issued.token))).toString("hex");
  const [token] = await transaction.select().from(apiTokens).where(eq(apiTokens.tokenHash, hash));
  const deviceId = crypto.randomUUID();
  await transaction.insert(cliDevices).values({ deviceId, ownerId, hostname, tokenId: token!.id });
  return { tokenId: token!.id, token: issued.token, deviceId };
}

test.concurrent("device listings are account scoped and distinguish same-hostname CLI devices", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    await tx.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const stranger = await createMemberFactory(tx, workspace.id, "Member");
    const first = await enrolledDevice(tx, owner.id, "shared-host");
    const second = await enrolledDevice(tx, owner.id, "shared-host");
    const tokens = createApiTokenActions(tx);
    for (let index = 0; index < 21; index += 1) {
      const inactive = await enrolledDevice(tx, owner.id, `old-host-${index}`);
      await tx.update(apiTokens).set({ expiresAt: new Date(Date.now() - 10_000) }).where(eq(apiTokens.id, inactive.tokenId));
    }
    const runtimeActions = createRuntimeActions(tx);
    const one = await runtimeActions.registerDaemon.handler({ userId: owner.id, apiTokenId: first.tokenId }, { hostname: "shared-host", version: "1", agentClis: ["codex"] });
    const two = await runtimeActions.registerDaemon.handler({ userId: owner.id, apiTokenId: second.tokenId }, { hostname: "shared-host", version: "1", agentClis: ["codex"] });
    expect(two.daemonId).not.toBe(one.daemonId);
    const page = await tokens.listCliDevices.handler({ userId: owner.id }, {});
    expect(page.active.map((row) => row.id).sort()).toEqual([first.deviceId, second.deviceId].sort());
    expect(page.active.every((row) => row.hostname === "shared-host" && row.status === "active")).toBe(true);
    expect(page.historyCount).toBe(21);
    expect(page.history).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    const next = await tokens.listCliDevices.handler({ userId: owner.id }, { historyOffset: page.history.length });
    expect(next.history).toHaveLength(1);
    expect(next.hasMore).toBe(false);
    expect(await createApiTokenActions(tx).listCliDevices.handler({ userId: stranger.id }, {})).toMatchObject({ active: [], history: [], historyCount: 0 });
  });
});

test.concurrent("revoking a device blocks CLI and Daemon credentials, stops dispatch, and distinguishes Run stop confirmation", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    await tx.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const stranger = await createMemberFactory(tx, workspace.id, "Member");
    const tokens = createApiTokenActions(tx);
    const connected = await enrolledDevice(tx, owner.id, "connected-box");
    const disconnected = await enrolledDevice(tx, owner.id, "offline-box");
    const runtimeActions = createRuntimeActions(tx);
    const runtimeDispatch = createRuntimeDispatchActions(tx);
    const devices = await Promise.all([connected, disconnected].map(async (device, index) => {
      const registration = await runtimeActions.registerDaemon.handler({ userId: owner.id, apiTokenId: device.tokenId }, { hostname: index ? "offline-box" : "connected-box", version: "1", agentClis: ["codex"] });
      return { ...device, registration, runtime: registration.runtimes[0]! };
    }));
    const project = await createProjectActions(tx).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Device revoke", key: "DVR", visibility: "private" });
    const agents = createAgentActions(tx);
    const runsToRevoke: Array<{ device: typeof devices[number]; runId: string }> = [];
    for (const [index, device] of devices.entries()) {
      await runtimeActions.shareRuntime.handler({ userId: owner.id }, { runtimeId: device.runtime.id });
      const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: `Device Agent ${index}`, model: "default", runtimeId: device.runtime.id });
      await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
      const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: `Device Run ${index}`, assigneeIds: [agent.userId] });
      const claimed = await runtimeDispatch.claimRuns({ userId: owner.id, daemonId: device.registration.daemonId });
      expect(claimed).toHaveLength(1);
      await runtimeDispatch.startRun(claimed[0]!.runId, claimed[0]!.runtimeId);
      runsToRevoke.push({ device, runId: claimed[0]!.runId });
      expect(item.id).toBeTruthy();
    }
    const daemonTokens = await tx.select({ tokenId: daemons.tokenId, deviceId: daemons.cliDeviceId }).from(daemons).where(eq(daemons.ownerId, owner.id));
    expect(daemonTokens.every((token) => token.deviceId !== null)).toBe(true);
    expect((await daemonForCredential(tx, { tokenId: daemonTokens[0]!.tokenId, userId: owner.id }))?.id).toBeTruthy();

    await tokens.revokeCliDevice.handler({ userId: owner.id }, { deviceId: connected.deviceId });
    expect(await tokens.authenticateWithToken(connected.token)).toBeNull();
    expect(await tokens.authenticateDaemonToken((devices[0]!.registration.daemonToken)!)).toBeNull();
    expect(await runtimeDispatch.claimRuns({ userId: owner.id, daemonId: devices[0]!.registration.daemonId })).toEqual([]);
    expect(await tx.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, runsToRevoke[0]!.runId)))
      .toEqual([{ status: "stopping", failureReason: "cli_device_revoked" }]);
    await runtimeDispatch.acknowledgeCancel(runsToRevoke[0]!.runId);
    expect(await tx.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, runsToRevoke[0]!.runId)))
      .toEqual([{ status: "cancelled", failureReason: "cli_device_revoked_confirmed" }]);

    await tokens.revokeCliDevice.handler({ userId: owner.id }, { deviceId: disconnected.deviceId });
    const later = new Date(Date.now() + 200_000);
    await sweepRuntimeRuns(tx, () => later);
    expect(await tx.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, runsToRevoke[1]!.runId)))
      .toEqual([{ status: "cancelled", failureReason: "cli_device_revoked_unconfirmed" }]);
    expect(await tokens.listCliDevices.handler({ userId: owner.id }, {})).toMatchObject({ active: [], historyCount: 2 });
    expect(await tx.select({ entityType: activities.entityType, field: activities.field }).from(activities).where(and(eq(activities.entityType, "cli_device"), eq(activities.entityId, connected.deviceId))))
      .toEqual([{ entityType: "cli_device", field: "cli_device.revoked" }]);
    await expect(tokens.revokeCliDevice.handler({ userId: stranger.id }, { deviceId: connected.deviceId })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("a failed Run cancellation rolls back the entire device revocation", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    await tx.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const device = await enrolledDevice(tx, owner.id, "atomic-box");
    const runtimeActions = createRuntimeActions(tx);
    const registration = await runtimeActions.registerDaemon.handler({ userId: owner.id, apiTokenId: device.tokenId }, { hostname: "atomic-box", version: "1", agentClis: ["codex"] });
    const project = await createProjectActions(tx).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Atomic revoke", key: "ATV", visibility: "private" });
    await runtimeActions.shareRuntime.handler({ userId: owner.id }, { runtimeId: registration.runtimes[0]!.id });
    const agent = await createAgentActions(tx).createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Atomic Agent", model: "default", runtimeId: registration.runtimes[0]!.id });
    await createAgentActions(tx).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
    await createWorkItemActions(tx).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Atomic Run", assigneeIds: [agent.userId] });
    const [claimed] = await createRuntimeDispatchActions(tx).claimRuns({ userId: owner.id, daemonId: registration.daemonId });
    await createRuntimeDispatchActions(tx).startRun(claimed!.runId, claimed!.runtimeId);

    const failOnRunUpdate = (target: object) => new Proxy(target, {
      get(inner, property) {
        if (property === "update") return (table: unknown) => table === runs
          ? { set: () => ({ where: () => ({ returning: async () => { throw new Error("injected cancellation write failure"); } }) }) }
          : Reflect.get(inner, property, inner).call(inner, table);
        const value = Reflect.get(inner, property, inner);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
    const failingDb = new Proxy(tx as object, {
      get(inner, property) {
        if (property === "transaction") return (callback: (transaction: unknown) => Promise<unknown>) =>
          tx.transaction((transaction) => callback(failOnRunUpdate(transaction as object) as unknown));
        const value = Reflect.get(inner, property, inner);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    }) as Database;

    await expect(createApiTokenActions(failingDb).revokeCliDevice.handler({ userId: owner.id }, { deviceId: device.deviceId }))
      .rejects.toThrow("injected cancellation write failure");
    expect(await tx.select({ revokedAt: cliDevices.revokedAt }).from(cliDevices).where(eq(cliDevices.deviceId, device.deviceId)))
      .toEqual([{ revokedAt: null }]);
    expect(await tx.select({ revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.id, device.tokenId)))
      .toEqual([{ revokedAt: null }]);
    expect(await tx.select({ stopped: runtimes.stopped }).from(runtimes).where(eq(runtimes.daemonId, registration.daemonId)))
      .toEqual([{ stopped: false }]);
    expect(await tx.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, claimed!.runId)))
      .toEqual([{ status: "running", failureReason: null }]);
  });
});

test.concurrent("legacy credentials stay separately visible and inactive histories are paged", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const tokens = createApiTokenActions(tx);
    const legacy = await tokens.createApiToken.handler({ userId: owner.id }, { name: "Old CLI credential" });
    const legacyDaemon = await (async () => {
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacy.token))).toString("hex");
      const [row] = await tx.select().from(apiTokens).where(eq(apiTokens.tokenHash, hash));
      const daemon = await tokens.createApiToken.handler({ userId: owner.id }, { name: "Unassociated Daemon" });
      const daemonHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(daemon.token))).toString("hex");
      const [daemonRow] = await tx.select().from(apiTokens).where(eq(apiTokens.tokenHash, daemonHash));
      await tx.update(apiTokens).set({ daemonOnly: true }).where(eq(apiTokens.id, daemonRow!.id));
      return { row: row!, daemonRow: daemonRow! };
    })();
    await tx.update(apiTokens).set({ expiresAt: new Date(Date.now() - 10_000) }).where(eq(apiTokens.id, legacyDaemon.row.id));
    await tx.update(apiTokens).set({ expiresAt: new Date(Date.now() - 10_000) }).where(eq(apiTokens.id, legacyDaemon.daemonRow.id));
    for (let index = 0; index < 20; index += 1) {
      const expired = await tokens.createApiToken.handler({ userId: owner.id }, { name: `Old token ${index}` });
      await tx.update(apiTokens).set({ expiresAt: new Date(Date.now() - 10_000) }).where(eq(apiTokens.id, expired.id));
    }
    const listed = await tokens.listManagedCredentials.handler({ userId: owner.id }, {});
    expect(listed.active).toEqual([]);
    expect(listed.historyCount).toBe(22);
    expect(listed.history).toHaveLength(20);
    expect(listed.hasMore).toBe(true);
    const next = await tokens.listManagedCredentials.handler({ userId: owner.id }, { historyOffset: listed.history.length });
    expect(next.history).toHaveLength(2);
    expect(next.hasMore).toBe(false);
    expect(new Set([...listed.history, ...next.history].map((row) => row.id)).size).toBe(22);
    expect([...listed.history, ...next.history].map((row) => row.kind)).toContain("daemon");
    expect([...listed.history, ...next.history].map((row) => row.kind)).toContain("personal");
    expect((await tokens.listApiTokens.handler({ userId: owner.id }, {})).map((row) => row.name)).toContain("Old CLI credential");
  });
});

test.concurrent("revoking an unassociated legacy Daemon credential stops its Runtime and requests active Run cancellation", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const owner = await createMemberFactory(tx, workspace.id, "Admin");
    const project = await createProjectActions(tx).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Legacy revoke", key: `LR${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
    const credential = await mintApiToken(tx, { userId: owner.id, name: "Daemon @ legacy-box", description: "Restricted Daemon credential", daemonOnly: true });
    const [daemon] = await tx.insert(daemons).values({ ownerId: owner.id, tokenId: credential.id, hostname: "legacy-box", version: "1" }).returning();
    const [runtime] = await tx.insert(runtimes).values({ workspaceId: workspace.id, daemonId: daemon!.id, ownerId: owner.id, agentCli: "codex" }).returning();
    const [run] = await tx.insert(runs).values({ workspaceId: workspace.id, projectId: project.id, originatorId: owner.id, runtimeId: runtime!.id, status: "running" }).returning();
    const tokens = createApiTokenActions(tx);
    await tokens.revokeApiToken.handler({ userId: owner.id }, { tokenId: credential.id });
    expect(await tokens.authenticateDaemonToken(credential.token)).toBeNull();
    expect(await tx.select({ stopped: runtimes.stopped }).from(runtimes).where(eq(runtimes.id, runtime!.id))).toEqual([{ stopped: true }]);
    expect(await tx.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, run!.id)))
      .toEqual([{ status: "stopping", failureReason: "daemon_credential_revoked" }]);
  });
});
