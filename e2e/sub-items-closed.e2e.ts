// Browser end-to-end flow for the "sub-items closed" Trigger. An Admin adds the Trigger on the Agent settings page, a person closes the two sub-items
// of a parent assigned to the Agent, and the Agent's Run appears on the parent's timeline. Screenshots go to SUB_ITEMS_SCREENSHOT_DIR (default /tmp)
// at 1440 and 390 px. No Run calls a model. Run with `bun e2e/sub-items-closed.e2e.ts`.
import { chromium } from "playwright";
import { eq, inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, runs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createJobHandlers, createWorkItemActions, runNextJob } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31183);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52183);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.SUB_ITEMS_SCREENSHOT_DIR ?? "/tmp";
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
  await page.getByLabel(translate("auth.name")).fill("Sub-items Tester");
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

  // An Agent open to every project, usable by the Admin, with a "sub-items closed" Trigger added through the settings page.
  const agentActions = createAgentActions(db);
  const owner = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Summary Bot", instructions: "Summarise the finished split.", model: "default" });
  await agentActions.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: owner.id, allProjects: true, projectIds: [] });
  await agentActions.setAgentAccess.handler({ userId: me.user.id }, { agentId: owner.id, userIds: [me.user.id] });
  await page.goto(`${web}/${slug}/settings/agents`);
  const card = page.locator('[data-agent="Summary Bot"]');
  await card.waitFor();
  await card.getByLabel(translate("triggers.project"), { exact: true }).selectOption({ label: "MOB · Mobile" });
  await card.getByLabel(translate("triggers.event")).selectOption("sub_items_closed");
  await card.getByRole("button", { name: translate("triggers.add") }).click();
  const triggerRow = card.getByText(translate("triggers.sub_items_closed"), { exact: false }).filter({ hasText: "MOB" }).first();
  await triggerRow.waitFor({ timeout: 30_000 });
  const saved = await call<Array<{ id: string; eventType: string }>>("list_triggers", { agentId: owner.id });
  const trigger = saved.find((row) => row.eventType === "sub_items_closed");
  if (!trigger) throw new Error("the sub-items closed Trigger was not saved");
  await Bun.write(`${shots}/sub-items-settings-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await triggerRow.scrollIntoViewIfNeeded();
  await Bun.write(`${shots}/sub-items-settings-390.png`, await page.screenshot());
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("sub-items-closed: the Trigger is created on the settings page and shows its label");

  // A parent owned by the Agent with two sub-items. Closing the first wakes nobody; closing the last wakes the Agent.
  const work = createWorkItemActions(db);
  const states = await work.listStates.handler({ userId: me.user.id }, { projectId: project.id });
  const done = states.find((state) => state.group === "completed")!.id;
  const parent = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Ship the login" });
  const one = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Build the form", parentId: parent.id });
  const two = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Wire the API", parentId: parent.id });
  await call("update_work_item", { workItemId: parent.id, assigneeIds: [owner.userId] });
  await db.update(runs).set({ status: "completed", finishedAt: new Date() }).where(eq(runs.workItemId, parent.id));
  await call("update_work_item", { workItemId: one.id, stateId: done });
  if ((await db.select().from(runs).where(eq(runs.triggerId, trigger.id))).length !== 0) throw new Error("closing a non-last sub-item woke the Agent");
  await call("update_work_item", { workItemId: two.id, stateId: done });
  const [woken] = await db.select().from(runs).where(eq(runs.triggerId, trigger.id));
  if (!woken || woken.workItemId !== parent.id || woken.originatorId !== me.user.id || woken.depth !== 0 || woken.status !== "queued") throw new Error("closing the last sub-item did not queue the Agent's Run on the parent");
  console.log("sub-items-closed: the last close queues the parent's Agent with the closing person as Originator");

  await page.goto(`${web}/${slug}/browse/MOB-1`);
  await page.getByText("Summary Bot", { exact: false }).first().waitFor({ timeout: 30_000 });
  await page.getByText(translate("workItems.subItems"), { exact: false }).first().waitFor({ timeout: 30_000 });
  await Bun.write(`${shots}/sub-items-parent-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await Bun.write(`${shots}/sub-items-parent-390.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("sub-items-closed: the parent page shows the Agent and its sub-items");
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
