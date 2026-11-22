// Real Runtime acceptance of the Wake chain (agent-wake-chain ticket 09). NOT part of `bun run test:isolated`: it drives a real agent CLI
// (`claude` or `codex`, found by `weft daemon probe`) through a local Weft server and a local Daemon, and costs model tokens.
//
// Usage: bun scripts/real-runtime-acceptance.ts [--cli claude|codex] [--model <cli model>] [--only 1,2,3,4,5,6] [--out <dir>]
//   CHROMIUM_PATH=<chrome> for the screenshots. Everything (database, config, session folders, screenshots, log) lives under --out
//   (default /tmp/weft-acceptance-09). The script prints one line per check and writes `log.md` with what was observed.
//
// Scenarios: (1) coder/reviewer ping-pong until the chain stops at depth 6; (2) a comment written during a Run becomes a Follow-up Run;
// (3) round two resumes the Session in the same folder, a failed Run is followed by a new Session; (4) the coder splits work and is woken
// when the sub-items close; (5) with the switch off nothing wakes; (6) a real Codex Run receives an owner-configured non-secret
// marker and reports only whether the marker variable was present. Folder cleanup after a close is observed on disk.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { SQL } from "bun";
import { chromium, type Page } from "playwright";
import { activities, createDatabase, notifications, runMessages, runs, workItems } from "../packages/db/src";
import { createJobHandlers, runNextJob } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const args = Bun.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const cliKind = (option("cli") ?? "claude") as "claude" | "codex";
const cliModel = option("model") ?? (cliKind === "claude" ? "haiku" : null);
const only = new Set((option("only") ?? "1,2,3,4,5").split(","));
const out = option("out") ?? "/tmp/weft-acceptance-09";
const shots = join(out, "shots");
const apiPort = Number(Bun.env.E2E_API_PORT ?? 31209);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52209);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const repo = join(import.meta.dir, "..");
const sessionsRoot = join(out, "cache", "weft", "sessions");

/** The items whose folders the cleanup step watches. */
const scenarioItems: { ping?: { item: { id: string; displayId: string }; folders: string[] }; followUp?: { item: { id: string; displayId: string }; folders: string[] } } = {};
const observations: string[] = [];
let failures = 0;
const note = (line: string) => { console.log(line); observations.push(line); };
const check = (ok: boolean, label: string) => { note(`${ok ? "PASS" : "FAIL"}: ${label}`); if (!ok) failures += 1; };
const sleep = (ms: number) => Bun.sleep(ms);
/** The shared Postgres server has 100 connections for every run on the machine; a busy moment answers `too many clients`, which is worth a retry. */
async function retrying<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await read(); } catch (error) { if (attempt >= 8) throw error; await sleep(2_000); }
  }
}
async function until<T>(label: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 240_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(1_000);
  }
}

await mkdir(shots, { recursive: true });
await mkdir(join(out, "config", "weft"), { recursive: true, mode: 0o700 });
await mkdir(join(out, "bin"), { recursive: true });
// The Run's shell finds `weft` here: it must be THIS worktree's CLI, not the main checkout's.
await writeFile(join(out, "bin", "weft"), `#!/bin/sh\nexec bun ${repo}/apps/cli/src/index.ts "$@"\n`);
await chmod(join(out, "bin", "weft"), 0o755);

const base = new URL(Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft");
const dbName = `weft_accept_${randomBytes(3).toString("hex")}`;
const target = new URL(base);
target.pathname = `/${dbName}`;
const admin = new SQL(base.toString());
await admin.unsafe(`create database ${dbName}`);
const env = { ...Bun.env, DATABASE_URL: target.toString(), ALLOW_SIGNUP: "true", ALLOW_WORKSPACE_CREATION: "true", PASSWORD_BREACH_CHECK: "off", SMTP_HOST: "" };
const migrate = Bun.spawnSync(["bun", "run", "db:migrate"], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
if (migrate.exitCode !== 0) { await admin.unsafe(`drop database if exists ${dbName} with (force)`); throw new Error(migrate.stdout.toString() + migrate.stderr.toString()); }
note(`database ${dbName}; out ${out}`);
Bun.env.DATABASE_URL = target.toString();

const children: Array<ReturnType<typeof Bun.spawn>> = [];
let stopWorker = false;
let workerLoop: Promise<void> | undefined;
const { client, db } = createDatabase();

async function waitFor(url: string) {
  await until(url, async () => { try { return (await fetch(url)).status < 500; } catch { return false; } }, 60_000);
}

let browserClose: (() => Promise<void>) | undefined;
try {
  children.push(Bun.spawn(["bun", "apps/api/src/index.ts"], { cwd: repo, env: { ...env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: Bun.file(join(out, "api.log")), stderr: Bun.file(join(out, "api.log")) }));
  children.push(Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: join(repo, "apps/web"), env: { ...env, VITE_API_URL: api }, stdout: "ignore", stderr: Bun.file(join(out, "web.log")) }));
  // Only notices and Triggers need the job worker; the Runs themselves are run by the Daemon.
  const handlers = createJobHandlers();
  workerLoop = (async () => { while (!stopWorker) { const result = await runNextJob(db, handlers); if (result.status === "idle") await sleep(300); } })();
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);

  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  browserClose = () => browser.close();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `accept-${randomBytes(3).toString("hex")}`;
  const call = async <T>(name: string, body: unknown): Promise<T> => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name}: ${response.status()} ${await response.text()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Accept Person");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Acceptance team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  // A Runtime Run is dispatched only in a workspace that allows Autopilot.
  await call("set_autopilot_setting", { workspaceId, allowAutopilot: true });

  // A Personal API token for the Daemon, then a real Daemon with its own config folder and cache (so the session folders are easy to see).
  const token = await call<{ token: string }>("create_api_token", { name: "acceptance daemon" });
  await writeFile(join(out, "config", "weft", "config.json"), `${JSON.stringify({ token: token.token, apiUrl: api }, null, 2)}\n`, { mode: 0o600 });
  const daemonEnv = { ...Bun.env, XDG_CONFIG_HOME: join(out, "config"), XDG_CACHE_HOME: join(out, "cache"), WEFT_HOSTNAME: `accept-${slug}`, WEFT_API_URL: api, PATH: `${join(out, "bin")}:${Bun.env.PATH}` };
  children.push(Bun.spawn(["bun", "apps/cli/src/index.ts", "daemon", "start", "--foreground"], { cwd: repo, env: daemonEnv, stdout: Bun.file(join(out, "daemon.log")), stderr: Bun.file(join(out, "daemon.log")) }));
  const runtime = await until(`a ready ${cliKind} Runtime`, async () => {
    const list = await call<Array<{ id: string; agentCli?: string; cli?: string }>>("list_runtimes", { workspaceId });
    return list.find((item) => (item.agentCli ?? item.cli) === cliKind);
  }, 60_000);
  await call("share_runtime", { runtimeId: runtime.id });
  note(`Runtime ${runtime.id} (${cliKind}${cliModel ? `, model ${cliModel}` : ""}) is registered and shared`);

  const newAgent = async (name: string, instructions: string) => {
    const agent = await call<{ id: string; userId: string }>("create_agent", { workspaceId, name, instructions, model: "default", runtimeId: runtime.id, cliModel, canWakeAgents: true, timeoutSeconds: 600 });
    await call("set_agent_project_access", { agentId: agent.id, allProjects: true, projectIds: [] });
    await call("set_agent_access", { agentId: agent.id, userIds: [me.user.id] });
    return agent;
  };
  const coder = await newAgent("Coder Bot", "placeholder");
  const reviewer = await newAgent("Review Bot", "placeholder");
  const instruct = (agent: { id: string }, instructions: string) => call("update_agent", { agentId: agent.id, instructions });
  const trigger = await call<{ id: string }>("create_trigger", { agentId: coder.id, projectId: project.id, eventType: "sub_items_closed" });
  note(`Agents: Coder Bot and Review Bot bound to the Runtime with Can wake Agents on; Trigger "sub-items closed" on the coder (${trigger.id})`);

  const weftHint = "Use only the `weft` command in your shell (WEFT_API_URL and WEFT_TOKEN are already set; the work item id is in $WEFT_WORK_ITEM_ID). Do exactly these steps, nothing else, then stop.";
  const assignTo = (agent: { userId: string }) => `weft update-work-item --work-item-id "$WEFT_WORK_ITEM_ID" --assignee-ids '["${agent.userId}"]'`;

  const newItem = async (title: string) => {
    const created = await call<{ id: string }>("create_work_item", { projectId: project.id, title });
    const [row] = await retrying(() => db.select({ sequence: workItems.sequence }).from(workItems).where(eq(workItems.id, created.id)));
    return { id: created.id, displayId: `MOB-${row!.sequence}` };
  };
  const runsOf = (workItemId: string) => retrying(() => db.select().from(runs).where(eq(runs.workItemId, workItemId)).orderBy(asc(runs.createdAt), asc(runs.depth)));
  const active = new Set(["queued", "dispatched", "running", "stopping", "awaiting_confirmation", "waiting_for_confirmation"]);
  const settled = async (workItemId: string, expectedRuns?: number) => until("every Run of the work item has settled", async () => {
    const rows = await runsOf(workItemId);
    return rows.length > 0 && (expectedRuns === undefined || rows.length >= expectedRuns) && rows.every((row) => !active.has(row.status) && row.status !== "follow_up") ? rows : null;
  }, 600_000);
  const agentName = (id: string | null) => id === coder.id ? "coder" : id === reviewer.id ? "reviewer" : "?";
  const describe = (rows: Array<typeof runs.$inferSelect>) => rows.map((row, index) => `#${index + 1} ${agentName(row.agentId)} depth ${row.depth} ${row.status}${row.failureReason ? `(${row.failureReason})` : ""} session=${row.sessionMode ?? "-"}/${row.sessionReason ?? "-"} attempt=${row.attempt}${row.rerunOfId ? " retry" : ""}`).join("; ");

  /**
   * Screenshots of the Runs panel and the timeline, and of the Run page (the Runs panel with the Run's transcript open), at desktop and
   * phone width. The page is tall so the whole panel or timeline is in the frame; each shot is scrolled to the part it is named after.
   */
  const capture = async (label: string, item: { displayId: string }, runId?: string) => {
    for (const [width, height] of [[1440, 2400], [390, 3200]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`${web}/${slug}/browse/${item.displayId}`);
      await page.getByTestId("runs-panel").first().waitFor({ timeout: 30_000 }).catch(() => {});
      await sleep(1_000);
      await page.getByRole("heading", { name: "Timeline" }).first().scrollIntoViewIfNeeded().catch(() => {});
      await Bun.write(join(shots, `${label}-timeline-${width}.png`), await page.screenshot());
      note(`  sideways scroll at ${width}px on ${label} timeline: ${await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)}`);
      if (runId) {
        await page.goto(`${web}/${slug}/browse/${item.displayId}?run=${runId}`);
        await sleep(1_500);
        await page.getByTestId("runs-panel").first().scrollIntoViewIfNeeded().catch(() => {});
        await Bun.write(join(shots, `${label}-run-${width}.png`), await page.screenshot());
        note(`  sideways scroll at ${width}px on ${label} Run page: ${await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  const activitiesOf = async (workItemId: string) => (await retrying(() => db.select().from(activities).where(and(eq(activities.entityId, workItemId), eq(activities.entityType, "work_item"))).orderBy(asc(activities.seq))));

  // ---- 6. A real Codex Run sees an owner-configured non-secret marker without echoing its value ----
  if (only.has("6")) {
    if (cliKind !== "codex") throw new Error("Scenario 6 must use --cli codex");
    note("\n## Scenario 6: Runtime-owner environment marker reaches a real Codex Run");
    const environmentName = `FOLLOWUP_MARKER_${randomBytes(4).toString("hex").toUpperCase()}`;
    const markerValue = randomBytes(24).toString("hex");
    if (Bun.env[environmentName] !== undefined) throw new Error("Generated marker name unexpectedly exists in the Daemon environment");
    await call("set_agent_runtime_environment", { agentId: coder.id, variables: { [environmentName]: markerValue } });
    await instruct(coder, `${weftHint}\nCheck whether environment variable ${environmentName} is non-empty. Run exactly this shell check: if [ -n "\${${environmentName}:-}" ]; then printf 'MARKER_PRESENT=true\\n'; else printf 'MARKER_PRESENT=false\\n'; fi. Do not print, copy, or describe its value. Then reply with exactly the boolean result from the command.`);
    const item = await newItem("Verify configured environment reaches Codex");
    await call("update_work_item", { workItemId: item.id, assigneeIds: [coder.userId] });
    const rows = await settled(item.id, 1);
    const row = rows[0]!;
    const transcript = (await retrying(() => db.select({ output: runMessages.output }).from(runMessages).where(eq(runMessages.runId, row.id)))).map((message) => JSON.stringify(message.output ?? "")).join("\n");
    const passed = row.status === "completed" && /MARKER_PRESENT=true/i.test(transcript);
    check(passed, "the real Codex Run reported MARKER_PRESENT=true");
    check(!transcript.includes(markerValue), "the marker value does not appear in the saved Run transcript");
    note(`Codex Run ${row.id}: ${row.status}; marker presence=${passed ? "true" : "false"}; marker value omitted`);
  }

  // ---- 1. Ping-pong to the depth limit ----
  if (only.has("1")) {
    note("\n## Scenario 1: coder and reviewer ping-pong, stopped at depth 6");
    await instruct(coder, `${weftHint}\n1. Append one line "coder round" to the file notes.md in your current folder.\n2. Run: ${assignTo(reviewer)}`);
    await instruct(reviewer, `${weftHint}\n1. Run: weft create-comment --work-item-id "$WEFT_WORK_ITEM_ID" --body-markdown "Please revise."\n2. Run: ${assignTo(coder)}`);
    const item = await newItem("Ping-pong login page");
    await call("update_work_item", { workItemId: item.id, assigneeIds: [coder.userId] });
    const rows = await settled(item.id, 7);
    note(`Runs: ${describe(rows)}`);
    check(rows.length === 7 && Math.max(...rows.map((row) => row.depth)) === 6, "the chain made 7 Runs and stopped at depth 6");
    check(rows.every((row) => row.originatorId === me.user.id), "every Run in the chain has the person as Originator");
    const skipped = (await activitiesOf(item.id)).filter((entry) => JSON.stringify(entry.newValue ?? "").includes("depth"));
    check(skipped.length > 0, "the timeline holds an Activity that says the wake stopped at the depth limit");
    // The notice is a queued job: the in-process worker delivers it a moment after the Run settles.
    const notified = await until("the Originator's notification", async () => { const found = await retrying(() => db.select().from(notifications).where(and(eq(notifications.userId, me.user.id), eq(notifications.workItemId, item.id)))); return found.length ? found : null; }, 60_000).catch(() => []);
    note(`Originator notifications: ${notified.map((row) => `${row.kind}${row.detail ? `:${row.detail}` : ""}`).join(", ") || "none"}`);
    check(notified.length > 0, "the Originator was notified of the skipped wake");
    const folders = new Set(rows.map((row) => row.sessionFolder).filter(Boolean));
    check(folders.size === 2, "coder and reviewer each kept one stable folder across the chain");
    const coderFolder = rows.find((row) => row.agentId === coder.id)!.sessionFolder!;
    const notes = existsSync(join(sessionsRoot, coderFolder, "notes.md")) ? readFileSync(join(sessionsRoot, coderFolder, "notes.md"), "utf8") : "";
    note(`coder notes.md in ${coderFolder}: ${notes.trim().split("\n").length} line(s)`);
    check(notes.trim().split("\n").length >= 3, "the coder's file kept all its rounds in the same folder");
    check(rows.slice(1).every((row) => row.wokenByRunId !== null), "every woken Run links to the Run that woke it");
    check(rows.filter((row) => row.agentId === coder.id).slice(1).every((row) => row.sessionMode === "resumed"), "the coder's later Runs resumed its Session");
    await capture("s1-chain", item, rows[6]!.id);
    scenarioItems.ping = { item, folders: [...folders] as string[] };
  }

  // ---- 2 and 3. Follow-up Run, resume in the same folder, a failed Run then a new Session ----
  if (only.has("2") || only.has("3")) {
    note("\n## Scenario 2 and 3: Follow-up Run from a comment during a Run; resume; failure then a new Session");
    await instruct(coder, `${weftHint}\n1. If the file marker.txt does not exist in your current folder, run \`sleep 40\`, then create marker.txt. If it exists, do not sleep.\n2. Run: weft create-comment --work-item-id "$WEFT_WORK_ITEM_ID" --body-markdown "Coder pass done. Request seen: <the first 60 characters of the request you were given>"`);
    const item = await newItem("Follow-up and resume");
    await call("update_work_item", { workItemId: item.id, assigneeIds: [coder.userId] });
    const first = await until("the first Run is running", async () => (await runsOf(item.id)).find((row) => row.status === "running"));
    await call("create_comment", { workItemId: item.id, bodyMarkdown: "@{Coder Bot} please also keep the changelog tidy (comment written during the Run)" });
    const waiting = await until("a Follow-up Run is waiting", async () => (await runsOf(item.id)).find((row) => row.status === "follow_up"), 60_000);
    check(waiting.depth === first.depth, "the Follow-up Run has the depth of the Run that asked for it");
    const waitingActivity = (await activitiesOf(item.id)).some((entry) => JSON.stringify(entry).includes("waiting"));
    check(waitingActivity, "the timeline says the request is waiting, not skipped");
    await capture("s2-waiting", item, waiting.id);
    const rows = await settled(item.id, 2);
    note(`Runs: ${describe(rows)}`);
    check(rows.length === 2 && rows.every((row) => row.status === "completed"), "the Follow-up Run started when the first Run ended and both completed");
    const second = rows[1]!;
    check(second.sessionMode === "resumed" && second.sessionFolder === rows[0]!.sessionFolder, "round two resumed the Session in the same folder");
    const transcript = await call<{ messages?: Array<{ content?: unknown }> } | Array<{ content?: unknown }>>("get_run_transcript", { runId: second.id }).catch(() => null);
    check(JSON.stringify(transcript ?? "").includes("changelog"), "the Follow-up Run carried the comment written during the first Run");
    await capture("s3-resumed", item, second.id);

    // A failed Run: the Agent's timeout is cut to 20 s while the coder sleeps for 5 minutes.
    await instruct(coder, `${weftHint}\n1. Run \`sleep 300\`.`);
    await call("update_agent", { agentId: coder.id, timeoutSeconds: 20 });
    await call("create_comment", { workItemId: item.id, bodyMarkdown: "@{Coder Bot} start a long job" });
    const failing = await settled(item.id, 3);
    const failedRun = failing[2]!;
    check(failedRun.status === "failed", `a Run that exceeds its timeout fails (${failedRun.status}/${failedRun.failureReason ?? "-"})`);
    await call("update_agent", { agentId: coder.id, timeoutSeconds: 600 });
    await instruct(coder, `${weftHint}\n1. Run: weft create-comment --work-item-id "$WEFT_WORK_ITEM_ID" --body-markdown "Recovered after the failed Run."`);
    await call("create_comment", { workItemId: item.id, bodyMarkdown: "@{Coder Bot} try again" });
    const after = await settled(item.id, 4);
    // The Run created right after the failed one: Weft's automatic retry or the person's comment, whichever came first.
    const recovered = after[after.findIndex((row) => row.id === failedRun.id) + 1]!;
    note(`Runs: ${describe(after)}`);
    check(recovered.sessionMode === "new", `the Run after the failed Run started a new Session (${recovered.sessionMode}/${recovered.sessionReason})`);
    await capture("s3-new-session", item, recovered.id);
    scenarioItems.followUp = { item, folders: [rows[0]!.sessionFolder as string] };
  }

  // ---- 4. Split and sub-items closed ----
  if (only.has("4")) {
    note("\n## Scenario 4: the coder splits work, the sub-items close, the coder is woken");
    await instruct(coder, `${weftHint}\n1. If the request says the sub-items are closed: run \`weft create-comment --work-item-id "$WEFT_WORK_ITEM_ID" --body-markdown "Summary: all sub-items are closed."\` and stop.\n2. Otherwise create two sub-items of this work item with \`weft create-work-item --project-id ${project.id} --parent-id "$WEFT_WORK_ITEM_ID" --title "<title>"\` named "Part A" and "Part B", then stop.`);
    const item = await newItem("Split me");
    await call("update_work_item", { workItemId: item.id, assigneeIds: [coder.userId] });
    const children = await until("two sub-items exist", async () => { const found = await retrying(() => db.select().from(workItems).where(eq(workItems.parentId, item.id))); return found.length >= 2 ? found : null; });
    await settled(item.id, 1);
    const states = await call<Array<{ id: string; group?: string; stateGroup?: string }>>("list_states", { projectId: project.id });
    const done = states.find((state) => (state.group ?? state.stateGroup) === "completed")!;
    for (const child of children) await call("update_work_item", { workItemId: child.id, stateId: done.id });
    const rows = await settled(item.id, 2);
    note(`Runs: ${describe(rows)}`);
    const woken = rows.find((row) => row.triggerId === trigger.id);
    check(Boolean(woken) && woken!.agentId === coder.id, "closing the last sub-item woke the coder through the sub-items closed Trigger");
    check(Boolean(woken) && woken!.originatorId === me.user.id, "the person who closed the sub-items is the Originator");
    await capture("s4-sub-items", item, woken?.id);
  }

  // ---- 5. Switch off ----
  if (only.has("5")) {
    note("\n## Scenario 5: with Can wake Agents off, nothing wakes");
    await call("update_agent", { agentId: coder.id, canWakeAgents: false });
    await instruct(coder, `${weftHint}\n1. Run: ${assignTo(reviewer)}`);
    const item = await newItem("Switch off");
    await call("update_work_item", { workItemId: item.id, assigneeIds: [coder.userId] });
    const rows = await settled(item.id, 1);
    await sleep(8_000);
    const all = await runsOf(item.id);
    note(`Runs: ${describe(all)}`);
    check(all.length === 1 && all[0]!.agentId === coder.id, "only the coder's Run exists; the reviewer was not started");
    const skip = (await activitiesOf(item.id)).some((entry) => JSON.stringify(entry).includes("switch_off") || JSON.stringify(entry).toLowerCase().includes("can wake"));
    check(skip, "the skip with its reason is on the timeline");
    await capture("s5-switch-off", item, rows[0]!.id);
    await call("update_agent", { agentId: coder.id, canWakeAgents: true });
  }

  // ---- Folder cleanup: close the finished work items, run one more Run, and see their folders go ----
  if (scenarioItems.ping || scenarioItems.followUp) {
    note("\n## Folder cleanup after the work item is closed");
    const states = await call<Array<{ id: string; group?: string; stateGroup?: string }>>("list_states", { projectId: project.id });
    const done = states.find((state) => (state.group ?? state.stateGroup) === "completed")!;
    const closed = [scenarioItems.ping, scenarioItems.followUp].filter(Boolean) as Array<{ item: { id: string; displayId: string }; folders: string[] }>;
    const before = readdirSync(sessionsRoot);
    note(`session folders before closing: ${before.length}`);
    for (const entry of closed) await call("update_work_item", { workItemId: entry.item.id, stateId: done.id });
    await instruct(coder, `${weftHint}\n1. Run: weft create-comment --work-item-id "$WEFT_WORK_ITEM_ID" --body-markdown "Sweep trigger Run."`);
    const sweeper = await newItem("Sweep trigger");
    await call("update_work_item", { workItemId: sweeper.id, assigneeIds: [coder.userId] });
    await settled(sweeper.id, 1);
    await until("the closed items' folders are removed", async () => closed.flatMap((entry) => entry.folders).every((folder) => !existsSync(join(sessionsRoot, folder))), 60_000).catch(() => null);
    const gone = closed.flatMap((entry) => entry.folders).filter((folder) => !existsSync(join(sessionsRoot, folder)));
    note(`session folders after: ${readdirSync(sessionsRoot).length}; removed: ${gone.length} of ${closed.flatMap((entry) => entry.folders).length}`);
    check(gone.length === closed.flatMap((entry) => entry.folders).length, "the folders of the closed work items were removed from disk");
  }
} catch (error) {
  failures += 1;
  note(`ERROR: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  stopWorker = true;
  await writeFile(join(out, "log.md"), `${observations.join("\n")}\n`);
  await browserClose?.().catch(() => {});
  for (const child of children) child.kill();
  await workerLoop?.catch(() => {});
  await client.end?.().catch(() => {});
  if (!args.includes("--keep")) await admin.unsafe(`drop database if exists ${dbName} with (force)`).catch(() => {});
  await admin.close();
}
console.log(failures ? `\nacceptance FAILED (${failures})` : "\nacceptance ok");
process.exit(failures ? 1 : 0);
