// Browser end-to-end flow: an Admin turns on Can wake Agents for a coder Agent on its settings page. Before that, the coder's hand-off to a reviewer wakes nobody;
// after it, a hand-off to a reviewer the Originator may not use is skipped, leaves an Activity on the work item and a notice in the Originator's inbox, and the coder's action still succeeds.
// The coder's Run is set up through the actions, as the server records it, so no model is called. Screenshots go to WAKE_SWITCH_SCREENSHOT_DIR (default /tmp). Run with `bun e2e/wake-switch.e2e.ts`.
import { chromium } from "playwright";
import { inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, runs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createJobHandlers, createWorkItemActions, runNextJob } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31181);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52181);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.WAKE_SWITCH_SCREENSHOT_DIR ?? "/tmp";
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
  await page.getByLabel(translate("auth.name")).fill("Wake Tester");
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

  // Two Agents on the server, both open to every project. The Admin may use both; the coder starts with the switch off (the default).
  const agentActions = createAgentActions(db);
  const coder = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Coder Bot", instructions: "Hand finished work to the reviewer.", model: "default" });
  const reviewer = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Review Bot", instructions: "Review the work.", model: "default" });
  for (const agent of [coder, reviewer]) {
    await agentActions.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await agentActions.setAgentAccess.handler({ userId: me.user.id }, { agentId: agent.id, userIds: [me.user.id] });
  }
  const work = createWorkItemActions(db);
  const hand = async (itemId: string, originatorId: string) => {
    // The Run the coder works in on this item, as the server records it before the Agent acts.
    const [run] = await db.insert(runs).values({ workspaceId, projectId: project.id, workItemId: itemId, agentId: coder.id, originatorId, status: "running" }).returning({ id: runs.id });
    return work.updateWorkItem.handler({ userId: coder.userId, source: "agent", agent: { agentUserId: coder.userId, runId: run!.id, originatorId, autopilot: true } }, { workItemId: itemId, assigneeIds: [reviewer.userId] });
  };

  // 1. The switch is off: the coder's hand-off wakes nobody and its own change still saves.
  const first = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Login page" });
  const offOutcome = await hand(first.id, me.user.id);
  if (offOutcome.wakeOutcomes[0]?.reason !== "switch_off") throw new Error("the hand-off with the switch off did not report switch_off");
  console.log("wake: with Can wake Agents off, the hand-off wakes nobody (switch_off)");

  // 2. An Admin turns the switch on for the coder on the Agent settings page.
  await page.goto(`${web}/${slug}/settings/agents`);
  const coderRow = page.locator(`[data-agent="${coder.name}"]`);
  await coderRow.getByRole("button", { name: translate("agents.edit"), exact: true }).click();
  const toggle = coderRow.getByRole("checkbox", { name: translate("agents.canWakeAgents"), exact: true });
  await toggle.click();
  await coderRow.getByRole("button", { name: translate("agents.save"), exact: true }).click();
  await page.reload();
  await page.locator(`[data-agent="${coder.name}"]`).getByRole("button", { name: translate("agents.edit"), exact: true }).click();
  await page.locator(`[data-agent="${coder.name}"]`).getByRole("checkbox", { name: translate("agents.canWakeAgents"), exact: true }).waitFor();
  if (await page.locator(`[data-agent="${coder.name}"]`).getByRole("checkbox", { name: translate("agents.canWakeAgents"), exact: true }).getAttribute("aria-checked") !== "true") throw new Error("Can wake Agents did not stay on after saving");
  await Bun.write(`${shots}/wake-switch-settings-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await Bun.write(`${shots}/wake-switch-settings-390.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("wake: the Admin turns Can wake Agents on for the coder and it stays on after a reload");

  // 3. The reviewer's Agent access no longer includes the Originator: the switched-on hand-off is skipped and says why.
  await agentActions.setAgentAccess.handler({ userId: me.user.id }, { agentId: reviewer.id, userIds: [] });
  const second = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Checkout page" });
  const refused = await hand(second.id, me.user.id);
  if (refused.assigneeIds[0] !== reviewer.userId) throw new Error("the coder's own change did not save when its wake was skipped");
  if (refused.wakeOutcomes[0]?.reason !== "no_agent_access") throw new Error("the switched-on hand-off was not skipped with no_agent_access");
  console.log("wake: the switched-on hand-off is skipped with no_agent_access and the coder's assignment still saves");

  await page.goto(`${web}/${slug}/browse/MOB-2`);
  // The timeline opens on Comments; the skipped wake is an Activity entry.
  await page.getByRole("combobox", { name: translate("timeline.filter", "en"), exact: true }).selectOption("all");
  const skipped = page.getByText(translate("workItems.activity.wake_skipped.no_agent_access"), { exact: false }).first();
  await skipped.waitFor({ timeout: 30_000 });
  await Bun.write(`${shots}/wake-switch-timeline-1440.png`, await page.screenshot({ fullPage: true }));
  // The app scrolls inside its own container, so a full-page capture would stop above the Activity: scroll it into view first.
  await page.setViewportSize({ width: 390, height: 844 });
  await skipped.scrollIntoViewIfNeeded();
  await Bun.write(`${shots}/wake-switch-timeline-390.png`, await page.screenshot());
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("wake: the work item's timeline says why the wake did not happen");

  // 4. The Originator is notified in the inbox.
  const notice = translate("inbox.wakeSkipped.no_agent_access").replace("{actor}", coder.name);
  await page.goto(`${web}/${slug}/notifications`);
  await page.getByText(notice, { exact: false }).first().waitFor({ timeout: 30_000 });
  await Bun.write(`${shots}/wake-switch-inbox-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await Bun.write(`${shots}/wake-switch-inbox-390.png`, await page.screenshot({ fullPage: true }));
  console.log("wake: the Originator's inbox carries the notice");
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
