// A browser flow for the two Runtime comment paths on one Work item: a Run-token comment and a completion comment.
// It verifies the visible Agent marker, Run links and Originator provenance, then captures desktop and phone screenshots.
import { launchBrowser, newPage, startApi, startWeb, waitFor } from "./harness";
import { mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions,
  createRuntimeDispatchActions, createWorkItemActions, queueRunsForAssignees,
} from "../packages/actions/src";
import { createDatabase, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31287);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 51287);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const screenshots = Bun.env.RUNTIME_COMMENT_SCREENSHOTS ?? "/home/plong/workspace/weft/.local/ai-ux-reliability/08-agent-comment-attribution";
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];
const { client, db } = createDatabase();
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  mkdirSync(screenshots, { recursive: true });
  browser = await launchBrowser();
  const page = await newPage(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const slug = `agent-comments-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Browser Originator");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword", "en")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Runtime comment review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded", timeout: 8000 });

  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string; name: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const originatorId = me.user.id;
  await db.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspaceId));

  const project = await createProjectActions(db).createProject.handler({ userId: originatorId }, { workspaceId, name: "Reviews", key: "REV", visibility: "private" });
  const daemonCredential = await createApiTokenActions(db).createApiToken.handler({ userId: originatorId }, { name: "browser Runtime" });
  const runtimeActions = createRuntimeActions(db);
  const registered = await runtimeActions.registerDaemon.handler({ userId: originatorId, apiTokenId: daemonCredential.id }, { hostname: "comment-review", version: "1", agentClis: ["claude"] });
  const runtime = registered.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: originatorId }, { runtimeId: runtime.id });
  const agent = await createAgentActions(db).createAgent.handler({ userId: originatorId }, { workspaceId, name: "Runtime Reviewer", model: "default", runtimeId: runtime.id });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: originatorId }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const item = await createWorkItemActions(db).createWorkItem.handler({ userId: originatorId }, { projectId: project.id, title: "Check Runtime comment attribution", assigneeIds: [agent.userId] });
  const dispatch = createRuntimeDispatchActions(db);
  const claim = async () => {
    const [run] = await dispatch.claimRuns({ userId: originatorId, daemonId: registered.daemonId }, 20);
    if (!run) throw new Error("Runtime did not claim the queued Run");
    await dispatch.startRun(run.runId, runtime.id);
    return run;
  };

  const completionRun = await claim();
  await dispatch.finishRun(completionRun.runId, { status: "completed", finalOutput: "Completion path attribution is visible." });
  await queueRunsForAssignees(db, { originatorId, project: { id: project.id, workspaceId }, workItemId: item.id, assigneeUserIds: [agent.userId] });
  const credentialRun = await claim();
  const response = await page.request.post(`${api}/actions/create_comment`, {
    headers: { authorization: `Bearer ${credentialRun.token}` },
    data: { workItemId: item.id, bodyMarkdown: "Run credential attribution is visible." },
  });
  if (!response.ok()) throw new Error(`Run-token comment failed: ${response.status()} ${await response.text()}`);
  const update = await page.request.post(`${api}/actions/update_work_item`, {
    headers: { authorization: `Bearer ${credentialRun.token}` },
    data: { workItemId: item.id, priority: "high" },
  });
  if (!update.ok()) throw new Error(`Run-token Work item update failed: ${update.status()} ${await update.text()}`);
  await dispatch.finishRun(credentialRun.runId, { status: "completed", finalOutput: "" });

  const detailUrl = `${web}/${slug}/browse/REV-1`;
  await page.goto(detailUrl);
  await page.getByText("Completion path attribution is visible.").waitFor();
  await page.getByText("Run credential attribution is visible.").waitFor();
  const comments = page.locator("[id^='comment-']").filter({ hasText: "attribution is visible" });
  if (await comments.count() !== 2) throw new Error(`expected two Runtime comments in the timeline, found ${await comments.count()}`);
  if (await comments.locator("[data-agent-marker]").count() !== 2) throw new Error("both Runtime comments do not display the Agent marker");
  if (await comments.getByRole("link", { name: translate("comments.viewRun") }).count() !== 2) throw new Error("both Runtime comments do not link to their Runs");
  await page.getByLabel(translate("timeline.filter")).selectOption("all");
  await page.getByRole("button", { name: translate("timeline.showAllChanges") }).click();
  const timelineResponse = await page.request.post(`${api}/actions/list_timeline`, { data: { workItemId: item.id, filter: "all", sort: "oldest" } });
  const timeline = await timelineResponse.json() as Array<{ activity: { source: string; originatorName: string | null } | null }>;
  if (!timeline.some(({ activity }) => activity?.source === "agent_autopilot" && activity.originatorName === me.user.name)) throw new Error("Run Activity does not retain the Originator provenance");
  await page.getByText(new RegExp(`run for ${me.user.name}`), { exact: false }).first().waitFor();
  if (await page.getByText(new RegExp(`run for ${me.user.name}`), { exact: false }).count() < 1) throw new Error("Run Activity does not show the Originator provenance in the UI");
  console.log(`runtime-comment-attribution: both comments show ${agent.name}, Agent marker and View run; timeline shows Originator ${me.user.name}`);

  const timelineHeading = page.getByRole("heading", { name: translate("timeline.title") });
  await timelineHeading.scrollIntoViewIfNeeded();
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await timelineHeading.scrollIntoViewIfNeeded();
    await page.locator("[id^='comment-']").filter({ hasText: "Run credential attribution is visible." }).scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 260);
    const evidence = await page.evaluate(() => ({
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      markers: [...document.querySelectorAll("[id^='comment-'] [data-agent-marker]")].map((node) => {
        const box = node.getBoundingClientRect(); return { text: node.textContent?.trim(), left: box.left, right: box.right };
      }),
      origins: [...document.querySelectorAll("li")].map((node) => node.textContent ?? "").filter((text) => text.includes("run for Browser Originator")),
    }));
    if (evidence.markers.length !== 2 || evidence.markers.some((marker) => marker.left < 0 || marker.right > width)) throw new Error(`Agent markers are clipped at ${width}px: ${JSON.stringify(evidence)}`);
    if (evidence.pageWidth > width || evidence.origins.length < 1) throw new Error(`timeline provenance/layout failed at ${width}px: ${JSON.stringify(evidence)}`);
    const path = `${screenshots}/runtime-agent-comments-${width}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`screenshot ${path}`);
  }
  console.log("e2e runtime-comment-attribution: ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  servers.forEach((server) => server.kill());
  await client.end();
}
process.exit(failed ? 1 : 0);
