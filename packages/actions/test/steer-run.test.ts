import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createDatabase, runMessages, runs, workspaces, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createAgentActions, createApiTokenActions, createCommentActions, createProjectActions, createRuntimeActions, createWorkItemActions, handleAgentRunJob, toDisplaySteps, type RunModel, type RunModelRequest } from "../src";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const doc = (text: string, mentionUserId?: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [...(mentionUserId ? [{ type: "mention", attrs: { id: mentionUserId, label: "Bot" } }, { type: "text", text: " " }] : []), { type: "text", text }] }],
});

/** A workspace with a member who writes, and a server Agent that may work in the project. */
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

/** Posts a comment that mentions the Agent as the given author and returns its id and Wake outcome. */
async function mention(s: Setup, text: string, as = s.member.id, source?: "agent") {
  const created = await s.comments.createComment.handler({ userId: as, source }, { workItemId: s.item.id, body: doc(text, s.agent.userId) });
  return { id: created.id, outcome: created.wakeOutcomes[0]! };
}
const runsOf = (transaction: Database, workItemId: string) => transaction.select().from(runs).where(eq(runs.workItemId, workItemId)).orderBy(runs.createdAt);
const transcriptOf = (transaction: Database, runId: string) => transaction.select().from(runMessages).where(eq(runMessages.runId, runId)).orderBy(runMessages.seq);

/** A scripted provider: the first step runs `during` (a person writes while the Run is active), then the Run answers `first`; later steps answer `later`. */
function scripted(during: () => Promise<void>, first: string) {
  const requests: RunModelRequest[] = [];
  let step = 0;
  const model: RunModel = {
    async step(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      step += 1;
      if (step === 1) await during();
      const text = step === 1 ? first : "Second answer.";
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { model, requests };
}

test("a person's mention during an active server Run joins that Run, and the next model step sees it", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const first = await mention(s, "first look");
    const active = (await runsOf(transaction, s.item.id))[0]!;
    expect(first.outcome).toMatchObject({ status: "started", runId: active.id });
    const steered: { outcome?: { status: string } } = {};
    const { model, requests } = scripted(async () => {
      steered.outcome = (await mention(s, "Also check the Safari redirect.")).outcome;
    }, "First answer.");
    await handleAgentRunJob(transaction, { runId: active.id }, { model });
    expect(steered.outcome).toMatchObject({ status: "steered", runId: active.id, reason: null });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain("Also check the Safari redirect.");
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("Also check the Safari redirect.");
    expect(await transaction.select().from(runs).where(eq(runs.id, active.id))).toMatchObject([{ status: "completed" }]);
  });
});

test("a steered mention leaves no Follow-up Run, and the Wake outcome says steered", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await mention(s, "first look");
    const active = (await runsOf(transaction, s.item.id))[0]!;
    let outcome: { status: string; runId: string | null } | undefined;
    const { model } = scripted(async () => {
      outcome = (await mention(s, "Also check Safari.")).outcome;
    }, "First answer.");
    await handleAgentRunJob(transaction, { runId: active.id }, { model });
    expect(outcome).toMatchObject({ status: "steered", runId: active.id });
    const all = await runsOf(transaction, s.item.id);
    expect(all).toHaveLength(1);
    expect(all.some((run) => run.status === "follow_up")).toBe(false);
  });
});

test("a steered comment is in the Run transcript as a person's message at its place", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await mention(s, "first look");
    const active = (await runsOf(transaction, s.item.id))[0]!;
    const { model } = scripted(async () => {
      await mention(s, "Also check Safari.");
    }, "First answer.");
    await handleAgentRunJob(transaction, { runId: active.id }, { model });
    const steps = toDisplaySteps(await transcriptOf(transaction, active.id));
    // The first answer is not given: the comment came in during that step, so the Run takes another step first.
    expect(steps.map((step) => step.kind)).toEqual(["person", "answer"]);
    expect(steps[0]).toMatchObject({ kind: "person", author: expect.any(String), text: expect.stringContaining("Also check Safari.") });
    expect(steps[1]).toEqual({ seq: 2, kind: "answer", text: "Second answer." });
  });
});

test("a mention during an active Runtime Run still makes a Follow-up Run, and steers nothing", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const { id: tokenId } = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const runtimeActions = createRuntimeActions(transaction);
    const registered = await runtimeActions.registerDaemon.handler({ userId: owner.id, apiTokenId: tokenId }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    for (const runtime of registered.runtimes) await runtimeActions.shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
    const claude = registered.runtimes.find((runtime) => runtime.agentCli === "claude")!;
    const agentActions = createAgentActions(transaction);
    const agent = await agentActions.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Coder", model: "default", runtimeId: claude.id });
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Runtime", key: "RUN", visibility: "private" });
    await agentActions.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
    const comments = createCommentActions(transaction);
    const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Round trip", assigneeIds: [agent.userId] });
    const active = (await runsOf(transaction, item.id))[0]!;
    expect(active).toMatchObject({ status: "queued", runtimeId: null });
    const asked = await comments.createComment.handler({ userId: owner.id }, { workItemId: item.id, body: doc("Also check Safari.", agent.userId) });
    expect(asked.wakeOutcomes[0]).toMatchObject({ status: "waiting", reason: null });
    const all = await runsOf(transaction, item.id);
    expect(all.map((run) => run.status).sort()).toEqual(["follow_up", "queued"]);
    expect(await transcriptOf(transaction, active.id)).toEqual([]);
  });
});

test("a mention written by an Agent never steers the Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await mention(s, "first look");
    const active = (await runsOf(transaction, s.item.id))[0]!;
    const written = await mention(s, "Agent note.", s.member.id, "agent");
    expect(written.outcome).toMatchObject({ status: "skipped", reason: "switch_off", runId: null });
    expect(await transcriptOf(transaction, active.id)).toEqual([]);
    expect(await runsOf(transaction, s.item.id)).toHaveLength(1);
    expect(await transaction.select().from(runs).where(and(eq(runs.id, active.id), eq(runs.status, "queued")))).toHaveLength(1);
  });
});

test("a Run that has already ended is not steered: the mention starts a normal Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await mention(s, "first look");
    const ended = (await runsOf(transaction, s.item.id))[0]!;
    await handleAgentRunJob(transaction, { runId: ended.id }, { model: scripted(async () => {}, "Done.").model });
    expect(await transaction.select().from(runs).where(eq(runs.id, ended.id))).toMatchObject([{ status: "completed" }]);
    const later = await mention(s, "Also check Safari.");
    expect(later.outcome).toMatchObject({ status: "started", reason: null });
    expect(later.outcome.runId).not.toBe(ended.id);
    expect(await transcriptOf(transaction, ended.id)).not.toContainEqual(expect.objectContaining({ type: "steer" }));
    expect(await runsOf(transaction, s.item.id)).toHaveLength(2);
  });
});
