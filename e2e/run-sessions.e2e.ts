// Browser flow for the Run cards of one work item after a Runtime round trip: each card states whether its Run resumed the CLI Session or started a new one
// and why, and a failed Run offers "Rerun as new session". The Runs are driven through the same dispatch actions the Daemon calls over HTTP, so no CLI
// is started. Screenshots of the work item's Runs panel at desktop and phone width go to RUN_SESSION_SCREENSHOTS (default /tmp/weft-run-sessions-e2e).
// Run with `bun e2e/run-sessions.e2e.ts`.
import { chromium, type Page } from "playwright";
import { eq, inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createApiTokenActions, createRuntimeActions, createRuntimeDispatchActions, queueRunsForAssignees } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31191);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52191);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const screenshots = Bun.env.RUN_SESSION_SCREENSHOTS ?? "/tmp/weft-run-sessions-e2e";
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
const { client, db } = createDatabase();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await Bun.$`mkdir -p ${screenshots}`;
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Session Tester");
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E sessions");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const ownerId = me.user.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  // Runtime Runs need the workspace's Autopilot switch; the flow turns it on the way an Admin would through the database seam.
  await db.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspaceId));

  // A shared Claude Runtime and a Coder Agent on it, opened to the project.
  const daemonToken = await createApiTokenActions(db).createApiToken.handler({ userId: ownerId }, { name: "e2e daemon" });
  const runtimeActions = createRuntimeActions(db);
  const registered = await runtimeActions.registerDaemon.handler({ userId: ownerId, apiTokenId: daemonToken.id }, { hostname: "session-runtime", version: "1", agentClis: ["claude"] });
  const runtime = registered.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: ownerId }, { runtimeId: runtime.id });
  const coder = await createAgentActions(db).createAgent.handler({ userId: ownerId }, { workspaceId, name: "Coder", model: "default", runtimeId: runtime.id });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: ownerId }, { agentId: coder.id, allProjects: true, projectIds: [] });
  const item = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Add export button" });
  const dispatch = createRuntimeDispatchActions(db);
  const queueRound = () => queueRunsForAssignees(db, { originatorId: ownerId, project: { id: project.id, workspaceId }, workItemId: item.id, assigneeUserIds: [coder.userId] });
  const claimNext = async (runtimeId: string) => {
    const [claimed] = (await dispatch.claimRuns({ userId: ownerId, daemonId: registered.daemonId }, 20)).filter((row) => row.workItemId === item.id);
    if (!claimed) throw new Error("no Run was claimed for the work item");
    await dispatch.startRun(claimed.runId, runtimeId, { mode: claimed.session?.resumeSessionId ? "resumed" : "new", reason: claimed.session?.reason ?? "first" });
    return claimed;
  };

  // Round one completes and reports its Session; round two resumes it and fails; the person reruns round two as new.
  await queueRound();
  const round1 = await claimNext(runtime.id);
  await dispatch.finishRun(round1.runId, { status: "completed", finalOutput: "Added the export button.", session: { id: "sess-round-1", mode: "new", reason: "first" } });
  await queueRound();
  const round2 = await claimNext(runtime.id);
  await dispatch.finishRun(round2.runId, { status: "failed", finalOutput: "The CLI exited with code 1.", failureReason: "cli_exit", session: { id: null, mode: "resumed", reason: "resumed" } });

  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const panel = page.getByTestId("runs-panel");
  await panel.getByText(translate("runs.status.failed"), { exact: true }).waitFor();
  const sessionLines = panel.getByTestId("run-session");
  await sessionLines.first().waitFor();
  const texts = await sessionLines.allInnerTexts();
  if (texts.length !== 2) throw new Error(`expected two session lines, got ${texts.length}`);
  if (!texts.includes(translate("runs.session.resumed")) || !texts.some((text) => text.includes(translate("runs.session.new")) && text.includes(translate("runs.session.reason.first")))) {
    throw new Error(`session lines do not match the flow: ${JSON.stringify(texts)}`);
  }
  console.log("run-sessions: both Runs show their Session: resumed, and new (first Run)");

  await panel.getByRole("button", { name: translate("runs.rerunNewSession") }).click();
  await panel.locator('[data-run-status="queued"]').waitFor();
  const round3 = await claimNext(runtime.id);
  await dispatch.finishRun(round3.runId, { status: "completed", finalOutput: "Export button done in a fresh Session.", session: { id: "sess-round-3", mode: "new", reason: "rerun_as_new" } });
  await page.reload();
  // Round one and the rerun are both completed now: wait for the second completed card.
  await panel.locator('[data-run-status="completed"]').nth(1).waitFor();
  const lines = await panel.getByTestId("run-session").allInnerTexts();
  if (lines.length !== 3 || lines.filter((text) => text.includes(translate("runs.session.reason.rerun_as_new"))).length !== 1) throw new Error(`expected one rerun-as-new line among three: ${JSON.stringify(lines)}`);
  console.log(`run-sessions: rerun as new shows "${lines.find((text) => text.includes(translate("runs.session.reason.rerun_as_new")))}"`);

  // Layout: each session line sits inside the viewport gutter, and the page does not scroll sideways.
  const fits = async (width: number) => page.evaluate(() => {
    const lines = [...document.querySelectorAll('[data-testid="run-session"]')].map((node) => node.getBoundingClientRect());
    return { noOverflow: document.documentElement.scrollWidth <= window.innerWidth, inside: lines.every((box) => box.left >= 0 && box.right <= window.innerWidth) };
  });
  const desktop = await fits(1440);
  await panel.scrollIntoViewIfNeeded();
  await Bun.write(`${screenshots}/runs-panel-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await panel.scrollIntoViewIfNeeded();
  const phone = await fits(390);
  await Bun.write(`${screenshots}/runs-panel-390.png`, await page.screenshot({ fullPage: true }));
  if (!desktop.noOverflow || !desktop.inside || !phone.noOverflow || !phone.inside) throw new Error(`session line overflows: desktop ${JSON.stringify(desktop)} phone ${JSON.stringify(phone)}`);
  console.log(`run-sessions: screenshots in ${screenshots}`);

  console.log("e2e run-sessions: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  // Jobs this flow queued must not linger for other test runs; bot users are removed with their workspace.
  const mine = await db.select({ id: workspaces.id }).from(workspaces).where(like(workspaces.slug, "e2e-%"));
  const bots = mine.length === 0 ? [] : await db.select({ userId: agents.userId }).from(agents).where(inArray(agents.workspaceId, mine.map((row) => row.id)));
  await db.delete(jobs);
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  if (bots.length > 0) await db.delete(users).where(inArray(users.id, bots.map((row) => row.userId)));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
