// Wake chain on a Runtime, through the HTTP API, a real Daemon process loop and fake `claude` CLI processes that use the real `weft` command.
// The same scenarios run against a real agent CLI by hand in `scripts/real-runtime-acceptance.ts`; this suite keeps their rules from regressing.
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, asc, eq } from "drizzle-orm";
import { activities, createDatabase, jobs, runs, type Database } from "@weft/db";
import { createAgentActions, createProjectActions, createRuntimeActions, createWorkItemActions } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { startDaemon } from "../../cli/src/daemon";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const finalStatuses = ["completed", "failed", "cancelled", "skipped"];

/**
 * A fake `claude`. Its role and the Agent it hands work to come from the Agent's instructions (`ROLE=coder NEXT=<user id>`):
 * the coder appends a line to notes.md and assigns the work item to NEXT; the reviewer comments and assigns it to NEXT.
 * It reports the Session id `sess-<role>` and accepts `--resume`, like a CLI that remembers.
 */
const fakeClaude = `#!/bin/sh
prompt="$*"
role=$(printf '%s' "$prompt" | sed -n 's/.*ROLE=\\([a-z]*\\).*/\\1/p' | head -1)
next=$(printf '%s' "$prompt" | sed -n 's/.*NEXT=\\([A-Za-z0-9_-]*\\).*/\\1/p' | head -1)
echo "$role round" >> notes.md
if [ "$role" = reviewer ]; then weft create-comment --work-item-id "$WEFT_WORK_ITEM_ID" --body-markdown "Please revise." >/dev/null; fi
if [ -n "$next" ]; then weft update-work-item --work-item-id "$WEFT_WORK_ITEM_ID" --assignee-ids "[\\"$next\\"]" >/dev/null; fi
echo '{"type":"system","subtype":"init","session_id":"sess-'$role'","model":"fake-model"}'
echo '{"type":"result","result":"done","session_id":"sess-'$role'"}'
`;

async function setup(transaction: Database, options: { coderWakes: boolean }) {
  const app = createApp(undefined, transaction);
  const post = (path: string, body: unknown, cookie?: string, token?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
  const response = await post("/api/auth/sign-up/email", { name: "Person", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
  const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `wc-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
  await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, cookie);
  const token = await (await post("/actions/create_api_token", { name: "daemon" }, cookie)).json() as { token: string };
  const project = await createProjectActions(transaction).createProject.handler({ userId: me.user.id }, { workspaceId: workspace.id, name: "Wake", key: `WK${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });

  const path = await mkdtemp(join(tmpdir(), "weft-wake-path-"));
  const cache = await mkdtemp(join(tmpdir(), "weft-wake-cache-"));
  await writeFile(join(path, "weft"), `#!/bin/sh\nexec bun "${process.cwd()}/apps/cli/src/index.ts" "$@"\n`);
  await chmod(join(path, "weft"), 0o755);
  await writeFile(join(path, "claude"), fakeClaude);
  await chmod(join(path, "claude"), 0o755);
  app.listen(0);
  const controller = new AbortController();
  const registration = await (await post("/actions/register_daemon", { hostname: "wake-chain", version: "1", agentClis: ["claude"] }, undefined, token.token)).json() as { runtimes: Array<{ id: string }> };
  const runtimeId = registration.runtimes[0]!.id;
  await createRuntimeActions(transaction).shareRuntime.handler({ userId: me.user.id }, { runtimeId });

  const agents = createAgentActions(transaction);
  const makeAgent = async (name: string, instructions: string, canWakeAgents: boolean) => {
    const agent = await agents.createAgent.handler({ userId: me.user.id }, { workspaceId: workspace.id, name, instructions, model: "default", runtimeId });
    await agents.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await agents.setAgentAccess.handler({ userId: me.user.id }, { agentId: agent.id, userIds: [me.user.id] });
    if (canWakeAgents) await agents.updateAgent.handler({ userId: me.user.id }, { agentId: agent.id, canWakeAgents: true });
    return agent;
  };
  const reviewerPlaceholder = await makeAgent("Review Bot", "ROLE=reviewer", true);
  const coder = await makeAgent("Coder Bot", `ROLE=coder NEXT=${reviewerPlaceholder.userId}`, options.coderWakes);
  await agents.updateAgent.handler({ userId: me.user.id }, { agentId: reviewerPlaceholder.id, instructions: `ROLE=reviewer NEXT=${coder.userId}` });
  const reviewer = reviewerPlaceholder;

  const work = createWorkItemActions(transaction);
  const sessionsRoot = join(cache, "weft", "sessions");
  const daemon = startDaemon({ env: { WEFT_TOKEN: token.token, XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), "weft-wake-config-")), XDG_CACHE_HOME: cache, WEFT_API_URL: `http://localhost:${app.server!.port}`, PATH: `${path}:${Bun.env.PATH ?? ""}`, WEFT_HOSTNAME: "wake-chain" }, signal: controller.signal, heartbeatMs: 20, reprobeMs: 60_000 });

  /** A work item the person assigns to the coder: the one human step. */
  const assignToCoder = async (title: string) => {
    const item = await work.createWorkItem.handler({ userId: me.user.id }, { projectId: project.id, title });
    await work.updateWorkItem.handler({ userId: me.user.id }, { workItemId: item.id, assigneeIds: [coder.userId] });
    return item;
  };
  const runsOf = (workItemId: string) => transaction.select().from(runs).where(eq(runs.workItemId, workItemId)).orderBy(asc(runs.createdAt), asc(runs.depth));
  const settled = async (workItemId: string, expected: number) => {
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const rows = await runsOf(workItemId);
      if (rows.length >= expected && rows.every((row) => finalStatuses.includes(row.status))) return rows;
      await Bun.sleep(50);
    }
    throw new Error(`Runs did not settle: ${JSON.stringify((await runsOf(workItemId)).map((row) => [row.depth, row.status]))}`);
  };
  const folderPath = (folder: string) => join(sessionsRoot, folder);
  const stop = async () => { controller.abort(); await daemon.catch(() => {}); app.stop(true); await Promise.all([path, cache].map((directory) => rm(directory, { recursive: true, force: true }))); };
  return { post, cookie, me, project, coder, reviewer, work, assignToCoder, runsOf, settled, folderPath, stop, transaction };
}

test.concurrent("a coder and a reviewer on a Runtime hand a work item back and forth until the chain stops at depth 6, and the Originator is told", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, { coderWakes: true });
    try {
      const item = await s.assignToCoder("Ping-pong");
      const rows = await s.settled(item.id, 7);
      // Seven Runs alternate coder and reviewer; the person's assignment is the only thing that started one by hand.
      expect(rows.map((row) => [row.agentId === s.coder.id ? "coder" : "reviewer", row.depth, row.status])).toEqual([
        ["coder", 0, "completed"], ["reviewer", 1, "completed"], ["coder", 2, "completed"], ["reviewer", 3, "completed"],
        ["coder", 4, "completed"], ["reviewer", 5, "completed"], ["coder", 6, "completed"],
      ]);
      expect(rows.every((row) => row.originatorId === s.me.user.id)).toBe(true);
      expect(rows.slice(1).map((row, index) => row.wokenByRunId === rows[index]!.id)).toEqual(Array(6).fill(true));
      // Each Agent kept one folder and resumed its Session from round two.
      expect(new Set(rows.map((row) => row.sessionFolder)).size).toBe(2);
      expect(rows.filter((row) => row.agentId === s.coder.id).map((row) => row.sessionMode)).toEqual(["new", "resumed", "resumed", "resumed"]);
      const coderFolder = rows.find((row) => row.agentId === s.coder.id)!.sessionFolder!;
      expect((await readFile(join(s.folderPath(coderFolder), "notes.md"), "utf8")).trim().split("\n")).toHaveLength(4);
      // The reviewer's three comments are on the work item: the reviewer's change was made as the Agent, in the person's chain.
      const comments = await (await s.post("/actions/list_comments", { workItemId: item.id }, s.cookie)).json() as Array<{ bodyText: string }>;
      expect(comments.filter((comment) => comment.bodyText === "Please revise.")).toHaveLength(3);
      // The seventh hand-off (coder at depth 6 to the reviewer) did not happen: it is on the timeline and the person's notice is queued.
      const skips = await transaction.select().from(activities).where(and(eq(activities.entityId, item.id), eq(activities.field, "wake_skipped")));
      expect(skips).toEqual([expect.objectContaining({ newValue: expect.objectContaining({ reason: "depth_limit", agentId: s.reviewer.id }) })]);
      const notices = (await transaction.select().from(jobs)).filter((job) => job.type === "notify" && (job.payload as { kind?: string }).kind === "wake_skipped");
      expect(notices.map((job) => (job.payload as { recipientIds: string[] }).recipientIds)).toEqual([[s.me.user.id]]);
    } finally { await s.stop(); }
  });
}, 60_000);

test.concurrent("with Can wake Agents off, the coder's hand-off on a Runtime starts no reviewer Run and the skip is on the timeline", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, { coderWakes: false });
    try {
      const item = await s.assignToCoder("Switch off");
      const rows = await s.settled(item.id, 1);
      await Bun.sleep(500);
      expect(await s.runsOf(item.id)).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agentId: s.coder.id, status: "completed", depth: 0 });
      const skips = await transaction.select().from(activities).where(and(eq(activities.entityId, item.id), eq(activities.field, "wake_skipped")));
      expect(skips).toEqual([expect.objectContaining({ newValue: expect.objectContaining({ reason: "switch_off", agentId: s.reviewer.id }) })]);
    } finally { await s.stop(); }
  });
}, 60_000);

test.concurrent("the folder of a closed work item is removed from disk after the next Run, and the folder of an open one stays", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, { coderWakes: false });
    try {
      const first = await s.assignToCoder("Close me");
      const [firstRun] = await s.settled(first.id, 1);
      const folder = firstRun!.sessionFolder!;
      expect((await stat(s.folderPath(folder))).isDirectory()).toBe(true);
      const states = await (await s.post("/actions/list_states", { projectId: s.project.id }, s.cookie)).json() as Array<{ id: string; group: string }>;
      await s.work.updateWorkItem.handler({ userId: s.me.user.id }, { workItemId: first.id, stateId: states.find((state) => state.group === "completed")!.id });
      const second = await s.assignToCoder("Still open");
      const [secondRun] = await s.settled(second.id, 1);
      for (let attempt = 0; attempt < 200 && await stat(s.folderPath(folder)).then(() => true, () => false); attempt += 1) await Bun.sleep(50);
      expect(await stat(s.folderPath(folder)).then(() => true, () => false)).toBe(false);
      expect((await stat(s.folderPath(secondRun!.sessionFolder!))).isDirectory()).toBe(true);
    } finally { await s.stop(); }
  });
}, 60_000);
