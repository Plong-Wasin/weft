// Browser flow for the Runtimes page: an offline Runtime with a bound Agent and a waiting Run shows how long it has been offline, its Agent, the waiting Run count with
// an explanation, and its Session folders (behind a disclosure, with the path pattern). Offline Runtimes are listed by how long they were offline. The page is checked
// at desktop and phone width. The Runs are driven through the same actions the Daemon calls, so no CLI is started. Screenshots go to RUNTIME_USAGE_SCREENSHOTS
// (default /tmp/weft-runtime-usage-e2e). Run with `bun e2e/run-all.ts runtime-usage`.
import { chromium, type Page } from "playwright";
import { eq } from "drizzle-orm";
import { createDatabase, runtimes, workspaces } from "../packages/db/src";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31192);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52192);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const screenshots = Bun.env.RUNTIME_USAGE_SCREENSHOTS ?? "/tmp/weft-runtime-usage-e2e";
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

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

let failed = false;
const { client, db } = createDatabase();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await Bun.$`mkdir -p ${screenshots}`;
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page: Page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Usage Tester");
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E usage");
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
  await db.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspaceId));
  const [project] = (await createProjectActions(db).listProjects.handler({ userId: ownerId }, { workspaceId })).filter((row) => row.key === "MOB");
  const projectId = project!.id;

  // The Daemon's Claude Runtime, shared, with a Coder Agent bound to it.
  const runtimeActions = createRuntimeActions(db);
  const dispatch = createRuntimeDispatchActions(db);
  const tokenFor = async (name: string) => (await createApiTokenActions(db).createApiToken.handler({ userId: ownerId }, { name })).id;
  const registered = await runtimeActions.registerDaemon.handler({ userId: ownerId, apiTokenId: await tokenFor("usage daemon") }, { hostname: "usage-mint", version: "1", agentClis: ["claude"] });
  const runtime = registered.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: ownerId }, { runtimeId: runtime.id });
  const coder = await createAgentActions(db).createAgent.handler({ userId: ownerId }, { workspaceId, name: "Coder", model: "default", runtimeId: runtime.id });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: ownerId }, { agentId: coder.id, allProjects: true, projectIds: [] });
  // A second, older Runtime of the same person: it has been offline five days and has no Agent, so it must be listed first.
  const older = await runtimeActions.registerDaemon.handler({ userId: ownerId, apiTokenId: await tokenFor("older daemon") }, { hostname: "older-box", version: "1", agentClis: ["codex"] });
  await db.update(runtimes).set({ lastSeenAt: new Date(Date.now() - 5 * 24 * 3600_000) }).where(eq(runtimes.id, older.runtimes[0]!.id));

  // Round one runs while the Runtime is online and leaves a Session folder behind.
  const createItem = (title: string) => createWorkItemActions(db).createWorkItem.handler({ userId: ownerId }, { projectId, title, assigneeIds: [coder.userId] });
  await createItem("Export button");
  const [claimed] = await dispatch.claimRuns({ userId: ownerId, daemonId: registered.daemonId }, 20);
  if (!claimed?.session) throw new Error("the first Run was not claimed");
  await dispatch.startRun(claimed.runId, runtime.id, { mode: "new", reason: "first" });
  await dispatch.finishRun(claimed.runId, { status: "completed", finalOutput: "Added the export button.", session: { id: "sess-usage-1", mode: "new", reason: "first" } });
  const folder = claimed.session.folder;

  // Round two is queued for the Agent and then the Runtime goes offline three hours ago: this Run waits for it.
  await createItem("Import button");
  await db.update(runtimes).set({ lastSeenAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(runtimes.id, runtime.id));

  await page.goto(`${web}/${slug}/settings/runtimes`);
  const card = page.locator("li", { hasText: "usage-mint" }).first();
  await card.waitFor();
  const cardText = await card.innerText();
  check(/Offline for 3 h/.test(cardText), `offline duration missing: ${cardText}`);
  check(cardText.includes(translate("runtimes.boundAgents").replace("{names}", "Coder")), `bound Agent missing: ${cardText}`);
  check(cardText.includes(translate("runtimes.waitingRuns").replace("{count}", "1")), `waiting Run count missing: ${cardText}`);
  check(cardText.includes(translate("runtimes.waitingRunsHelp")), `waiting Run explanation missing: ${cardText}`);
  console.log("runtime-usage: the offline Runtime shows its offline time, its Coder Agent and one waiting Run, with the explanation");

  // Offline Runtimes are listed by how long they were offline: the five-day one above the three-hour one.
  const order = await Promise.all([page.locator("li", { hasText: "older-box" }).first().boundingBox(), card.boundingBox()]);
  check(order[0] !== null && order[1] !== null && order[0].y < order[1].y, "the Runtime offline longest is not listed first");
  console.log("runtime-usage: older-box (five days offline) is listed above usage-mint (three hours)");

  // The Session folders sit behind a disclosure: opened, they show the folder id, the work item and the last-used time, and the path pattern.
  await card.getByText(translate("runtimes.sessionFolders").replace("{count}", "1")).click();
  const folderLine = card.getByText(folder, { exact: true });
  await folderLine.waitFor();
  const openedText = await card.innerText();
  check(openedText.includes("MOB-1 · Export button"), `work item of the folder missing: ${openedText}`);
  check(openedText.includes(translate("runtimes.sessionFoldersHelp")), "the path pattern is not explained");
  console.log(`runtime-usage: the Session folder ${folder} shows its work item, last-used time and the path pattern`);

  // Layout at desktop and phone width: no sideways scrolling and the card stays inside the viewport.
  const fits = async (width: number) => ({ ...await page.evaluate(() => {
    const node = [...document.querySelectorAll("li")].find((item) => item.textContent?.includes("usage-mint"));
    const box = node?.getBoundingClientRect();
    return { noOverflow: document.documentElement.scrollWidth <= window.innerWidth, inside: !!box && box.left >= 0 && box.right <= window.innerWidth };
  }), width });
  const desktop = await fits(1440);
  await Bun.write(`${screenshots}/runtimes-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator("li", { hasText: "usage-mint" }).first().waitFor();
  await page.locator("li", { hasText: "usage-mint" }).first().getByText(translate("runtimes.sessionFolders").replace("{count}", "1")).click();
  await page.locator("li", { hasText: "usage-mint" }).first().getByText(folder, { exact: true }).waitFor();
  const phone = await fits(390);
  await Bun.write(`${screenshots}/runtimes-390.png`, await page.screenshot({ fullPage: true }));
  check(desktop.noOverflow && desktop.inside, `layout at 1440 px: ${JSON.stringify(desktop)}`);
  check(phone.noOverflow && phone.inside, `layout at 390 px: ${JSON.stringify(phone)}`);
  console.log("runtime-usage: no sideways scroll, and the card fits, at 1440 and 390 px");

  await browser.close();
  console.log("runtime-usage: passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  await client.end();
}
process.exit(failed ? 1 : 0);
