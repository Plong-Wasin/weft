// Browser end-to-end flow for an event Trigger that an Agent's change fires. The coder Agent has Can wake Agents on; a state-changed Trigger on the
// reviewer Agent wakes it when the coder moves a work item. Then the chain Originator loses Agent access to the reviewer: the next move is skipped,
// and the work item timeline and the Originator's inbox say why. Screenshots go to TRIGGER_SCREENSHOT_DIR (default /tmp) at 1440 and 390 px.
// No Run calls a model: the coder's Run rows are set up through the actions, as the server records them. Run with `bun e2e/wake-trigger.e2e.ts`.
import { chromium } from "playwright";
import { inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, runs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createJobHandlers, createTriggerActions, createWorkItemActions, runNextJob } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31181);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52181);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.TRIGGER_SCREENSHOT_DIR ?? "/tmp";
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

let failed = false;
let stopWorker = false;
const { client, db } = createDatabase();

// No Run calls a model in this flow; the worker only delivers the notice jobs the wakes queue.
const handlers = createJobHandlers(undefined, { runModel: { async step() { return { text: "unused", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } } });
const worker = (async () => { while (!stopWorker) { const result = await runNextJob(db, handlers); if (result.status === "idle") await Bun.sleep(200); } })();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Trigger Tester");
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
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

  // Two Agents on the server, both open to every project and usable by the Admin. The coder may wake Agents; the reviewer has a state-changed Trigger.
  const agentActions = createAgentActions(db);
  const coder = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Coder Bot", instructions: "Move finished work to Started and hand it on.", model: "default" });
  const reviewer = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Review Bot", instructions: "Review the work.", model: "default" });
  for (const agent of [coder, reviewer]) {
    await agentActions.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await agentActions.setAgentAccess.handler({ userId: me.user.id }, { agentId: agent.id, userIds: [me.user.id] });
  }
  await agentActions.updateAgent.handler({ userId: me.user.id }, { agentId: coder.id, canWakeAgents: true });
  await createTriggerActions(db).createTrigger.handler({ userId: me.user.id }, { agentId: reviewer.id, projectId: project.id, eventType: "state_changed" });
  const work = createWorkItemActions(db);
  const states = await work.listStates.handler({ userId: me.user.id }, { projectId: project.id });
  const started = states.find((state) => state.group === "started")!.id;
  // The coder's move of a work item to Started, in a Run the server records before the Agent acts.
  const move = async (itemId: string) => {
    const [run] = await db.insert(runs).values({ workspaceId, projectId: project.id, workItemId: itemId, agentId: coder.id, originatorId: me.user.id, status: "running" }).returning({ id: runs.id });
    return work.updateWorkItem.handler({ userId: coder.userId, source: "agent", agent: { agentUserId: coder.userId, runId: run!.id, originatorId: me.user.id, autopilot: true } }, { workItemId: itemId, stateId: started });
  };

  // 1. The switch is on and the reviewer may be used: the coder's move fires the reviewer's Trigger and a reviewer Run waits with depth 1.
  const first = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Login page" });
  await move(first.id);
  const [woken] = await db.select().from(runs).where(inArray(runs.agentId, [reviewer.id]));
  if (!woken || woken.depth !== 1 || woken.originatorId !== me.user.id) throw new Error("the state-changed Trigger did not wake the reviewer with depth 1 and the chain Originator");
  console.log("trigger: the coder's state change wakes the reviewer through its Trigger at depth 1");

  // 2. The Originator loses Agent access to the reviewer: the next state change is skipped and says why.
  await agentActions.setAgentAccess.handler({ userId: me.user.id }, { agentId: reviewer.id, userIds: [] });
  const second = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Checkout page" });
  const refused = await move(second.id);
  if (refused.stateId !== started) throw new Error("the coder's own state change did not save");
  if (await db.select().from(runs).where(inArray(runs.agentId, [reviewer.id])).then((rows) => rows.some((row) => row.workItemId === second.id))) throw new Error("a skipped wake still queued a reviewer Run");
  console.log("trigger: the next state change is skipped with no_agent_access and still saves");

  await page.goto(`${web}/${slug}/browse/MOB-2`);
  // The default timeline shows Comments only: All shows the Activity entries too.
  await page.getByRole("combobox", { name: translate("timeline.filter", "en"), exact: true }).selectOption("all");
  const skipped = page.getByText(translate("workItems.activity.wake_skipped.no_agent_access"), { exact: false }).first();
  await skipped.waitFor({ timeout: 30_000 });
  await Bun.write(`${shots}/trigger-timeline-1440.png`, await page.screenshot({ fullPage: true }));
  // The app scrolls inside its own container, so a full-page capture would stop above the Activity: scroll it into view first.
  await page.setViewportSize({ width: 390, height: 844 });
  await skipped.scrollIntoViewIfNeeded();
  await Bun.write(`${shots}/trigger-timeline-390.png`, await page.screenshot());
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("trigger: the work item's timeline says why the Trigger's wake did not happen");

  // 3. The Originator is notified in the inbox.
  const notice = translate("inbox.wakeSkipped.no_agent_access").replace("{actor}", coder.name);
  await page.goto(`${web}/${slug}/notifications`);
  await page.getByText(notice, { exact: false }).first().waitFor({ timeout: 30_000 });
  await Bun.write(`${shots}/trigger-inbox-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await Bun.write(`${shots}/trigger-inbox-390.png`, await page.screenshot({ fullPage: true }));
  console.log("trigger: the Originator's inbox carries the notice");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  stopWorker = true;
  await worker;
  for (const server of servers) server.kill();
  const mine = await db.select({ id: workspaces.id }).from(workspaces).where(like(workspaces.slug, "e2e-%"));
  const bots = mine.length === 0 ? [] : await db.select({ userId: agents.userId }).from(agents).where(inArray(agents.workspaceId, mine.map((row) => row.id)));
  await db.delete(jobs);
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  if (bots.length > 0) await db.delete(users).where(inArray(users.id, bots.map((row) => row.userId)));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
