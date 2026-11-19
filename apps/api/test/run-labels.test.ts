// Run labels: a Run keeps the Agent's name and the Runtime's label from the moment it is created, and the Run list shows the live name or label while the Agent or Runtime exists.
import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, createDatabase, runs, runtimes, workspaces, type Database } from "@weft/db";
import { createRuntimeDispatchActions, fireScheduleTrigger, sweepRuntimeRuns } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

type Run = { id: string; agentId: string | null; workItemId: string | null; status: string; rerunOfId: string | null; agentName: string | null; runtimeLabel: string | null };

async function setup(transaction: Database) {
  const app = createApp(undefined, transaction);
  const post = (path: string, body: unknown, cookie?: string, token?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
  const response = await post("/api/auth/sign-up/email", { name: "Person", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
  const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `rl-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
  const token = await (await post("/actions/create_api_token", { name: "daemon" }, cookie)).json() as { token: string };
  const project = await (await post("/actions/create_project", { workspaceId: workspace.id, name: "Labels", key: `RL${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" }, cookie)).json() as { id: string };

  // A Runtime of one computer, shared with the workspace so an Agent can be bound to it.
  const registration = await (await post("/actions/register_daemon", { hostname: "label-host", version: "1", agentClis: ["claude"] }, undefined, token.token)).json() as { runtimes: Array<{ id: string }> };
  const runtimeId = registration.runtimes[0]!.id;
  await post("/actions/share_runtime", { runtimeId }, cookie);

  const makeAgent = async (name: string, options: { runtimeId?: string; monthlyTokenBudget?: number } = {}) => {
    const agent = await (await post("/actions/create_agent", { workspaceId: workspace.id, name, instructions: "Help.", model: "default", ...(options.runtimeId ? { runtimeId: options.runtimeId } : {}), ...(options.monthlyTokenBudget ? { monthlyTokenBudget: options.monthlyTokenBudget } : {}) }, cookie)).json() as { id: string; userId: string; name: string };
    await post("/actions/set_agent_project_access", { agentId: agent.id, allProjects: true, projectIds: [] }, cookie);
    await post("/actions/set_agent_access", { agentId: agent.id, userIds: [me.user.id] }, cookie);
    return agent;
  };
  const newItem = async (title: string) => (await (await post("/actions/create_work_item", { projectId: project.id, title }, cookie)).json() as { id: string });
  const assign = async (workItemId: string, userId: string) => post("/actions/update_work_item", { workItemId, assigneeIds: [userId] }, cookie);
  const listRuns = async (workItemId: string) => await (await post("/actions/list_runs", { workItemId }, cookie)).json() as Run[];
  const agentRuns = async (agentId: string) => await (await post("/actions/list_agent_runs", { agentId }, cookie)).json() as Run[];
  /** The Runtime dispatches a Run in the real flow; without a Daemon here the test records the Runtime the Run ran on. */
  const dispatchedOn = (runId: string, id: string) => transaction.update(runs).set({ runtimeId: id }).where(eq(runs.id, runId));
  return { app, post, cookie, me, workspace, project, runtimeId, token: token.token, makeAgent, newItem, assign, listRuns, agentRuns, dispatchedOn, transaction };
}

test.concurrent("an assignment records the Agent name and the Runtime label on a Runtime Run, and no Runtime label on a Weft server Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const coder = await s.makeAgent("Coder Bot", { runtimeId: s.runtimeId });
    const desk = await s.makeAgent("Desk Bot");
    const item = await s.newItem("Labelled");
    await s.assign(item.id, coder.userId);
    await s.assign(item.id, desk.userId);
    const runsOfItem = await s.listRuns(item.id);
    const onRuntime = runsOfItem.find((run) => run.agentId === coder.id)!;
    const onServer = runsOfItem.find((run) => run.agentId === desk.id)!;
    expect(onRuntime).toMatchObject({ agentName: "Coder Bot", runtimeLabel: "label-host · claude" });
    expect(onServer).toMatchObject({ agentName: "Desk Bot", runtimeLabel: null });
  });
});

test.concurrent("a Run that waits in a Follow-up Run records both labels", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const coder = await s.makeAgent("Coder Bot", { runtimeId: s.runtimeId });
    const item = await s.newItem("Follow up");
    await s.assign(item.id, coder.userId);
    // A Runtime Run cannot be steered, so a mention while it is active waits in a Follow-up Run.
    await s.post("/actions/create_comment", { workItemId: item.id, bodyMarkdown: "Please also check @{Coder Bot}" }, s.cookie);
    const followUp = (await s.listRuns(item.id)).find((run) => run.status === "follow_up")!;
    expect(followUp).toMatchObject({ agentName: "Coder Bot", runtimeLabel: "label-host · claude" });
  });
});

test.concurrent("a Run that is skipped for the Agent's budget records both labels", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const coder = await s.makeAgent("Budget Bot", { runtimeId: s.runtimeId, monthlyTokenBudget: 1 });
    await transaction.insert(runs).values({ workspaceId: s.workspace.id, projectId: s.project.id, agentId: coder.id, originatorId: s.me.user.id, status: "completed", inputTokens: 5 });
    const item = await s.newItem("Over budget");
    await s.assign(item.id, coder.userId);
    const skipped = (await s.listRuns(item.id)).find((run) => run.status === "skipped")!;
    expect(skipped).toMatchObject({ status: "skipped", agentName: "Budget Bot", runtimeLabel: "label-host · claude" });
  });
});

test.concurrent("a schedule Run with no work item records both labels", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const coder = await s.makeAgent("Daily Bot", { runtimeId: s.runtimeId });
    const trigger = await (await s.post("/actions/create_trigger", { agentId: coder.id, projectId: s.project.id, schedule: "daily" }, s.cookie)).json() as { id: string; nextRunAt: string };
    await fireScheduleTrigger(transaction, { triggerId: trigger.id, now: new Date(new Date(trigger.nextRunAt).getTime() + 5 * 24 * 60 * 60 * 1000) });
    const scheduled = (await s.agentRuns(coder.id)).find((run) => run.workItemId === null)!;
    expect(scheduled).toMatchObject({ agentName: "Daily Bot", runtimeLabel: "label-host · claude" });
  });
});

test.concurrent("a rerun records both labels of the Agent as it is when the rerun starts", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const coder = await s.makeAgent("Rerun Bot", { runtimeId: s.runtimeId });
    const item = await s.newItem("Rerun");
    await s.assign(item.id, coder.userId);
    const first = (await s.listRuns(item.id)).find((run) => run.agentId === coder.id)!;
    await s.post("/actions/cancel_run", { runId: first.id }, s.cookie);
    await s.post("/actions/rerun_run", { runId: first.id }, s.cookie);
    const rerun = (await s.listRuns(item.id)).find((run) => run.rerunOfId === first.id)!;
    expect(rerun).toMatchObject({ agentName: "Rerun Bot", runtimeLabel: "label-host · claude" });
  });
});

test.concurrent("the Run list shows the Runtime label recorded when the Runtime is deleted, and a renamed live Agent's new name", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const coder = await s.makeAgent("Coder Bot", { runtimeId: s.runtimeId });
    const item = await s.newItem("Runtime gone");
    await s.assign(item.id, coder.userId);
    const run = (await s.listRuns(item.id))[0]!;
    await s.dispatchedOn(run.id, s.runtimeId);
    expect((await s.listRuns(item.id))[0]!.runtimeLabel).toBe("label-host · claude");

    await s.post("/actions/update_agent", { agentId: coder.id, name: "Coder Renamed" }, s.cookie);
    expect((await s.listRuns(item.id))[0]!.agentName).toBe("Coder Renamed");

    // There is no Runtime delete action yet (runtime-lifecycle work): the row goes straight from the database, after its Agent lets go of the profile.
    await transaction.update(agents).set({ runtimeProfileId: null }).where(eq(agents.runtimeId, s.runtimeId));
    await transaction.delete(runtimes).where(eq(runtimes.id, s.runtimeId));
    const after = (await s.listRuns(item.id))[0]!;
    expect(after.runtimeLabel).toBe("label-host · claude");
    expect(after.agentName).toBe("Coder Renamed");
  });
});

test.concurrent("after the Agent is deleted the Run list shows the recorded Agent name", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const coder = await s.makeAgent("Gone Bot", { runtimeId: s.runtimeId });
    const item = await s.newItem("Agent gone");
    await s.assign(item.id, coder.userId);
    await s.post("/actions/delete_agent", { agentId: coder.id }, s.cookie);
    const run = (await s.listRuns(item.id))[0]!;
    expect(run.agentId).toBeNull();
    expect(run).toMatchObject({ agentName: "Gone Bot", runtimeLabel: "label-host · claude" });
  });
});

test.concurrent("a Run created before the labels existed shows what it showed before: the live Agent's name, and nothing once the Agent is gone", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const coder = await s.makeAgent("Old Bot");
    const item = await s.newItem("Legacy");
    await s.assign(item.id, coder.userId);
    const run = (await s.listRuns(item.id))[0]!;
    await transaction.update(runs).set({ agentName: null, runtimeLabel: null }).where(eq(runs.id, run.id));
    expect((await s.listRuns(item.id))[0]).toMatchObject({ agentName: "Old Bot", runtimeLabel: null });

    await s.post("/actions/delete_agent", { agentId: coder.id }, s.cookie);
    expect((await s.listRuns(item.id))[0]).toMatchObject({ agentName: null, runtimeLabel: null });
  });
});

test.concurrent("a Run that waits while its Agent is moved records the label of the Runtime that actually ran it", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const mover = await s.makeAgent("Mover Bot", { runtimeId: s.runtimeId });
    const item = await s.newItem("Moved while queued");
    await s.assign(item.id, mover.userId);
    const queued = (await s.listRuns(item.id)).find((run) => run.agentId === mover.id)!;
    expect(queued.runtimeLabel).toBe("label-host · claude");
    // The Agent is bound to a second computer before any Daemon takes the Run.
    const second = await (await s.post("/actions/register_daemon", { hostname: "second-host", version: "1", agentClis: ["claude"] }, undefined, s.token)).json() as { daemonId: string; runtimes: Array<{ id: string }> };
    const secondRuntimeId = second.runtimes[0]!.id;
    await s.post("/actions/share_runtime", { runtimeId: secondRuntimeId }, s.cookie);
    await s.post("/actions/update_agent", { agentId: mover.id, runtimeId: secondRuntimeId }, s.cookie);
    await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, s.workspace.id));
    const claimed = await createRuntimeDispatchActions(transaction).claimRuns({ userId: s.me.user.id, daemonId: second.daemonId }, 20);
    expect(claimed.map((run) => run.runId)).toContain(queued.id);
    // Once the second Runtime is deleted the database clears the Run's reference to it (set null): only the recorded label is left to say where the Run ran.
    await transaction.update(runs).set({ runtimeId: null }).where(eq(runs.id, queued.id));
    const after = (await s.listRuns(item.id)).find((run) => run.id === queued.id)!;
    expect(after.runtimeLabel).toBe("second-host · claude");
  });
});

test.concurrent("a queued Run handed to the Weft server when its Agent leaves the Runtime no longer names that Runtime", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const leaver = await s.makeAgent("Leaver Bot", { runtimeId: s.runtimeId });
    const item = await s.newItem("Unbound while queued");
    await s.assign(item.id, leaver.userId);
    const queued = (await s.listRuns(item.id)).find((run) => run.agentId === leaver.id)!;
    expect(queued.runtimeLabel).toBe("label-host · claude");
    await s.post("/actions/update_agent", { agentId: leaver.id, runtimeId: null }, s.cookie);
    const after = (await s.listRuns(item.id)).find((run) => run.id === queued.id)!;
    expect(after).toMatchObject({ agentName: "Leaver Bot", runtimeLabel: null });
  });
});

test.concurrent("a dispatch that expired for an Agent that has left its Runtime goes back to the server without the Runtime label", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const leaver = await s.makeAgent("Expired Bot", { runtimeId: s.runtimeId });
    const item = await s.newItem("Dispatch expired");
    await s.assign(item.id, leaver.userId);
    const run = (await s.listRuns(item.id)).find((row) => row.agentId === leaver.id)!;
    await transaction.update(runs).set({ status: "dispatched", runtimeId: s.runtimeId, dispatchedAt: new Date(Date.now() - 3_600_000) }).where(eq(runs.id, run.id));
    await transaction.update(agents).set({ runtimeId: null }).where(eq(agents.id, leaver.id));
    await sweepRuntimeRuns(transaction);
    const after = (await s.listRuns(item.id)).find((row) => row.id === run.id)!;
    expect(after).toMatchObject({ status: "queued", runtimeLabel: null });
  });
});

test.concurrent("a Follow-up Run waiting for a Runtime no longer names it once its Agent leaves the Runtime", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const leaver = await s.makeAgent("Follow Leaver", { runtimeId: s.runtimeId });
    const item = await s.newItem("Follow-up then unbound");
    await s.assign(item.id, leaver.userId);
    await s.post("/actions/create_comment", { workItemId: item.id, bodyMarkdown: "Please also check @{Follow Leaver}" }, s.cookie);
    expect((await s.listRuns(item.id)).find((run) => run.status === "follow_up")!.runtimeLabel).toBe("label-host · claude");
    await s.post("/actions/update_agent", { agentId: leaver.id, runtimeId: null }, s.cookie);
    expect((await s.listRuns(item.id)).find((run) => run.status === "follow_up")!).toMatchObject({ agentName: "Follow Leaver", runtimeLabel: null });
  });
});
