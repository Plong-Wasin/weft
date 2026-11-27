// Browser end-to-end flow for the "sub-items closed" Trigger. An Admin adds the Trigger on the Agent settings page, a person closes the two sub-items
// of a parent assigned to the Agent, and the Agent's Run appears on the parent's timeline. Screenshots go to SUB_ITEMS_SCREENSHOT_DIR (default /tmp)
// at 1440 and 390 px. No Run calls a model. Run with `bun e2e/sub-items-closed.e2e.ts`.
import { createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import { eq, inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, runs, triggers, users, workspaces } from "../packages/db/src";
import { createAgentActions, createJobHandlers, createWorkItemActions, runNextJob } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31183);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52183);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.SUB_ITEMS_SCREENSHOT_DIR ?? "/tmp";
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

let failed = false;
let stopWorker = false;
const { client, db } = createDatabase();

// No Run calls a model in this flow; the worker only delivers the notice jobs the wakes queue.
const handlers = createJobHandlers(undefined, { runModel: { async step() { return { text: "unused", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } } });
const worker = (async () => { while (!stopWorker) { const result = await runNextJob(db, handlers); if (result.status === "idle") await Bun.sleep(200); } })();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" }, api, web, {
    account: { name: "Sub-items Tester", email },
    workspace: { name: "E2E team", slug },
    project: { name: "Mobile", key: "MOB", visibility: "public", shape: "simple" },
  });
  const page = await context.newPage();
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });

  // An Agent open to every project, usable by the Admin, with a "sub-items closed" Trigger added through the settings page.
  const agentActions = createAgentActions(db);
  const owner = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Summary Bot", instructions: "Summarise the finished split.", model: "default" });
  await agentActions.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: owner.id, allProjects: true, projectIds: [] });
  await agentActions.setAgentAccess.handler({ userId: me.user.id }, { agentId: owner.id, userIds: [me.user.id] });
  const noProjectAccess = await agentActions.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "No Project Access Bot", instructions: "No access yet.", model: "default" });
  await agentActions.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: noProjectAccess.id, allProjects: false, projectIds: [] });
  await agentActions.setAgentAccess.handler({ userId: me.user.id }, { agentId: noProjectAccess.id, userIds: [me.user.id] });
  let releaseProjects!: () => void;
  let projectRequestSeen!: () => void;
  const projectsBlocked = new Promise<void>((resolve) => { releaseProjects = resolve; });
  const projectsRequested = new Promise<void>((resolve) => { projectRequestSeen = resolve; });
  await page.route(`${api}/actions/list_projects`, async (route) => { projectRequestSeen(); await projectsBlocked; await route.continue(); });
  await page.goto(`${web}/${slug}/settings/agents`);
  await projectsRequested;
  const card = page.locator('[data-agent="Summary Bot"]');
  await card.waitFor();
  const loading = card.getByRole("status").filter({ hasText: "Loading Projects" });
  await loading.waitFor();
  if (await card.getByRole("button", { name: translate("triggers.add") }).isEnabled()) throw new Error("Add Trigger was enabled while Projects were loading");
  await Bun.write(`${shots}/trigger-loading-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await Bun.write(`${shots}/trigger-loading-390.png`, await page.screenshot());
  await page.setViewportSize({ width: 1440, height: 900 });
  releaseProjects();
  await page.unroute(`${api}/actions/list_projects`);
  // The Agent row renders before list_projects finishes loading. The default selection must
  // follow the available Projects instead of leaving the controlled select at an empty id.
  const projectSelect = card.getByLabel(translate("triggers.project"), { exact: true });
  await projectSelect.getByRole("option", { name: "MOB · Mobile" }).waitFor({ state: "attached" });
  if (await projectSelect.locator("option:checked").textContent() !== "MOB · Mobile") throw new Error("the displayed Project was not selected after Projects loaded");
  if (await card.getByRole("button", { name: translate("triggers.add") }).isDisabled()) throw new Error("Add Trigger remained disabled after Projects loaded");
  await card.getByLabel(translate("triggers.event")).selectOption("sub_items_closed");
  await card.getByRole("button", { name: translate("triggers.add") }).click();
  const triggerRow = card.getByText(translate("triggers.sub_items_closed"), { exact: false }).filter({ hasText: "MOB" }).first();
  await triggerRow.waitFor({ timeout: 30_000 });
  const saved = await call<Array<{ id: string; eventType: string }>>("list_triggers", { agentId: owner.id });
  const trigger = saved.find((row) => row.eventType === "sub_items_closed");
  if (!trigger) throw new Error("the sub-items closed Trigger was not saved");
  if ((await db.select().from(triggers).where(eq(triggers.id, trigger.id)).then((rows) => rows[0]?.projectId)) !== project.id) throw new Error("the Trigger was not saved to the displayed Project");
  const noAccessCard = page.locator('[data-agent="No Project Access Bot"]');
  await noAccessCard.getByText("This Agent has no access to any Projects.", { exact: false }).waitFor();
  if (await noAccessCard.getByRole("button", { name: translate("triggers.add") }).isEnabled()) throw new Error("Add Trigger was enabled without an accessible Project");
  await noAccessCard.scrollIntoViewIfNeeded();
  await Bun.write(`${shots}/trigger-no-access-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await noAccessCard.getByLabel(translate("triggers.project"), { exact: true }).scrollIntoViewIfNeeded();
  await Bun.write(`${shots}/trigger-no-access-390.png`, await page.screenshot());
  await page.setViewportSize({ width: 1440, height: 900 });
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
  // The first match can be the copy of the assignee that the narrow layout hides; wait for one that is shown.
  await page.getByText("Summary Bot", { exact: false }).locator("visible=true").first().waitFor({ timeout: 30_000 });
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
