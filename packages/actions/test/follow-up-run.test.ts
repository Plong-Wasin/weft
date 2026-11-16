import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, agents, comments, createDatabase, jobs, runs, workspaces, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createAgentActions, createApiTokenActions, createCommentActions, createProjectActions, createRunActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions, decideAndStartWake, handleAgentRunJob, type RunModel, type RunModelRequest } from "../src";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** Every test runs in one database transaction, where `now()` is the same for every row: comment and Run times are stamped by hand. */
const base = Date.parse("2026-11-16T10:00:00.000Z");
const at = (minutes: number) => new Date(base + minutes * 60_000);

/** A scripted provider that answers once with `text` and records the request it was given. */
function answering(text: string) {
  const requests: RunModelRequest[] = [];
  const model: RunModel = {
    async step(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { model, requests };
}

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const agents = createAgentActions(transaction);
  const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", instructions: "Be brief.", model: "default" });
  await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const work = createWorkItemActions(transaction);
  const comments = createCommentActions(transaction);
  const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Fix the login" });
  return { workspace, admin, member, project, agent, work, comments, item };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const doc = (text: string, mentionUserId?: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [...(mentionUserId ? [{ type: "mention", attrs: { id: mentionUserId, label: "Bot" } }, { type: "text", text: " " }] : []), { type: "text", text }] }],
});

/** Posts a comment that mentions the Agent; the returned outcome is the mention's Wake outcome. */
async function mention(s: Setup, text: string) {
  const created = await s.comments.createComment.handler({ userId: s.member.id }, { workItemId: s.item.id, body: doc(text, s.agent.userId) });
  return { id: created.id, outcome: created.wakeOutcomes[0]! };
}
async function plain(s: Setup, text: string) {
  return (await s.comments.createComment.handler({ userId: s.member.id }, { workItemId: s.item.id, bodyMarkdown: text })).id;
}
/** Sets the time a comment or Run was written, since one transaction gives every row the same `now()`. */
async function stampComment(transaction: Database, id: string, when: Date) {
  await transaction.update(comments).set({ createdAt: when }).where(eq(comments.id, id));
}
async function stampRun(transaction: Database, id: string, when: Date) {
  await transaction.update(runs).set({ createdAt: when }).where(eq(runs.id, id));
}
const runsOf = (transaction: Database, workItemId: string) => transaction.select().from(runs).where(eq(runs.workItemId, workItemId)).orderBy(runs.createdAt);
/** The Run that holds the work item, not a Follow-up Run: rows written in one transaction share a timestamp, so order cannot pick it. */
const activeRunOf = async (transaction: Database, workItemId: string) => (await runsOf(transaction, workItemId)).find((run) => run.status !== "follow_up")!;
const reload = async (transaction: Database, runId: string) => (await transaction.select().from(runs).where(eq(runs.id, runId)))[0]!;

test("a mention during an active server Run keeps one Follow-up Run that starts when the active Run completes", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const first = await mention(s, "first look");
    const active = (await runsOf(transaction, s.item.id))[0]!;
    expect(first.outcome).toMatchObject({ status: "started", runId: active.id });
    const second = await mention(s, "second look");
    expect(second.outcome).toMatchObject({ agentId: s.agent.id, status: "waiting", reason: null });
    const followUp = await reload(transaction, second.outcome.runId!);
    expect(followUp).toMatchObject({ status: "follow_up", agentId: s.agent.id, depth: 0, wokenByRunId: null, originatorId: s.member.id });
    expect(await reload(transaction, active.id)).toMatchObject({ status: "queued" });
    // Nothing is queued for the follow-up while its active Run is still going.
    expect((await transaction.select().from(jobs)).some((job) => (job.dedupeKey ?? "") === `agent_run:${followUp.id}`)).toBe(false);

    const { model } = answering("Done.");
    await handleAgentRunJob(transaction, { runId: active.id }, { model });
    expect(await reload(transaction, active.id)).toMatchObject({ status: "completed" });
    expect(await reload(transaction, followUp.id)).toMatchObject({ status: "queued" });
    expect((await transaction.select().from(jobs)).some((job) => job.dedupeKey === `agent_run:${followUp.id}`)).toBe(true);
    expect(await runsOf(transaction, s.item.id)).toHaveLength(2);
  });
});

test("a second request before the Follow-up Run starts joins it, so there is still one", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await mention(s, "active");
    const second = await mention(s, "waiting one");
    const third = await mention(s, "waiting two");
    expect(second.outcome).toMatchObject({ status: "waiting", runId: expect.any(String) });
    expect(third.outcome).toMatchObject({ status: "waiting", runId: second.outcome.runId });
    const followUps = (await runsOf(transaction, s.item.id)).filter((run) => run.status === "follow_up");
    expect(followUps).toHaveLength(1);
  });
});

test("an assignment that targets an Agent with an active Run on the item waits too", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await mention(s, "active");
    const assigned = await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: s.item.id, assigneeIds: [s.agent.userId] });
    expect(assigned.wakeOutcomes).toEqual([expect.objectContaining({ agentId: s.agent.id, status: "waiting", reason: null })]);
    expect((await runsOf(transaction, s.item.id)).map((run) => run.status).sort()).toEqual(["follow_up", "queued"]);
  });
});

test("the Activity and the Wake outcome say waiting, never skipped", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const active = await mention(s, "active");
    const waiting = await mention(s, "later");
    const rows = await transaction.select({ field: activities.field, newValue: activities.newValue }).from(activities).where(and(eq(activities.entityId, s.item.id), eq(activities.field, "run_waiting")));
    expect(rows).toEqual([expect.objectContaining({ newValue: expect.objectContaining({ status: "waiting", agentName: "Bot", runId: waiting.outcome.runId }) })]);
    expect(active.outcome.status).toBe("started");
    expect(JSON.stringify(rows)).not.toContain("skipped");
  });
});

test("a Follow-up Run inherits the depth and the waking Run of the request that asked for it", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await mention(s, "active");
    const active = await activeRunOf(transaction, s.item.id);
    const outcome = await decideAndStartWake(transaction, {
      waker: "person", target: { id: s.agent.id, userId: s.agent.userId, name: "Bot", budget: null }, workspaceId: s.workspace.id, projectId: s.project.id,
      workItemId: s.item.id, originatorId: s.member.id, chain: { wokenByRunId: active!.id, depth: 3 },
    });
    expect(outcome).toMatchObject({ status: "waiting" });
    expect(await reload(transaction, outcome.runId!)).toMatchObject({ status: "follow_up", depth: 3, wokenByRunId: active!.id });
  });
});

test("the Follow-up Run prompt holds the comments written since the previous Run began, in order, and not the ones before it", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const before = await plain(s, "written before the first Run");
    await stampComment(transaction, before, at(-30));
    const first = await mention(s, "the first request");
    await stampComment(transaction, first.id, at(-5));
    const active = await activeRunOf(transaction, s.item.id);
    await stampRun(transaction, active!.id, at(0));
    const between = await plain(s, "reviewer note B");
    await stampComment(transaction, between, at(1));
    const later = await mention(s, "reviewer note C");
    await stampComment(transaction, later.id, at(2));
    const waiting = await reload(transaction, later.outcome.runId!);
    expect(waiting.status).toBe("follow_up");
    expect(first.outcome.status).toBe("started");

    await handleAgentRunJob(transaction, { runId: active!.id }, { model: answering("First answer.").model });
    const { model, requests } = answering("Second answer.");
    await handleAgentRunJob(transaction, { runId: waiting.id }, { model });
    const prompt = JSON.stringify(requests[0]!.messages);
    expect(prompt).toContain("reviewer note B");
    expect(prompt).toContain("reviewer note C");
    expect(prompt.indexOf("reviewer note B")).toBeLessThan(prompt.indexOf("reviewer note C"));
    expect(prompt).not.toContain("written before the first Run");
    expect(await reload(transaction, waiting.id)).toMatchObject({ status: "completed" });
  });
});

test("with 25 comments since the previous Run, the prompt holds the newest 20 and says that some were cut", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const first = await mention(s, "the first request");
    await stampComment(transaction, first.id, at(-5));
    const active = await activeRunOf(transaction, s.item.id);
    await stampRun(transaction, active!.id, at(0));
    for (let n = 1; n <= 24; n += 1) {
      const id = await plain(s, `note ${String(n).padStart(2, "0")}`);
      await stampComment(transaction, id, at(n / 100));
    }
    const last = await mention(s, "note 25 please look");
    await stampComment(transaction, last.id, at(0.25));
    const waiting = await reload(transaction, last.outcome.runId!);
    await handleAgentRunJob(transaction, { runId: active!.id }, { model: answering("Done.").model });
    const { model, requests } = answering("Done again.");
    await handleAgentRunJob(transaction, { runId: waiting.id }, { model });
    const prompt = JSON.stringify(requests[0]!.messages);
    expect(prompt).toContain("note 06");
    expect(prompt).toContain("note 25 please look");
    expect(prompt).not.toContain("note 05");
    expect(prompt).toContain("5 earlier comments were left out");
  });
});

test("a very large comment set keeps the comment block within 64 KiB, and a newest comment too large for it is cut and says so", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const first = await mention(s, "the first request");
    await stampComment(transaction, first.id, at(-5));
    const active = await activeRunOf(transaction, s.item.id);
    await stampRun(transaction, active!.id, at(0));
    for (let n = 1; n <= 4; n += 1) {
      const id = await plain(s, `big ${n} ${"x".repeat(30 * 1024)}`);
      await stampComment(transaction, id, at(n / 100));
    }
    const latest = await mention(s, `latest request ${"z".repeat(100 * 1024)}`);
    await stampComment(transaction, latest.id, at(0.6));
    const waiting = await reload(transaction, latest.outcome.runId!);
    await handleAgentRunJob(transaction, { runId: active!.id }, { model: answering("Done.").model });
    const { model, requests } = answering("Done again.");
    await handleAgentRunJob(transaction, { runId: waiting.id }, { model });
    const prompt = JSON.stringify(requests[0]!.messages[0]);
    expect(Buffer.byteLength(prompt)).toBeLessThan(64 * 1024 + 4 * 1024);
    expect(prompt).toContain("latest request zzz");
    expect(prompt).toContain("4 earlier comments were left out");
    expect(prompt).not.toContain("big 1 ");
  });
});

test("a Follow-up Run starts after the active Run is cancelled", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const active = await mention(s, "active");
    const waiting = await mention(s, "still wanted");
    const activeRun = await activeRunOf(transaction, s.item.id);
    await createRunActions(transaction).cancelRun.handler({ userId: s.member.id }, { runId: activeRun!.id });
    expect(await reload(transaction, activeRun!.id)).toMatchObject({ status: "cancelled" });
    expect(await reload(transaction, waiting.outcome.runId!)).toMatchObject({ status: "queued" });
    expect(active.outcome.status).toBe("started");
  });
});

test("a Follow-up Run starts after the active Run fails", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await mention(s, "active");
    const waiting = await mention(s, "still wanted");
    const activeRun = await activeRunOf(transaction, s.item.id);
    const broken: RunModel = { async step() { throw new Error("provider rejected the request"); } };
    await handleAgentRunJob(transaction, { runId: activeRun!.id }, { model: broken });
    expect(await reload(transaction, activeRun!.id)).toMatchObject({ status: "failed" });
    expect(await reload(transaction, waiting.outcome.runId!)).toMatchObject({ status: "queued" });
  });
});

test("a Follow-up Run for a Runtime Run starts when the Daemon finishes the active Run, and its claim carries the waiting comments", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const { id: tokenId } = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const registered = await createRuntimeActions(transaction).registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    const runtime = registered.runtimes[0]!;
    await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
    await createProjectActions(transaction).addProjectMember.handler({ userId: owner.id }, { projectId: project.id, userId: member.id, role: "Member" });
    const agent = await createAgentActions(transaction).createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Bot", instructions: "Do the work", model: "default" });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await createAgentActions(transaction).updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId: runtime.id });
    await createAgentActions(transaction).setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [owner.id, member.id] });
    const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Runtime work", assigneeIds: [agent.userId] });
    const dispatch = createRuntimeDispatchActions(transaction);
    const [claimed] = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    expect(claimed).toMatchObject({ status: "dispatched" });

    const comments = createCommentActions(transaction);
    const waitingComment = await comments.createComment.handler({ userId: member.id }, { workItemId: item.id, body: doc("reviewer on the Runtime", agent.userId) });
    expect(waitingComment.wakeOutcomes).toEqual([expect.objectContaining({ agentId: agent.id, status: "waiting" })]);
    const [followUp] = (await runsOf(transaction, item.id)).filter((run) => run.status === "follow_up");
    expect(followUp).toBeDefined();

    await dispatch.startRun(claimed!.runId, runtime.id);
    await dispatch.finishRun(claimed!.runId, { status: "completed", finalOutput: "Round one done." });
    expect(await reload(transaction, claimed!.runId)).toMatchObject({ status: "completed" });
    expect(await reload(transaction, followUp!.id)).toMatchObject({ status: "queued" });

    const [second] = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    expect(second).toMatchObject({ runId: followUp!.id, status: "dispatched" });
    expect(second!.request).toContain("reviewer on the Runtime");
  });
});

test("the database refuses a second Follow-up Run for one Agent and work item", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await mention(s, "active");
    await mention(s, "waiting");
    const row = { workspaceId: s.workspace.id, projectId: s.project.id, workItemId: s.item.id, agentId: s.agent.id, originatorId: s.member.id };
    await expect(transaction.transaction(async (savepoint) => { await savepoint.insert(runs).values({ ...row, status: "follow_up" }); })).rejects.toThrow();
    expect(await runsOf(transaction, s.item.id)).toHaveLength(2);
  });
});
