// Browser end-to-end flow: an admin creates an Agent and opens it to projects, a member assigns it a work item, the Run waits for the Originator's Confirmation,
// approval resumes it and its comment (with the Agent marker and Run link) appears; a second Run is cancelled and rerun.
// The model is a scripted fake driven by an in-process job loop, so no provider is called. Run with `bun e2e/agents.e2e.ts`.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { eq, inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createApiTokenActions, createJobHandlers, createRuntimeActions, runNextJob, type RunModel } from "../packages/actions/src";
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
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });

  // An admin creates an Agent and opens every project to it.
  await page.goto(`${web}/${slug}/settings/agents`);
  await page.getByRole("button", { name: translate("agents.newAgent"), exact: true }).click();
  await page.getByLabel(translate("agents.name")).fill("Helper Bot");
  await page.getByLabel(translate("agents.instructions")).fill("Rename things when asked.");
  await page.getByRole("button", { name: translate("agents.save") }).click();
  const card = page.locator('[data-agent="Helper Bot"]');
  await card.waitFor();
  await card.getByLabel(translate("agents.allProjects")).click();
  await page.waitForFunction(() => document.querySelector('[data-agent="Helper Bot"] input[type=checkbox]:checked') !== null);
  await card.locator("fieldset").filter({ hasText: translate("agents.allProjects") }).getByRole("button", { name: translate("agents.save") }).click();
  const ownerId = me.user.id;
  const daemonToken = await createApiTokenActions(db).createApiToken.handler({ userId: ownerId }, { name: "e2e daemon" });
  const runtimeActions = createRuntimeActions(db);
  const registered = await runtimeActions.registerDaemon.handler({ userId: ownerId, apiTokenId: daemonToken.id }, { hostname: "screenshot-runtime", version: "1", agentClis: ["codex"] });
  const runtime = registered.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: ownerId }, { runtimeId: runtime.id });
  const codeAgent = await createAgentActions(db).createAgent.handler({ userId: ownerId }, { workspaceId, name: "Code Helper", model: "default", runtimeId: runtime.id });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: ownerId }, { agentId: codeAgent.id, allProjects: true, projectIds: [] });
  // The Runtime owner can save replacement-only values without exposing the prior secret back into Agent data.
  await page.goto(`${web}/${slug}/settings/agents`);
  await page.getByText(translate("agents.runtimeEnvironment"), { exact: true }).waitFor();
  const environment = page.locator('[data-agent="Code Helper"]');
  await environment.getByLabel(translate("agents.environmentName")).first().fill("CLAUDE_CONFIG_DIR");
  await environment.getByLabel(translate("agents.environmentValue")).first().fill("/tmp/claude-profile");
  await environment.getByRole("button", { name: translate("agents.environmentAdd") }).click();
  await environment.getByLabel(translate("agents.environmentName")).nth(1).fill("ANTHROPIC_API_KEY");
  await environment.getByLabel(translate("agents.environmentValue")).nth(1).fill("fake-e2e-key");
  await environment.getByRole("button", { name: translate("agents.environmentAdd") }).click();
  await environment.getByLabel(translate("agents.environmentName")).nth(2).fill("MODE");
  await environment.getByLabel(translate("agents.environmentValue")).nth(2).fill("x");
  await environment.getByRole("button", { name: translate("agents.environmentSave") }).click();
  await environment.getByLabel(`MODE ${translate("agents.environmentClassification")}`).selectOption("non-secret");
  await environment.getByRole("button", { name: translate("agents.environmentSaveClassifications") }).click();
  if (await environment.getByLabel(`MODE ${translate("agents.environmentClassification")}`).inputValue() !== "non-secret") throw new Error("short environment value classification was not saved");
  const screenshotDir = Bun.env.RUNTIME_ENV_SCREENSHOTS;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await environment.locator("[data-runtime-environment]").scrollIntoViewIfNeeded();
    await Bun.write(`${screenshotDir}/desktop.png`, await page.screenshot());
    await page.setViewportSize({ width: 390, height: 844 });
    await environment.locator("[data-runtime-environment]").scrollIntoViewIfNeeded();
    await Bun.write(`${screenshotDir}/mobile.png`, await page.screenshot());
  }
  if ((await page.locator("body").innerText()).includes("fake-e2e-key")) throw new Error("saved environment value appeared in the page");
  await page.setViewportSize({ width: 1440, height: 900 });

  // A real workspace Member joins by invite, then creates an Agent on a Runtime owned by that Member.
  const invite = await call<{ token: string }>("create_invite", { workspaceId, role: "Member" });
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`${web}/invite/${invite.token}`);
  await memberPage.getByLabel(translate("auth.name")).fill("Runtime Member");
  await memberPage.getByLabel(translate("auth.email")).fill(`${slug}-member@example.test`);
  await memberPage.getByLabel(translate("auth.password"), { exact: true }).fill("another-secure-password");
  await memberPage.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("another-secure-password");
  await memberPage.getByRole("button", { name: translate("auth.signUp") }).click();
  await memberPage.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const memberMe = await (await memberPage.request.get(`${api}/api/me`)).json() as { user: { id: string } };
  const memberToken = await createApiTokenActions(db).createApiToken.handler({ userId: memberMe.user.id }, { name: "member daemon" });
  const memberRuntime = (await runtimeActions.registerDaemon.handler({ userId: memberMe.user.id, apiTokenId: memberToken.id }, { hostname: "member-owned-runtime", version: "1", agentClis: ["codex"] })).runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: memberMe.user.id }, { runtimeId: memberRuntime.id });
  await memberPage.goto(`${web}/${slug}/settings/agents`);
  await memberPage.getByRole("heading", { name: translate("agents.memberCreateTitle") }).waitFor();
  await memberPage.getByLabel(translate("agents.name")).fill("Member Code Helper");
  await memberPage.getByLabel(translate("agents.instructions")).fill("Work only on projects an Admin opens to this Agent.");
  await memberPage.getByLabel(translate("agents.model")).fill("default");
  await memberPage.getByLabel(translate("agents.runsOn")).selectOption(memberRuntime.id);
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await Bun.write(`${screenshotDir}/member-desktop.png`, await memberPage.screenshot());
    await memberPage.setViewportSize({ width: 390, height: 844 });
    await Bun.write(`${screenshotDir}/member-mobile.png`, await memberPage.screenshot());
  }
  await memberPage.getByRole("button", { name: translate("agents.create") }).click();
  await memberPage.getByText("Member Code Helper", { exact: true }).first().waitFor();
  const [createdMemberAgent] = await db.select({ id: agents.id, runtimeId: agents.runtimeId, createdBy: agents.createdBy, canWakeAgents: agents.canWakeAgents, allProjects: agents.allProjects }).from(agents).where(eq(agents.createdBy, memberMe.user.id));
  if (!createdMemberAgent || createdMemberAgent.runtimeId !== memberRuntime.id || createdMemberAgent.canWakeAgents || createdMemberAgent.allProjects) throw new Error("Member Agent was not created with its own Runtime and least-privilege defaults");
  const forbiddenUpdate = await memberPage.request.post(`${api}/actions/update_agent`, { data: { agentId: createdMemberAgent.id, name: "Escalated" } });
  if (forbiddenUpdate.status() !== 403) throw new Error("Member could mutate Agent configuration through the API");
  await memberContext.close();
  console.log("agents: admin creates an Agent and opens it to all projects");

  // Assign from the work item page: the Run shows its status and waits for the Originator's Confirmation.
  const first = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Original title" });
  const second = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Second job" });
  itemIds.push(first.id, second.id);
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const sidebar = page.getByRole("complementary", { name: translate("workItems.properties") });
  await sidebar.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) }).click();
  const agentOption = page.getByRole("menuitemcheckbox", { name: "Helper Bot Agent", exact: true });
  await agentOption.waitFor();
  await page.getByText("People", { exact: true }).waitFor();
  await page.getByText(translate("agents.group"), { exact: true }).waitFor();
  const codeOption = page.getByRole("menuitemcheckbox", { name: "Code Helper Agent Can edit code", exact: true });
  await codeOption.waitFor();
  await codeOption.hover();
  await codeOption.focus();
  // The picker puts the "Can edit code" badge on its own line inside the one option row (two lines, never clipped by the panel).
  const codeOptionBounds = await codeOption.boundingBox();
  const codePanelBounds = await page.locator("[data-popover-panel]").boundingBox();
  if (await codeOption.count() !== 1 || !codeOptionBounds || !codePanelBounds || codeOptionBounds.height > 72 || codeOptionBounds.x + codeOptionBounds.width > codePanelBounds.x + codePanelBounds.width + 1) throw new Error("code-capable Agent is not one picker row inside the panel");
  await codeOption.getByText(translate("agents.canEditCode")).waitFor();
  const desktopPanelScroll = await page.locator("[data-popover-panel]").evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  if (desktopPanelScroll.scrollWidth > desktopPanelScroll.clientWidth) throw new Error(`assignee picker scrolls sideways at 1440px: ${JSON.stringify(desktopPanelScroll)}`);
  if (Bun.env.AGENT_LABEL_SCREENSHOT) {
    await Bun.write(Bun.env.AGENT_LABEL_SCREENSHOT, await page.screenshot({ fullPage: true }));
    await page.evaluate(() => { localStorage.setItem("weft.theme", "dark"); document.documentElement.setAttribute("data-theme", "dark"); });
    await Bun.write(Bun.env.AGENT_LABEL_SCREENSHOT.replace(/\.png$/, "-dark.png"), await page.screenshot({ fullPage: true }));
    await page.evaluate(() => { localStorage.setItem("weft.theme", "light"); document.documentElement.setAttribute("data-theme", "light"); });
  }
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await sidebar.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) }).click();
  const pickerBounds = await page.locator("[data-popover-panel]").boundingBox();
  if (!pickerBounds || pickerBounds.x < 16 || pickerBounds.x + pickerBounds.width > 374) throw new Error("assignee picker escaped the phone viewport gutter");
  const phoneCodeOption = page.getByRole("menuitemcheckbox", { name: "Code Helper Agent Can edit code", exact: true });
  await phoneCodeOption.waitFor();
  const phoneCodeBounds = await phoneCodeOption.boundingBox();
  if (await phoneCodeOption.count() !== 1 || !phoneCodeBounds || phoneCodeBounds.height > 72) throw new Error("phone code-capable Agent is not one picker row");
  await phoneCodeOption.getByText(translate("agents.canEditCode")).waitFor();
  const phonePanelScroll = await page.locator("[data-popover-panel]").evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  if (phonePanelScroll.scrollWidth > phonePanelScroll.clientWidth) throw new Error(`assignee picker scrolls sideways at 390px: ${JSON.stringify(phonePanelScroll)}`);
  if (Bun.env.AGENT_LABEL_SCREENSHOT) {
    const phonePath = Bun.env.AGENT_LABEL_SCREENSHOT.replace(/\.png$/, "-390.png");
    await Bun.write(phonePath, await page.screenshot({ fullPage: true }));
    await page.evaluate(() => { localStorage.setItem("weft.theme", "dark"); document.documentElement.setAttribute("data-theme", "dark"); });
    await Bun.write(phonePath.replace(/\.png$/, "-dark.png"), await page.screenshot({ fullPage: true }));
    await page.evaluate(() => { localStorage.setItem("weft.theme", "light"); document.documentElement.setAttribute("data-theme", "light"); });
  }
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await sidebar.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) }).click();
  await agentOption.click();
  await page.keyboard.press("Escape");
  const panel = page.getByTestId("runs-panel");
  await panel.getByText(translate("runs.status.waiting_confirmation"), { exact: true }).waitFor({ timeout: 30_000 });
  console.log("agents: assigning shows the Run status and the pending Confirmation");

  // The Originator is notified, then approves from the work item.
  const inbox = await call<{ notifications: Array<{ kind: string }> }>("list_notifications", { workspaceId });
  if (!inbox.notifications.some((entry) => entry.kind === "run_confirmation")) throw new Error("no run_confirmation notification");
  await page.getByRole("button", { name: translate("ai.confirmAll") }).click();
  await panel.getByText(translate("runs.status.completed"), { exact: true }).waitFor({ timeout: 30_000 });
  const comment = page.locator('li[id^="comment-"]').filter({ has: page.locator("mark[data-agent-marker]") }).first();
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
  await panel2.getByRole("button", { name: translate("runs.rerun"), exact: true }).click();
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
