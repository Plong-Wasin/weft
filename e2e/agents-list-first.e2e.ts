// Browser end-to-end flow: the Agents screen lists Agents first with a New Agent button, the create form opens on demand with
// Limits folded, Runs on shows each Runtime as online or offline and links to Connect AI when there is none, and editing still works.
// Run with `bun e2e/agents-list-first.e2e.ts`.
import { createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import { eq, inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, runtimes, users, workspaces } from "../packages/db/src";
import { createAgentActions, createApiTokenActions, createRuntimeActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31190);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52190);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let failed = false;
const { client, db } = createDatabase();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" }, api, web, {
    account: { name: "Agent Lister", email },
    workspace: { name: "Agent list team", slug },
  });
  const page = await context.newPage();

  await page.goto(`${web}/${slug}`);
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const ownerId = me.user.id;
  const agentActions = createAgentActions(db);

  // An existing Agent: the screen opens on the list, not on the create form.
  await agentActions.createAgent.handler({ userId: ownerId }, { workspaceId, name: "Existing Bot", model: "default" });
  await page.goto(`${web}/${slug}/settings/agents`);
  const card = page.locator('[data-agent="Existing Bot"]');
  await card.waitFor();
  const newAgent = page.getByRole("button", { name: translate("agents.newAgent"), exact: true });
  await newAgent.waitFor();
  check(await page.getByLabel(translate("agents.name")).count() === 0, "the create form is open on load");
  check(await page.getByRole("heading", { name: translate("agents.create") }).count() === 0, "the create section is open on load");
  check(await card.isVisible(), "the Agent list is not shown first");
  console.log("agents-list-first: opening Agents shows the list and a New Agent button, not the form");

  // New Agent opens the form with the four common fields; Limits stays folded.
  await newAgent.click();
  await page.getByLabel(translate("agents.name")).waitFor();
  for (const key of ["agents.name", "agents.instructions", "agents.model", "agents.runsOn"] as const) {
    check(await page.getByLabel(translate(key)).isVisible(), `create form lacks ${key}`);
  }
  const limits = page.locator("details", { has: page.getByText(translate("agents.limits"), { exact: true }) });
  await limits.waitFor();
  check(!(await limits.evaluate((node) => (node as HTMLDetailsElement).open)), "Limits is open by default");
  check(!(await page.getByLabel(translate("agents.maxToolCalls")).isVisible()), "Tool calls is visible while Limits is folded");
  await limits.locator("summary").click();
  for (const key of ["agents.maxToolCalls", "agents.maxTokens", "agents.timeoutSeconds", "agents.monthlyBudget"] as const) {
    check(await page.getByLabel(translate(key)).isVisible(), `Limits does not hold ${key}`);
  }
  await limits.locator("summary").click();
  console.log("agents-list-first: New Agent opens the form; Limits folds Tool calls, Tokens, Timeout and Budget");

  // With no Runtime, Runs on links to Connect AI.
  const connectLink = page.getByRole("link", { name: translate("runtimes.connectLink") });
  await connectLink.waitFor();
  check((await connectLink.getAttribute("href")) === `/${slug}/settings/connect-ai`, "the no-Runtime link does not point to Connect AI");
  await connectLink.click();
  await page.waitForURL(`**/${slug}/settings/connect-ai`);
  console.log("agents-list-first: with no Runtime, Runs on links to Connect AI");

  // Two Runtimes, one online and one offline: each option says so.
  const runtimeActions = createRuntimeActions(db);
  const onlineToken = await createApiTokenActions(db).createApiToken.handler({ userId: ownerId }, { name: "e2e online daemon" });
  const offlineToken = await createApiTokenActions(db).createApiToken.handler({ userId: ownerId }, { name: "e2e offline daemon" });
  const online = (await runtimeActions.registerDaemon.handler({ userId: ownerId, apiTokenId: onlineToken.id }, { hostname: "agents-online-host", version: "1", agentClis: ["claude"] })).runtimes[0]!;
  const offline = (await runtimeActions.registerDaemon.handler({ userId: ownerId, apiTokenId: offlineToken.id }, { hostname: "agents-offline-host", version: "1", agentClis: ["codex"] })).runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: ownerId }, { runtimeId: online.id });
  await runtimeActions.shareRuntime.handler({ userId: ownerId }, { runtimeId: offline.id });
  await db.update(runtimes).set({ lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(runtimes.id, offline.id));

  await page.goto(`${web}/${slug}/settings/agents`);
  await newAgent.click();
  const runsOn = page.getByLabel(translate("agents.runsOn"));
  await runsOn.locator("option", { hasText: "agents-online-host" }).waitFor({ state: "attached" });
  const onlineText = (await runsOn.locator("option", { hasText: "agents-online-host" }).textContent()) ?? "";
  const offlineText = (await runsOn.locator("option", { hasText: "agents-offline-host" }).textContent()) ?? "";
  check(onlineText.includes(translate("runtimes.online")) && !onlineText.includes(translate("runtimes.offline")), `online Runtime option reads "${onlineText}"`);
  check(offlineText.includes(translate("runtimes.offline")), `offline Runtime option reads "${offlineText}"`);
  check(await page.getByRole("link", { name: translate("runtimes.connectLink") }).count() === 0, "the Connect AI link shows although a Runtime exists");
  console.log("agents-list-first: Runs on shows each Runtime online or offline");

  // Creating an Agent from the form closes it and lists the new Agent.
  await page.getByLabel(translate("agents.name")).fill("Form Bot");
  await page.getByLabel(translate("agents.instructions")).fill("Created from the form.");
  await runsOn.selectOption(online.id);
  const createForm = page.locator("form").filter({ has: page.getByLabel(translate("agents.instructions")) });
  check(await createForm.count() === 1, "the New Agent fields do not identify one create form");
  await createForm.getByRole("button", { name: translate("agents.save"), exact: true }).click();
  await page.locator('[data-agent="Form Bot"]').waitFor();
  await createForm.waitFor({ state: "detached" });
  console.log("agents-list-first: creating an Agent closes the form and lists it");

  // Editing an Agent keeps working; Limits is folded in the edit form too.
  const formBot = page.locator('[data-agent="Form Bot"]');
  await formBot.getByRole("button", { name: translate("agents.edit"), exact: true }).click();
  const editLimits = formBot.locator("details", { has: page.getByText(translate("agents.limits"), { exact: true }) });
  await editLimits.waitFor();
  check(!(await editLimits.evaluate((node) => (node as HTMLDetailsElement).open)), "Limits is open by default in the edit form");
  const editForm = formBot.locator("form").filter({ hasText: translate("agents.instructions") });
  check(await editForm.count() === 1, "the Agent editor fields do not identify one edit form");
  await editForm.getByLabel(translate("agents.name")).fill("Form Bot Renamed");
  await editForm.getByRole("button", { name: translate("agents.save"), exact: true }).click();
  await page.locator('[data-agent="Form Bot Renamed"]').waitFor();
  console.log("agents-list-first: editing an Agent keeps working with Limits folded");

  const saved = await (await page.request.post(`${api}/actions/list_agents`, { data: { workspaceId } })).json() as Array<{ name: string }>;
  check(saved.some((row) => row.name === "Form Bot Renamed"), "the edited Agent was not saved");

  console.log("e2e agents-list-first: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
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
