import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { agentSkills, confirmations, createDatabase, jobs, notifications, runMessages, runs, skills, type Database } from "@weft/db";
import {
  createAgentActions, createCommentActions, createConfirmationStore, createJobHandlers, createProjectActions, createWorkItemActions, handleAgentRunJob,
  type RunModel, type RunModelRequest, type RunModelResponse,
} from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

type Step = Partial<RunModelResponse>;
function scriptedModel(steps: Step[]) {
  const requests: RunModelRequest[] = [];
  const model: RunModel = {
    async step(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
      const next = steps[requests.length - 1];
      if (!next) throw new Error("script exhausted");
      return { text: null, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...next };
    },
  };
  return { model, requests };
}
const call = (name: string, input: unknown, id: string = crypto.randomUUID()) => ({ id, name, input });

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const agentActions = createAgentActions(transaction);
  const agent = await agentActions.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", instructions: "Be brief.", model: "default" });
  await agentActions.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const work = createWorkItemActions(transaction);
  const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Fix the login" });
  await work.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
  const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
  return { workspace, admin, member, project, agent, work, item, run: run!, store: createConfirmationStore(transaction) };
}

const transcript = (transaction: Database, runId: string) => transaction.select().from(runMessages).where(eq(runMessages.runId, runId)).orderBy(runMessages.seq);
const reload = async (transaction: Database, runId: string) => (await transaction.select().from(runs).where(eq(runs.id, runId)))[0]!;
const title = async (s: Awaited<ReturnType<typeof setup>>) => (await s.work.getWorkItem.handler({ userId: s.member.id }, { workspaceId: s.workspace.id, displayId: "ALP-1" })).title;
const rename = (id: string, to = "Fix the login page") => call("update_work_item", { workItemId: id, title: to }, "w1");

/** Runs the script until the Run pauses on its first Write proposal, and returns the pending Confirmation. */
async function pauseOnWrite(transaction: Database, s: Awaited<ReturnType<typeof setup>>, steps: Step[] = []) {
  const first = scriptedModel([{ text: "I will rename it.", toolCalls: [rename(s.item.id)] }, ...steps]);
  await handleAgentRunJob(transaction, { runId: s.run.id }, { model: first.model });
  const [confirmation] = await transaction.select().from(confirmations).where(eq(confirmations.runId, s.run.id));
  return { ...first, confirmation: confirmation! };
}

test.concurrent("a proposed Write creates a Confirmation for the Originator and the Run waits, changing nothing", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { confirmation, requests } = await pauseOnWrite(transaction, s);
    expect(requests).toHaveLength(1);
    expect(confirmation).toMatchObject({ userId: s.member.id, action: "update_work_item", status: "pending", chatId: null, workspaceId: s.workspace.id });
    expect(confirmation.input).toMatchObject({ workItemId: s.item.id, title: "Fix the login page" });
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "waiting_confirmation", finishedAt: null });
    expect(await title(s)).toBe("Fix the login");

    const steps = await transcript(transaction, s.run.id);
    expect(steps.map((m) => m.type)).toEqual(["thought", "action", "confirmation"]);
    expect(steps[2]).toMatchObject({ toolCallId: "w1", toolName: "update_work_item", output: { confirmationId: confirmation.id } });

    // The Originator is told, and an expiry check is queued for when the Confirmation lapses.
    const queued = await transaction.select().from(jobs);
    const notify = queued.find((job) => job.type === "notify" && (job.payload as { kind: string }).kind === "run_confirmation");
    expect(notify?.payload).toMatchObject({ kind: "run_confirmation", workItemId: s.item.id, actorId: s.agent.userId, recipientIds: [s.member.id] });
    const expiry = queued.find((job) => job.type === "agent_run_expire");
    expect(expiry?.payload).toMatchObject({ runId: s.run.id, confirmationId: confirmation.id });
    expect(expiry!.runAt.getTime()).toBe(confirmation.expiresAt.getTime());
  });
});

test.concurrent("a loaded Skill stays in the Run transcript when it resumes after Confirmation", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const [skill] = await transaction.insert(skills).values({ workspaceId: s.workspace.id, scope: "workspace", name: "review", description: "Review changes", instructions: "Original review procedure." }).returning();
    await transaction.insert(agentSkills).values({ agentId: s.agent.id, skillId: skill!.id });
    const first = scriptedModel([
      { toolCalls: [call("get_skill", { skillId: skill!.id }, "s1")] },
      { toolCalls: [rename(s.item.id)] },
    ]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: first.model });
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "waiting_confirmation" });
    await transaction.update(skills).set({ instructions: "Edited review procedure." }).where(eq(skills.id, skill!.id));
    const loaded = (await transcript(transaction, s.run.id)).find((row) => row.type === "tool_result" && row.toolCallId === "s1")!;
    expect(loaded.output).toContain("Original review procedure.");
    expect(loaded.output).not.toContain("Edited review procedure.");

    const [confirmation] = await transaction.select().from(confirmations).where(eq(confirmations.runId, s.run.id));
    await s.store.confirm(s.member.id, confirmation!.id);
    const resumed = scriptedModel([{ text: "Done." }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: resumed.model });
    expect(JSON.stringify(resumed.requests[0]!.messages)).toContain("Original review procedure.");
    expect(JSON.stringify(resumed.requests[0]!.messages)).not.toContain("Edited review procedure.");
  });
});

test.concurrent("the notification fan-out delivers the confirmation request to the Originator", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await pauseOnWrite(transaction, s);
    const [notify] = (await transaction.select().from(jobs)).filter((job) => job.type === "notify" && (job.payload as { kind: string }).kind === "run_confirmation");
    await createJobHandlers(async () => {}).notify!(transaction, notify!.payload, { id: notify!.id, type: "notify" });
    const rows = await transaction.select().from(notifications).where(eq(notifications.userId, s.member.id));
    expect(rows.map((row) => row.kind)).toContain("run_confirmation");
  });
});

test.concurrent("approving runs the action as the Originator and the Run continues to completion, rebuilt from the transcript", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { confirmation } = await pauseOnWrite(transaction, s);
    // The job queue offering the Run again while it waits does nothing.
    const idle = scriptedModel([]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: idle.model });
    expect(idle.requests).toHaveLength(0);

    expect(await s.store.confirm(s.member.id, confirmation.id)).toMatchObject({ status: "confirmed" });
    expect(await title(s)).toBe("Fix the login page");
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "queued" });
    const resumeJobs = (await transaction.select().from(jobs).where(eq(jobs.type, "agent_run"))).filter((job) => (job.payload as { runId: string }).runId === s.run.id);
    expect(resumeJobs.some((job) => job.status === "pending")).toBe(true);

    // A worker that restarted holds nothing: a fresh model sees the whole conversation from stored rows.
    const resumed = scriptedModel([{ text: "Renamed it." }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: resumed.model });
    const messages = resumed.requests[0]!.messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(messages[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "w1", name: "update_work_item" }] });
    expect(messages[2]).toMatchObject({ role: "tool", toolCallId: "w1", name: "update_work_item" });
    expect((messages[2] as { output: string }).output).toMatch(/approved|confirmed/i);

    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "completed", failureReason: null });
    const steps = await transcript(transaction, s.run.id);
    expect(steps.map((m) => m.type)).toEqual(["thought", "action", "confirmation", "tool_result", "response"]);
  });
});

test.concurrent("rejecting tells the model and the Run continues without the change", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { confirmation } = await pauseOnWrite(transaction, s);
    expect((await s.store.reject(s.member.id, confirmation.id)).status).toBe("rejected");
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "queued" });

    const resumed = scriptedModel([{ text: "Understood, left it alone." }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: resumed.model });
    expect((resumed.requests[0]!.messages.at(-1) as { output: string }).output).toMatch(/rejected/i);
    expect(await title(s)).toBe("Fix the login");
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "completed" });
  });
});

test.concurrent("a Confirmation answered by someone else is refused and the Run keeps waiting", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { confirmation } = await pauseOnWrite(transaction, s);
    await expect(s.store.confirm(s.admin.id, confirmation.id)).rejects.toThrow();
    expect((await reload(transaction, s.run.id)).status).toBe("waiting_confirmation");
  });
});

test.concurrent("a Confirmation unanswered after 24 hours fails the Run with a distinct reason and queues no retry", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { confirmation } = await pauseOnWrite(transaction, s);
    const later = new Date(confirmation.expiresAt.getTime() + 1000);
    const handlers = createJobHandlers(async () => {}, { now: () => later });
    const expiry = (await transaction.select().from(jobs)).find((job) => job.type === "agent_run_expire")!;
    await handlers.agent_run_expire!(transaction, expiry.payload, { id: expiry.id, type: "agent_run_expire" });
    // The woken Run is offered to a worker, which fails it; the model is never called again.
    const never = scriptedModel([]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: never.model });
    expect(never.requests).toHaveLength(0);

    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "failed", failureReason: "confirmation_expired" });
    expect(await title(s)).toBe("Fix the login");
    expect((await transcript(transaction, s.run.id)).at(-1)).toMatchObject({ type: "error", output: "confirmation_expired" });
    expect((await s.store.get(s.member.id, confirmation.id))?.status).toBe("expired");
    // No further wake-up is queued: asking again changes nothing.
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: never.model });
    expect(never.requests).toHaveLength(0);
    expect(await s.store.confirm(s.member.id, confirmation.id)).toMatchObject({ status: "already_resolved" });
    expect((await reload(transaction, s.run.id)).status).toBe("failed");
  });
});

test.concurrent("an expiry check that fires after the Confirmation was answered does nothing", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { confirmation } = await pauseOnWrite(transaction, s);
    await s.store.confirm(s.member.id, confirmation.id);
    const expiry = (await transaction.select().from(jobs)).find((job) => job.type === "agent_run_expire")!;
    const later = new Date(confirmation.expiresAt.getTime() + 1000);
    await createJobHandlers(async () => {}, { now: () => later }).agent_run_expire!(transaction, expiry.payload, { id: expiry.id, type: "agent_run_expire" });
    expect((await reload(transaction, s.run.id)).status).toBe("queued");
  });
});

test.concurrent("the Agent's reply comment needs no Confirmation, and delete_project and delete_workspace are not offered", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { model, requests } = scriptedModel([{ text: "Nothing to change." }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model });
    expect(await transaction.select().from(confirmations).where(eq(confirmations.runId, s.run.id))).toHaveLength(0);
    const comments = await createCommentActions(transaction).listComments.handler({ userId: s.member.id }, { workItemId: s.item.id });
    expect(comments).toMatchObject([{ authorId: s.agent.userId, bodyText: "Nothing to change." }]);
    const names = requests[0]!.tools.map((tool) => tool.name);
    expect(names).toContain("update_work_item");
    expect(names).not.toContain("delete_project");
    expect(names).not.toContain("delete_workspace");
  });
});

test.concurrent("a refused proposal reaches the model as an error and the Run does not wait", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { model, requests } = scriptedModel([
      { toolCalls: [call("delete_project", { projectId: s.project.id }, "d1")] },
      { text: "I cannot do that." },
    ]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model });
    expect((requests[1]!.messages.at(-1) as { output: string }).output).toContain("error");
    expect(await transaction.select().from(confirmations).where(eq(confirmations.runId, s.run.id))).toHaveLength(0);
    expect((await reload(transaction, s.run.id)).status).toBe("completed");
  });
});

test.concurrent("a Write after reads in one step: reads run, the first Write pauses, later calls are dropped", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const model = scriptedModel([{ toolCalls: [call("get_work_item", { displayId: "ALP-1" }, "r1"), rename(s.item.id), call("get_work_item", { displayId: "ALP-1" }, "r2")] }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model: model.model });
    const steps = await transcript(transaction, s.run.id);
    expect(steps.map((m) => m.type)).toEqual(["action", "tool_result", "action", "confirmation"]);
    expect((await reload(transaction, s.run.id)).status).toBe("waiting_confirmation");
  });
});

test.concurrent("get_run_transcript shows display steps to a member and the pending Confirmation only to the Originator; a Guest is refused", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await createMemberFactory(transaction, s.workspace.id, "Member");
    const { createProjectActions: projectActions, createRunActions } = await import("../src");
    await projectActions(transaction).addProjectMember.handler({ userId: s.admin.id }, { projectId: s.project.id, userId: other.id, role: "Member" });
    const { model } = scriptedModel([{ text: "Plan", toolCalls: [call("update_work_item", { workItemId: s.item.id, title: "Fix the login page" }, "w1")] }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model });
    const runActions = createRunActions(transaction);

    const own = await runActions.getRunTranscript.handler({ userId: s.member.id }, { runId: s.run.id });
    expect(own.steps.map((step) => step.kind)).toEqual(["thought", "tool_call"]);
    expect(own.confirmations).toHaveLength(1);
    expect(own.confirmations[0]).toMatchObject({ action: "update_work_item", status: "pending", toolCallId: "w1" });

    const seen = await runActions.getRunTranscript.handler({ userId: other.id }, { runId: s.run.id });
    expect(seen.steps).toHaveLength(2);
    expect(seen.confirmations).toEqual([]);

    const guest = await createMemberFactory(transaction, s.workspace.id, "Guest");
    await expect(runActions.getRunTranscript.handler({ userId: guest.id }, { runId: s.run.id })).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(runActions.getRunTranscript.handler({ userId: s.member.id }, { runId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("another member sees only tool names in a transcript: inputs and results stay with the Originator and Admins", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await createMemberFactory(transaction, s.workspace.id, "Member");
    const { createRunActions } = await import("../src");
    await createProjectActions(transaction).addProjectMember.handler({ userId: s.admin.id }, { projectId: s.project.id, userId: other.id, role: "Member" });
    const { model } = scriptedModel([{ text: "Reading", toolCalls: [call("get_work_item", { displayId: "ALP-1" }, "r1")] }, { text: "Done" }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model });
    const runActions = createRunActions(transaction);
    const toolStep = (steps: Array<{ kind: string }>) => steps.find((step) => step.kind === "tool_call") as unknown as { toolName: string; input: unknown; result: unknown };
    expect(toolStep((await runActions.getRunTranscript.handler({ userId: s.member.id }, { runId: s.run.id })).steps).result).not.toBeNull();
    expect(toolStep((await runActions.getRunTranscript.handler({ userId: s.admin.id }, { runId: s.run.id })).steps).result).not.toBeNull();
    const seen = toolStep((await runActions.getRunTranscript.handler({ userId: other.id }, { runId: s.run.id })).steps);
    expect(seen).toMatchObject({ toolName: "get_work_item", input: null, result: null });
  });
});

test.concurrent("deleting an Agent withdraws the Confirmations of its waiting Runs, which end cancelled", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const { confirmation } = await pauseOnWrite(transaction, s);
    await createAgentActions(transaction).deleteAgent.handler({ userId: s.admin.id }, { agentId: s.agent.id });
    expect(await reload(transaction, s.run.id)).toMatchObject({ status: "cancelled" });
    expect(await s.store.confirm(s.member.id, confirmation.id)).toMatchObject({ status: "already_resolved" });
    expect(await title(s)).toBe("Fix the login");
  });
});

test.concurrent("thoughts are hidden from members who are not the Originator or an Admin", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const other = await createMemberFactory(transaction, s.workspace.id, "Member");
    const { createRunActions } = await import("../src");
    await createProjectActions(transaction).addProjectMember.handler({ userId: s.admin.id }, { projectId: s.project.id, userId: other.id, role: "Member" });
    const { model } = scriptedModel([{ text: "private musings", toolCalls: [call("get_work_item", { displayId: "ALP-1" }, "r1")] }, { text: "Done" }]);
    await handleAgentRunJob(transaction, { runId: s.run.id }, { model });
    const runActions = createRunActions(transaction);
    expect(JSON.stringify((await runActions.getRunTranscript.handler({ userId: s.member.id }, { runId: s.run.id })).steps)).toContain("private musings");
    expect(JSON.stringify((await runActions.getRunTranscript.handler({ userId: other.id }, { runId: s.run.id })).steps)).not.toContain("private musings");
  });
});

test.concurrent("a Run's proposal to create, update, or delete a Skill is refused at the Confirmation layer", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const store = createConfirmationStore(transaction);
    for (const action of ["create_skill", "update_skill", "delete_skill"]) {
      await expect(store.propose({ userId: member.id, workspaceId: workspace.id, runId: crypto.randomUUID(), toolCallId: "c1", action, input: {} })).rejects.toMatchObject({ status: 403 });
    }
  });
});
