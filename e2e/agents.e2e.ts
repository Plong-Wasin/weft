// Browser end-to-end flow: an admin creates an Agent and opens it to projects, a member assigns it a work item, the Run waits for the Originator's Confirmation,
// approval resumes it and its comment (with the Agent marker and Run link) appears; a second Run is cancelled and rerun.
// The model is a scripted fake driven by an in-process job loop, so no provider is called. Run with `bun e2e/agents.e2e.ts`.
import { chromium } from "playwright";
import { inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, users, workspaces } from "../packages/db/src";
import { createJobHandlers, runNextJob, type RunModel } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31181);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52181);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
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
const itemIds: string[] = [];

/** Proposes one rename for the work item in the prompt, then answers once the tool result is back. */
const model: RunModel = {
  async step(request) {
    const usage = { inputTokens: 10, outputTokens: 5 };
    if (request.messages.at(-1)?.role === "tool") return { text: "I renamed it as asked.", toolCalls: [], usage };
    const target = itemIds.find((id) => JSON.stringify(request.messages).includes(id));
    if (!target) return { text: "Nothing to do.", toolCalls: [], usage };
    return { text: null, toolCalls: [{ id: `call-${target}`, name: "update_work_item", input: { workItemId: target, title: "Renamed by Helper Bot" } }], usage };
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
  await page.getByLabel(translate("auth.name")).fill("Agent Tester");
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
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });

  // An admin creates an Agent and opens every project to it.
  await page.goto(`${web}/${slug}/settings/agents`);
  await page.getByLabel(translate("agents.name")).fill("Helper Bot");
  await page.getByLabel(translate("agents.instructions")).fill("Rename things when asked.");
  await page.getByRole("button", { name: translate("agents.save") }).click();
  const card = page.locator('[data-agent="Helper Bot"]');
  await card.waitFor();
  await card.getByLabel(translate("agents.allProjects")).click();
  await page.waitForFunction(() => document.querySelector('[data-agent="Helper Bot"] input[type=checkbox]:checked') !== null);
  console.log("agents: admin creates an Agent and opens it to all projects");

  // Assign from the work item page: the Run shows its status and waits for the Originator's Confirmation.
  const first = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Original title" });
  const second = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Second job" });
  itemIds.push(first.id, second.id);
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const sidebar = page.getByRole("complementary", { name: translate("workItems.properties") });
  await sidebar.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Helper Bot", exact: true }).click();
  await page.keyboard.press("Escape");
  const panel = page.getByTestId("runs-panel");
  await panel.getByText(translate("runs.status.waiting_confirmation"), { exact: true }).waitFor({ timeout: 30_000 });
  console.log("agents: assigning shows the Run status and the pending Confirmation");

  // The Originator is notified, then approves from the work item.
  const inbox = await call<{ notifications: Array<{ kind: string }> }>("list_notifications", { workspaceId });
  if (!inbox.notifications.some((entry) => entry.kind === "run_confirmation")) throw new Error("no run_confirmation notification");
  await page.getByRole("button", { name: translate("ai.confirmAll") }).click();
  await panel.getByText(translate("runs.status.completed"), { exact: true }).waitFor({ timeout: 30_000 });
  const comment = page.locator("li", { has: page.locator("mark[data-agent-marker]") }).first();
  await comment.getByText("I renamed it as asked.").waitFor({ timeout: 15_000 });
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).first().waitFor();
  console.log("agents: approving resumes the Run and the Agent comment appears with its marker");

  // The comment's Run link opens this work item on that Run.
  await comment.getByRole("link", { name: translate("comments.viewRun") }).click();
  await page.waitForURL(/\?run=/);
  await page.locator("[data-highlighted]").waitFor();
  console.log("agents: the Run link serves the Run view");

  // A second Run is cancelled while waiting, then rerun.
  await call("update_work_item", { workItemId: second.id, assigneeIds: [(await call<Array<{ userId: string; name: string }>>("list_members", { workspaceId })).find((member) => member.name === "Helper Bot")!.userId] });
  await page.goto(`${web}/${slug}/browse/MOB-2`);
  const panel2 = page.getByTestId("runs-panel");
  await panel2.getByText(translate("runs.status.waiting_confirmation"), { exact: true }).waitFor({ timeout: 30_000 });
  await panel2.getByRole("button", { name: translate("runs.cancel") }).click();
  await panel2.getByText(translate("runs.status.cancelled"), { exact: true }).waitFor();
  await panel2.getByRole("button", { name: translate("runs.rerun") }).click();
  await panel2.getByText(translate("runs.status.waiting_confirmation"), { exact: true }).waitFor({ timeout: 30_000 });
  if ((await panel2.locator("[data-run-status]").count()) !== 2) throw new Error("expected the cancelled Run and its rerun");
  console.log("agents: cancel and rerun work from the work item");

  console.log("e2e agents: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  stopWorker = true;
  await worker;
  for (const server of servers) server.kill();
  // Bot users are not removed with the workspace, and the jobs this flow queued must not linger for other test runs.
  const mine = await db.select({ id: workspaces.id }).from(workspaces).where(like(workspaces.slug, "e2e-%"));
  const bots = mine.length === 0 ? [] : await db.select({ userId: agents.userId }).from(agents).where(inArray(agents.workspaceId, mine.map((row) => row.id)));
  await db.delete(jobs);
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  if (bots.length > 0) await db.delete(users).where(inArray(users.id, bots.map((row) => row.userId)));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
