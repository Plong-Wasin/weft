// A work-item-free compatibility failure reaches its Originator's Inbox, opens the scheduled Run, and respects later Project access changes.
// All Runtime state is constructed with fake database rows and action calls; this flow never starts an Agent CLI.
import { check, launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { and, eq, like } from "drizzle-orm";
import { createDatabase, jobs, projectMembers, runs, users, workspaceMembers, workspaces } from "../packages/db/src";
import { createAgentActions, createAgentRuntimeEnvironmentActions, createApiTokenActions, createJobHandlers, createNotificationActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31240);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52240);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.SCHEDULED_CAPABILITY_SCREENSHOTS ?? "/home/plong/workspace/weft/.local/continuous-improvements/cli-compatibility";
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api, host: "127.0.0.1", env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true" } }),
];
const { client, db } = createDatabase();
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const slug = `cap-e2e-${suffix}`;
const adminEmail = `${slug}-admin@example.test`;
const memberEmail = `${slug}-member@example.test`;
let browser: import("playwright").Browser | undefined;
let failed = false;

async function signUp(page: import("playwright").Page, name: string, email: string) {
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill(name);
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
}

async function noHorizontalOverflow(page: import("playwright").Page, label: string) {
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label} overflows horizontally`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await Bun.$`mkdir -p ${shots}`;
  browser = await launchBrowser();

  const adminContext = await newContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const adminPage = await adminContext.newPage();
  await signUp(adminPage, "Compatibility Admin", adminEmail);
  await adminPage.getByLabel(translate("workspace.name")).fill("Compatibility E2E");
  await adminPage.getByLabel(translate("workspace.slug")).fill(slug);
  await adminPage.getByRole("button", { name: translate("workspace.create") }).click();
  await adminPage.waitForURL(`${web}/${slug}`);
  await adminPage.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await adminPage.getByLabel(translate("projects.name")).fill("Private Project");
  await adminPage.getByLabel(translate("projects.key"), { exact: true }).fill("PRV");
  await adminPage.getByLabel(translate("projects.visibility")).selectOption("private");
  await adminPage.getByRole("button", { name: translate("projects.create") }).click();
  await adminPage.getByRole("link", { name: /PRV · Private Project/ }).waitFor();

  const adminIdentity = await (await adminPage.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspace = adminIdentity.workspaces.find((row) => row.slug === slug)!;
  const project = await createProjectActions(db).getProject.handler({ userId: adminIdentity.user.id }, { workspaceId: workspace.id, key: "PRV" });

  // Create a real signed-in, non-admin Originator so project access can be revoked after the successful navigation.
  const memberContext = await newContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await memberContext.newPage();
  const memberSignUp = await page.request.post(`${api}/api/auth/sign-up/email`, { data: { name: "Compatibility Member", email: memberEmail, password: "a-secure-password" } });
  check(memberSignUp.ok(), `could not create the non-admin Originator (${memberSignUp.status()}: ${await memberSignUp.text()})`);
  const memberIdentity = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string } };
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: memberIdentity.user.id, role: "Member" });
  await db.insert(projectMembers).values({ workspaceId: workspace.id, projectId: project.id, userId: memberIdentity.user.id, role: "Member" });

  const ownerId = adminIdentity.user.id;
  await db.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const token = await createApiTokenActions(db).createApiToken.handler({ userId: ownerId }, { name: "compatibility fixture" });
  const registered = await createRuntimeActions(db).registerDaemon.handler({ userId: ownerId, apiTokenId: token.id }, { hostname: `legacy-${suffix}`, version: "1.0.0", agentClis: ["codex"] });
  const runtime = registered.runtimes[0]!;
  await createRuntimeActions(db).shareRuntime.handler({ userId: ownerId }, { runtimeId: runtime.id });
  const agent = await createAgentActions(db).createAgent.handler({ userId: ownerId }, { workspaceId: workspace.id, name: "Scheduled Agent", model: "default", runtimeId: runtime.id });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: ownerId }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
  await createAgentRuntimeEnvironmentActions(db).setAgentRuntimeEnvironment.handler({ userId: ownerId }, { agentId: agent.id, variables: { COMPATIBILITY_SECRET: "must-never-appear-in-notice" } });
  const [run] = await db.insert(runs).values({ workspaceId: workspace.id, projectId: project.id, workItemId: null, agentId: agent.id, originatorId: memberIdentity.user.id }).returning();

  const claimed = await createRuntimeDispatchActions(db).claimRuns({ userId: ownerId, daemonId: registered.daemonId }, 1);
  check(claimed.length === 0, "legacy Runtime received a configured-environment Run");
  check((await createRuntimeDispatchActions(db).claimRuns({ userId: ownerId, daemonId: registered.daemonId }, 1)).length === 0, "a repeated claim changed the failed scheduled Run");
  const failure = (await db.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, run!.id)))[0];
  check(failure?.status === "failed" && failure.failureReason === "runtime_capability_missing", `scheduled Run did not fail safely: ${JSON.stringify(failure)}`);
  const capabilityNoticeJobs = (await db.select().from(jobs).where(eq(jobs.type, "notify"))).filter((job) => {
    const payload = job.payload as { kind?: string; runId?: string };
    return payload.kind === "run_skipped" && payload.runId === run!.id;
  });
  check(capabilityNoticeJobs.length === 1, `expected one Inbox notice after repeated claims, found ${capabilityNoticeJobs.length}`);
  const noticeJob = capabilityNoticeJobs[0]!;
  const payload = noticeJob!.payload as { kind: string; runId?: string; recipientIds: string[]; detail?: string };
  check(payload.runId === run!.id && payload.recipientIds.includes(memberIdentity.user.id) && payload.detail === "runtime_capability_missing", "scheduled failure notice is missing its Run destination or safe reason");
  check(!JSON.stringify(payload).includes("must-never-appear-in-notice"), "configured secret leaked into the notice payload");
  await createJobHandlers().notify!(db, noticeJob!.payload, { id: noticeJob!.id, type: "notify" });
  const inboxFixture = await (await page.request.post(`${api}/actions/list_notifications`, { data: { workspaceId: workspace.id } })).json() as { notifications: Array<{ id: string; runId: string | null }> };
  const notificationId = inboxFixture.notifications.find((notification) => notification.runId === run!.id)?.id;
  check(Boolean(notificationId), "scheduled Run notice was not listed for its Originator");

  await page.goto(`${web}/${slug}/notifications`);
  // The whole Inbox row is the link, so its name holds the sentence and date around the Run label.
  const openRun = page.getByRole("link", { name: translate("inbox.openScheduledRun") });
  await openRun.waitFor();
  await noHorizontalOverflow(page, "desktop Inbox");
  await saveShot(page, { path: `${shots}/scheduled-inbox-1440.png`, fullPage: true });
  // On a wide screen the row selects a summary; its Open link leads to the Run.
  await openRun.click();
  await page.getByRole("link", { name: translate("inbox.open"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/runs/${run!.id}`);
  await page.getByRole("heading", { name: translate("runs.scheduled"), exact: true }).waitFor();
  await page.getByText(translate("runs.failure.runtime_capability_missing"), { exact: true }).waitFor();
  await page.waitForURL((url) => !url.searchParams.has("inboxNotificationId"));
  await noHorizontalOverflow(page, "desktop scheduled Run detail");
  await saveShot(page, { path: `${shots}/scheduled-run-1440.png`, fullPage: true });

  await page.request.post(`${api}/actions/mark_notification_unread`, { data: { notificationId } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/notifications`);
  await openRun.waitFor();
  await noHorizontalOverflow(page, "mobile Inbox");
  await saveShot(page, { path: `${shots}/scheduled-inbox-390.png`, fullPage: true });
  await openRun.click();
  await page.waitForURL(`${web}/${slug}/runs/${run!.id}`);
  await page.getByText(translate("runs.failure.runtime_capability_missing"), { exact: true }).waitFor();
  await noHorizontalOverflow(page, "mobile scheduled Run detail");
  await saveShot(page, { path: `${shots}/scheduled-run-390.png`, fullPage: true });

  // Losing private Project access hides the notification and makes the direct destination fail closed.
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, memberIdentity.user.id)));
  const denied = await page.request.post(`${api}/actions/get_run`, { data: { runId: run!.id } });
  check(denied.status() === 404, `revoked Project member could still read the scheduled Run (${denied.status()})`);
  await page.reload();
  await page.getByText(translate("runs.scheduledUnavailable"), { exact: true }).waitFor();
  await page.goto(`${web}/${slug}/notifications`);
  await page.getByText(translate("inbox.empty")).waitFor();
  check(await openRun.count() === 0, "Inbox exposed a scheduled Run after Project access was revoked");
  check((await createNotificationActions(db).listNotifications.handler({ userId: memberIdentity.user.id }, { workspaceId: workspace.id })).notifications.length === 0, "permission-filtered Inbox still returned the scheduled notice");

  console.log(`scheduled capability notification: inbox → run detail and revoked Project access verified; screenshots: ${shots}`);
  await memberContext.close();
  await adminContext.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  for (const server of servers) { server.kill(); await server.exited; }
  await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await db.delete(users).where(like(users.email, `${slug}-%@example.test`));
  await client.end();
}
process.exit(failed ? 1 : 0);
