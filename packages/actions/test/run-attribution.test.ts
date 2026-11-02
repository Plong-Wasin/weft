import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { confirmations, createDatabase, runs, type Database } from "@weft/db";
import {
  createAgentActions, createCommentActions, createConfirmationStore, createProjectActions, createTimelineActions, createWorkItemActions, handleAgentRunJob,
  type RunModel, type RunModelResponse,
} from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

function scriptedModel(steps: Array<Partial<RunModelResponse>>) {
  let used = 0;
  const model: RunModel = {
    async step() {
      const next = steps[used++];
      if (!next) throw new Error("script exhausted");
      return { text: null, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...next };
    },
  };
  return model;
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
  const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Fix the login" });
  await work.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
  const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
  return { workspace, member, agent, work, item, run: run! };
}

test.concurrent("a confirmed change by a Run is logged as the Agent, with the Run and the Originator", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: scriptedModel([{ toolCalls: [{ id: "w1", name: "update_work_item", input: { workItemId: s.item.id, title: "Fix the login page" } }] }]) });
    const [card] = await transaction.select().from(confirmations).where(eq(confirmations.runId, s.run.id));
    await createConfirmationStore(transaction).confirm(s.member.id, card!.id);

    const log = await s.work.listWorkItemActivities.handler({ userId: s.member.id }, { workItemId: s.item.id });
    const change = log.find((row) => row.field === "title");
    expect(change).toMatchObject({
      actorId: s.agent.userId, actorName: "Bot", source: "agent", runId: s.run.id, originatorId: s.member.id, originatorName: s.member.name, chatId: null,
    });
  });
});

test.concurrent("the Agent's reply comment shows an Agent marker and links to the Run; its activity names the Run", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: scriptedModel([{ text: "All good." }]) });
    const timeline = await createTimelineActions(transaction).listTimeline.handler({ userId: s.member.id }, { workItemId: s.item.id });
    const reply = timeline.find((entry) => entry.comment)!.comment!;
    expect(reply).toMatchObject({ authorId: s.agent.userId, authorIsAgent: true, runId: s.run.id });
    const added = (await s.work.listWorkItemActivities.handler({ userId: s.member.id }, { workItemId: s.item.id })).find((row) => row.field === "comment_added")!;
    expect(added).toMatchObject({ actorId: s.agent.userId, source: "agent", runId: s.run.id, originatorId: s.member.id });
  });
});

test.concurrent("people's comments and existing ui and ai activity entries are unchanged", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const comments = createCommentActions(transaction);
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] };
    const comment = await comments.createComment.handler({ userId: s.member.id }, { workItemId: s.item.id, body });
    expect(comment).toMatchObject({ authorIsAgent: false, runId: null });
    await s.work.updateWorkItem.handler({ userId: s.member.id, source: "ai", chatId: crypto.randomUUID() }, { workItemId: s.item.id, priority: "high" }).catch(() => undefined);
    await s.work.updateWorkItem.handler({ userId: s.member.id }, { workItemId: s.item.id, title: "By hand" });
    const log = await s.work.listWorkItemActivities.handler({ userId: s.member.id }, { workItemId: s.item.id });
    expect(log.find((row) => row.field === "title")).toMatchObject({ actorId: s.member.id, source: "ui", runId: null, originatorId: null, originatorName: null });
    expect(log.find((row) => row.field === "comment_added")).toMatchObject({ source: "ui", runId: null });
  });
});
