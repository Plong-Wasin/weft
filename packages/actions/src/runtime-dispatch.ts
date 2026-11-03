import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, comments, daemons, runMessages, runTokens, runs, runtimes, workItems } from "@weft/db";
import { ActionError } from "./members";
import { createCommentActions } from "./comments";

function replyDocument(reply: string) {
  const paragraphs = reply.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return { type: "doc", content: paragraphs.map((part) => ({ type: "paragraph", content: [{ type: "text", text: part }] })) };
}

const digest = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");

/** HTTP operations used by a Daemon to claim, start, stream and finish Runtime Runs. */
export function createRuntimeDispatchActions(db: Database, now: () => Date = () => new Date()) {
  return {
    claimRuns: async (context: { userId: string; daemonId: string }, requestedLimit = 20) => db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const [daemon] = await tx.select({ id: daemons.id }).from(daemons).where(and(eq(daemons.id, context.daemonId), eq(daemons.ownerId, context.userId)));
      if (!daemon) throw new ActionError("Daemon not found", 404);
      const rows = await tx.select({ run: runs, agent: agents, runtime: runtimes }).from(runs)
        .innerJoin(agents, eq(agents.id, runs.agentId)).innerJoin(runtimes, eq(runtimes.id, agents.runtimeId))
        .where(and(eq(runs.status, "queued"), eq(agents.enabled, true), eq(runtimes.daemonId, daemon.id), eq(runtimes.shared, true), gt(runtimes.lastSeenAt, new Date(now().getTime() - 150_000))))
        .orderBy(asc(runs.createdAt), asc(runs.id)).limit(Math.max(0, Math.min(20, requestedLimit))).for("update", { of: runs, skipLocked: true });
      const claimed = [];
      for (const row of rows) {
        const [{ count: daemonCount }] = await tx.select({ count: sql<number>`count(*)::int` }).from(runs).innerJoin(runtimes, eq(runtimes.id, runs.runtimeId)).where(and(eq(runtimes.daemonId, daemon.id), inArray(runs.status, ["dispatched", "running", "stopping"])));
        const [{ count: agentCount }] = await tx.select({ count: sql<number>`count(*)::int` }).from(runs).where(and(eq(runs.agentId, row.agent.id), inArray(runs.status, ["dispatched", "running", "stopping"])));
        if (daemonCount >= 20 || agentCount >= row.agent.maxConcurrentRuns) continue;
        const [item] = row.run.workItemId ? await tx.select({ title: workItems.title, description: workItems.description }).from(workItems).where(eq(workItems.id, row.run.workItemId)) : [];
        const [requestComment] = row.run.commentId ? await tx.select({ bodyText: comments.bodyText }).from(comments).where(eq(comments.id, row.run.commentId)) : [];
        const token = `weft_run_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
        await tx.insert(runTokens).values({ runId: row.run.id, tokenHash: await digest(token), expiresAt: new Date(now().getTime() + 24 * 60 * 60_000) }).onConflictDoUpdate({ target: runTokens.runId, set: { tokenHash: await digest(token), expiresAt: new Date(now().getTime() + 24 * 60 * 60_000) } });
        await tx.update(runs).set({ status: "dispatched", runtimeId: row.runtime.id, dispatchedAt: now() }).where(and(eq(runs.id, row.run.id), eq(runs.status, "queued")));
        claimed.push({ runId: row.run.id, runtimeId: row.runtime.id, agentCli: row.runtime.agentCli, status: "dispatched", instructions: row.agent.instructions, request: item ? `${item.title}\n${item.description ?? ""}${requestComment ? `\n\nRequest comment:\n${requestComment.bodyText}` : ""}` : "Scheduled Agent Run", model: row.agent.cliModel, token });
      }
      return claimed;
    }),
    startRun: async (runId: string, runtimeId: string) => {
      const [run] = await db.update(runs).set({ status: "running", startedAt: now() }).where(and(eq(runs.id, runId), eq(runs.runtimeId, runtimeId), eq(runs.status, "dispatched"))).returning({ id: runs.id });
      if (!run) throw new ActionError("Run is not dispatched to this Runtime", 409);
    },
    appendMessages: async (runId: string, messages: Array<{ seq: number; type: string; output: unknown }>) => {
      if (!messages.length) return;
      const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
      if (!run || !["dispatched", "running", "stopping"].includes(run.status)) throw new ActionError("Run is not active", 409);
      await db.insert(runMessages).values(messages.map((message) => ({ runId, seq: message.seq, type: message.type, output: message.output }))).onConflictDoNothing();
    },
    finishRun: async (runId: string, outcome: { status: "completed" | "failed"; finalOutput: string; failureReason?: string }) => {
      const [run] = await db.update(runs).set({ status: outcome.status, finalOutput: outcome.finalOutput, failureReason: outcome.failureReason ?? null, finishedAt: now() }).where(and(eq(runs.id, runId), inArray(runs.status, ["running", "dispatched"]))).returning();
      if (!run) throw new ActionError("Run is not active", 409);
      await db.update(runTokens).set({ expiresAt: now() }).where(eq(runTokens.runId, runId));
      if (outcome.finalOutput.trim() && run.agentId && run.workItemId) {
        const [existing] = await db.select({ id: comments.id }).from(comments).where(eq(comments.runId, runId)).limit(1);
        if (!existing) {
          const [agent] = await db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, run.agentId));
          if (agent) await createCommentActions(db).createComment.handler({ userId: agent.userId, source: "agent", agent: { agentUserId: agent.userId, runId, originatorId: run.originatorId, autopilot: true } }, { workItemId: run.workItemId, body: replyDocument(outcome.finalOutput) });
        }
      }
    },
    authenticateRunToken: async (token: string) => {
      const [row] = await db.select({ run: runs, token: runTokens }).from(runTokens).innerJoin(runs, eq(runs.id, runTokens.runId)).where(and(eq(runTokens.tokenHash, await digest(token)), gt(runTokens.expiresAt, now()), inArray(runs.status, ["dispatched", "running", "stopping"])));
      const [agent] = row?.run.agentId ? await db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, row.run.agentId)) : [];
      return row && agent ? { userId: row.run.originatorId, runId: row.run.id, agentUserId: agent.userId } : null;
    },
  };
}
