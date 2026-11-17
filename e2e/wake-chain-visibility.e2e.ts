// Browser end-to-end flow: a person can see a Wake chain on the work item. A coder Agent (Can wake Agents on) hands a work item to a reviewer Agent,
// so the reviewer's Run shows which Run woke it, as a link, and its depth, on the Runs panel and in the timeline. A request for a busy reviewer is a
// waiting entry, a person's comment that mentions the busy reviewer is a steered entry, and a hand-off the Originator may not make is a skipped entry with its reason.
// No Run calls a model: the Runs the flow needs are recorded through the actions, as the server records them. Screenshots go to WAKE_CHAIN_SCREENSHOT_DIR
// (default /tmp/weft-wake-chain-visibility-e2e) at 1440 and 390 px. Run with `bun e2e/wake-chain-visibility.e2e.ts`.
import { chromium } from "playwright";
import { inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, runs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createCommentActions, createJobHandlers, createWorkItemActions, runNextJob } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31182);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52182);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.WAKE_CHAIN_SCREENSHOT_DIR ?? "/tmp/weft-wake-chain-visibility-e2e";
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

// The worker only delivers the notice jobs and runs the Runs the wakes queue, with a model that answers at once.
const handlers = createJobHandlers(undefined, { runModel: { async step() { return { text: "Looked at it.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } } });
const worker = (async () => { while (!stopWorker) { const result = await runNextJob(db, handlers); if (result.status === "idle") await Bun.sleep(200); } })();

/** Fails the flow with a message when a check does not hold. */
function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
  console.log(`wake chain: ${message}`);
}

/** Desktop and phone captures of the entry the flow checks. The app scrolls inside its own container, so the entry is scrolled into view first; the phone page must not scroll sideways. */
async function capture(page: import("playwright").Page, name: string, entry: import("playwright").Locator) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await entry.scrollIntoViewIfNeeded();
  await Bun.write(`${shots}/${name}-1440.png`, await page.screenshot());
  await page.setViewportSize({ width: 390, height: 844 });
  await entry.scrollIntoViewIfNeeded();
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflows, `${name} at 390 px has no sideways scroll`);
  await Bun.write(`${shots}/${name}-390.png`, await page.screenshot());
  await page.setViewportSize({ width: 1440, height: 900 });
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await Bun.$`mkdir -p ${shots}`;
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

  // A coder and a reviewer on the server, both open to every project; the coder may wake Agents.
  const agentActions = createAgentActions(db);
  const coder = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Coder Bot", instructions: "Hand finished work to the reviewer.", model: "default" });
  const reviewer = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Review Bot", instructions: "Review the work.", model: "default" });
  for (const agent of [coder, reviewer]) {
    await agentActions.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await agentActions.setAgentAccess.handler({ userId: me.user.id }, { agentId: agent.id, userIds: [me.user.id] });
  }
  await agentActions.updateAgent.handler({ userId: me.user.id }, { agentId: coder.id, canWakeAgents: true });
  const work = createWorkItemActions(db);
  const comments = createCommentActions(db);
  const newItem = async (title: string) => (await call<{ id: string }>("create_work_item", { projectId: project.id, title })).id;
  /** The coder's change on a work item, made inside a Run the server recorded before the Agent acted. */
  const hand = async (itemId: string) => {
    const [run] = await db.insert(runs).values({ workspaceId, projectId: project.id, workItemId: itemId, agentId: coder.id, originatorId: me.user.id, status: "completed" }).returning({ id: runs.id });
    return work.updateWorkItem.handler({ userId: coder.userId, source: "agent", agent: { agentUserId: coder.userId, runId: run!.id, originatorId: me.user.id, autopilot: true } }, { workItemId: itemId, assigneeIds: [reviewer.userId] });
  };
  /** A Run the reviewer works in on an item, as the server records it: it is busy until the flow ends. */
  const busyReviewer = async (itemId: string) => (await db.insert(runs).values({ workspaceId, projectId: project.id, workItemId: itemId, agentId: reviewer.id, originatorId: me.user.id, status: "running" }).returning({ id: runs.id }))[0]!;

  // 1. The coder hands "Login page" to the reviewer: the reviewer's Run is woken by the coder's Run, at depth 1.
  const login = await newItem("Login page");
  const woken = await hand(login);
  check(woken.wakeOutcomes[0]?.status === "started", "the coder's hand-off starts the reviewer's Run");
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const panel = page.getByTestId("runs-panel");
  const wokenLink = panel.getByTestId("run-woken-by").getByRole("link", { name: translate("runs.wokenBy").replace("{agent}", coder.name) });
  await wokenLink.waitFor({ timeout: 30_000 });
  check((await wokenLink.getAttribute("href"))?.startsWith("?run="), "the Runs panel links the woken Run to the Run that woke it");
  check((await panel.getByTestId("run-woken-by").first().innerText()).includes(translate("runs.wokenByDepth").replace("{depth}", "1")), "the Runs panel shows depth 1 for the woken Run");
  // The default timeline shows Comments only: All shows the Activity entries too.
  await page.getByRole("combobox", { name: translate("timeline.filter", "en"), exact: true }).selectOption("all");
  const startedEntry = page.getByTestId("activity-woken-by").first();
  await startedEntry.waitFor({ timeout: 30_000 });
  check(await page.getByText(translate("workItems.activity.run_started"), { exact: false }).first().isVisible(), "the timeline shows the started entry");
  await capture(page, "wake-chain-login-timeline", startedEntry);

  // 2. "Checkout page": the reviewer is busy, so the coder's hand-off waits in a Follow-up Run.
  const checkout = await newItem("Checkout page");
  await busyReviewer(checkout);
  const waiting = await hand(checkout);
  check(waiting.wakeOutcomes[0]?.status === "waiting", "the hand-off to a busy reviewer is a waiting outcome");
  // 3. A person's comment mentions the busy reviewer: it steers that Run.
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: reviewer.userId, label: reviewer.name } }, { type: "text", text: " Also check the Safari redirect." }] }] };
  const steer = await comments.createComment.handler({ userId: me.user.id }, { workItemId: checkout, body: doc });
  check(steer.wakeOutcomes[0]?.status === "steered", "a person's mention of the busy reviewer steers its Run");
  await page.goto(`${web}/${slug}/browse/MOB-2`);
  const waitingEntry = page.getByText(translate("workItems.activity.run_waiting"), { exact: false }).first();
  await waitingEntry.waitFor({ timeout: 30_000 });
  const steeredEntry = page.getByText(translate("workItems.activity.run_steered"), { exact: false }).first();
  await steeredEntry.waitFor({ timeout: 30_000 });
  await capture(page, "wake-chain-checkout-waiting", waitingEntry);
  await capture(page, "wake-chain-checkout-steered", steeredEntry);

  // 4. "Search page": the reviewer's Agent access no longer includes the Originator, so the hand-off is skipped and says why.
  await agentActions.setAgentAccess.handler({ userId: me.user.id }, { agentId: reviewer.id, userIds: [] });
  const search = await newItem("Search page");
  const refused = await hand(search);
  check(refused.wakeOutcomes[0]?.reason === "no_agent_access", "the hand-off the Originator may not make is skipped with no_agent_access");
  await page.goto(`${web}/${slug}/browse/MOB-3`);
  const skippedEntry = page.getByText(translate("workItems.activity.wake_skipped.no_agent_access"), { exact: false }).first();
  await skippedEntry.waitFor({ timeout: 30_000 });
  await capture(page, "wake-chain-search-skipped", skippedEntry);
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
