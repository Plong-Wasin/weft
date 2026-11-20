// Browser end-to-end flow: an Agent is busy on a work item, a person asks it again, and the request waits in a Follow-up Run.
// The Activity says it waits; when the first Run finishes, the Follow-up Run starts and carries the comment written meanwhile.
// The model is a scripted fake: the first Run waits until this flow releases it. Screenshots go to FOLLOW_UP_SCREENSHOT_DIR (default /tmp). Run with `bun e2e/follow-up-run.e2e.ts`.
import { chromium } from "playwright";
import { inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createJobHandlers, runNextJob, type RunModel } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31181);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52181);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.FOLLOW_UP_SCREENSHOT_DIR ?? "/tmp";
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

// The first Run waits until the flow releases it; a Follow-up Run's prompt says so and is answered at once.
let release!: () => void;
const released = new Promise<void>((resolve) => { release = resolve; });
const model: RunModel = {
  async step(request) {
    const usage = { inputTokens: 10, outputTokens: 5 };
    const prompt = JSON.stringify(request.messages[0]);
    if (prompt.includes("asked again")) return { text: "Second answer: noted the follow-up comment.", toolCalls: [], usage };
    await released;
    return { text: "First answer.", toolCalls: [], usage };
  },
};
const handlers = createJobHandlers(undefined, { runModel: model });
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
  await page.getByLabel(translate("auth.name")).fill("Follow-up Tester");
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

  // An Admin creates an Agent that may work in every project; the Agent runs on the server.
  const agent = await createAgentActions(db).createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Helper Bot", instructions: "Answer the newest request.", model: "default" });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const item = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Login page" });
  const mention = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: agent.userId, label: "Helper Bot" } }, { type: "text", text: " please check the redirect" }] }] };

  // A second person (a Member of the workspace and project who may use the Agent) asks it again. The same person who started the Run would steer it (ADR 0013), so the request would not wait.
  const invite = await call<{ token: string }>("create_invite", { workspaceId, role: "Member" });
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`${web}/invite/${invite.token}`);
  await memberPage.getByLabel(translate("auth.name")).fill("Second Asker");
  await memberPage.getByLabel(translate("auth.email")).fill(`${slug}-asker@example.test`);
  await memberPage.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await memberPage.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await memberPage.getByRole("button", { name: translate("auth.signUp") }).click();
  await memberPage.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  const memberId = (await (await memberPage.request.get(`${api}/api/me`)).json() as { user: { id: string } }).user.id;
  await call("add_project_member", { projectId: project.id, userId: memberId, role: "Member" });
  await call("set_agent_access", { agentId: agent.id, userIds: [me.user.id, memberId] });
  const callAsMember = async <T>(name: string, body: unknown) => await (await memberPage.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  // Assigning the Agent starts its first Run; the Run waits in the model until this flow releases it.
  const assigned = await call<{ wakeOutcomes: Array<{ status: string }> }>("update_work_item", { workItemId: item.id, assigneeIds: [agent.userId] });
  if (assigned.wakeOutcomes[0]?.status !== "started") throw new Error("the assignment did not start the first Run");
  // A second person asks the busy Agent again: the request waits in one Follow-up Run.
  const asked = await callAsMember<{ wakeOutcomes: Array<{ status: string }> }>("create_comment", { workItemId: item.id, body: mention });
  if (asked.wakeOutcomes[0]?.status !== "waiting") throw new Error("the request during the active Run did not wait");
  await call("create_comment", { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Reviewer note: the redirect loops on Safari." }] }] } });
  console.log("follow-up: the busy Agent's request waits; a note is written meanwhile");

  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const panel = page.getByTestId("runs-panel");
  // The timeline opens on Comments; the waiting Activity is under All.
  await page.getByRole("combobox", { name: translate("timeline.filter"), exact: true }).selectOption("all");
  await panel.getByText(translate("runs.status.follow_up"), { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText(translate("workItems.activity.run_waiting"), { exact: false }).first().waitFor({ timeout: 30_000 });
  if (await page.getByText(translate("runs.status.skipped"), { exact: true }).count() > 0) throw new Error("a skipped Run is shown for a request that waits");
  await Bun.write(`${shots}/follow-up-waiting-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByText(translate("runs.status.follow_up"), { exact: true }).waitFor();
  await Bun.write(`${shots}/follow-up-waiting-390.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("follow-up: the Run page shows the waiting Follow-up Run and the Activity says waiting");

  // The first Run finishes; the Follow-up Run starts after it and completes.
  release();
  await panel.getByText(translate("runs.status.completed"), { exact: true }).nth(1).waitFor({ timeout: 60_000 });
  await page.reload();
  await page.getByTestId("runs-panel").getByText(translate("runs.status.completed"), { exact: true }).nth(1).waitFor({ timeout: 60_000 });
  if (await page.getByTestId("runs-panel").getByText(translate("runs.status.follow_up"), { exact: true }).count() > 0) throw new Error("the Follow-up Run still waits after the active Run completed");
  await Bun.write(`${shots}/follow-up-started-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await Bun.write(`${shots}/follow-up-started-390.png`, await page.screenshot({ fullPage: true }));
  console.log("follow-up: after the active Run completes, the Follow-up Run starts and completes");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  release();
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
