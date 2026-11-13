import { chromium } from "playwright";
import { inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31181);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52181);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const webBuild = Bun.spawnSync(["node", "node_modules/vite/bin/vite.js", "build"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "inherit", stderr: "inherit" });
if (webBuild.exitCode !== 0) throw new Error("Could not build the web app for the Agent access browser flow");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["node", "node_modules/vite/bin/vite.js", "preview", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];
async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}
async function signup(page: import("playwright").Page, name: string, email: string, invite?: string, slug?: string) {
  await page.goto(invite ?? web);
  if (!invite) await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill(name);
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  if (slug) {
    await page.getByLabel(translate("workspace.name")).fill("Agent access E2E");
    await page.getByLabel(translate("workspace.slug")).fill(slug);
    await page.getByRole("button", { name: translate("workspace.create") }).click();
  }
}
let failed = false;
const { client, db } = createDatabase();
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const admin = await adminContext.newPage();
  const slug = `agacc-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 12)}`;
  const adminEmail = `${slug}-admin@example.test`;
  await signup(admin, "Workspace Admin", adminEmail, undefined, slug);
  try { await admin.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded", timeout: 8000 }); }
  catch { throw new Error(`workspace onboarding stayed at ${admin.url()}: ${(await admin.locator("body").innerText()).slice(0, 1200)}`); }
  const request = async <T>(page: import("playwright").Page, name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    const payload = await response.json();
    if (!response.ok()) throw new Error(`${name}: ${JSON.stringify(payload)}`);
    return payload as T;
  };
  const me = await (await admin.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((entry) => entry.slug === slug)!.id;
  const projects = createProjectActions(db);
  const project = await projects.createProject.handler({ userId: me.user.id }, { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  const invite = async (name: string, suffix: string) => {
    const created = await request<{ token: string }>(admin, "create_invite", { workspaceId, role: "Member" });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    const page = await context.newPage();
    await signup(page, name, `${slug}-${suffix}@example.test`, `${web}/invite/${created.token}`);
    await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
    const userId = (await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string } }).user.id;
    await projects.addProjectMember.handler({ userId: me.user.id }, { projectId: project.id, userId, role: "Member" });
    return { context, page, userId };
  };
  const owner = await invite("Runtime Owner", "owner");
  const token = await createApiTokenActions(db).createApiToken.handler({ userId: owner.userId }, { name: "E2E Runtime" });
  const runtimeActions = createRuntimeActions(db);
  const registered = await runtimeActions.registerDaemon.handler({ userId: owner.userId, apiTokenId: token.id }, { hostname: "access-e2e", version: "1", agentClis: ["codex"] });
  const runtime = registered.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: owner.userId }, { runtimeId: runtime.id });
  const runtimeProfile = await runtimeActions.createRuntimeProfile.handler({ userId: owner.userId }, { runtimeId: runtime.id, name: "Run folder only", sandbox: "run-folder", filesystemAllowlist: [], networkAllowlist: ["gitlab.example"] });
  await runtimeActions.setRuntimeSandboxEnforcement.handler({ userId: owner.userId }, { runtimeId: runtime.id, enforceSandbox: true });
  const profileEditAsAdmin = await runtimeActions.updateRuntimeProfile.handler({ userId: me.user.id }, { profileId: runtimeProfile.id, name: "Weakened", sandbox: "full", filesystemAllowlist: [], networkAllowlist: [] }).then(() => false, () => true);
  if (!profileEditAsAdmin) throw new Error("Workspace Admin changed a Runtime owner's profile");
  const codeAgent = await createAgentActions(db).createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Code Helper", model: "default", runtimeId: runtime.id });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: codeAgent.id, allProjects: true, projectIds: [] });
  const item = await request<{ id: string }>(admin, "create_work_item", { projectId: project.id, title: "Review access" });

  const pm = await invite("PM", "pm");
  const developer = await invite("Developer", "developer");
  const itemUrl = `${web}/${slug}/browse/MOB-1`;
  await pm.page.goto(itemUrl);
  await pm.page.getByRole("textbox", { name: translate("workItems.titleField") }).waitFor();
  const pmAssignees = pm.page.getByRole("complementary", { name: translate("workItems.properties") }).getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) });
  await pmAssignees.click();
  const unavailable = pm.page.getByRole("menuitemcheckbox", { name: /Code Helper Agent Can edit code needs permission from Runtime Owner/ });
  await unavailable.waitFor();
  if (await unavailable.getAttribute("aria-disabled") !== "true" || await unavailable.getAttribute("aria-checked") !== "false") throw new Error("PM picker did not mark the Code-capable Agent unavailable");
  await unavailable.click({ force: true });
  if (await unavailable.getAttribute("aria-checked") !== "false") throw new Error("PM selected unavailable Agent with the mouse");
  await unavailable.focus(); await pm.page.keyboard.press("Enter");
  if (await unavailable.getAttribute("aria-checked") !== "false") throw new Error("PM selected unavailable Agent with the keyboard");
  console.log("agent-access: PM sees reason and cannot select Agent by mouse or keyboard");

  const evidenceDir = Bun.env.AGENT_ACCESS_SCREENSHOTS ?? "/tmp/claude-1000/-home-plong-orca-workspaces-weft-spurdog/4ede5172-06b6-4421-a1f0-57b9ca12a25c/scratchpad/ship-agent-safety-and-comment-ux/ticket-22";
  await Bun.$`mkdir -p ${evidenceDir}`;
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 900 }, { width: 390, height: 844 }]) {
    await pm.page.setViewportSize(viewport);
    await pmAssignees.scrollIntoViewIfNeeded();
    await unavailable.scrollIntoViewIfNeeded();
    for (const theme of ["light", "dark"] as const) {
      await pm.page.evaluate((value) => { localStorage.setItem("weft.theme", value); document.documentElement.setAttribute("data-theme", value); }, theme);
      await Bun.write(`${evidenceDir}/pm-picker-${viewport.width}-${theme}.png`, await pm.page.screenshot());
    }
  }
  await pm.page.keyboard.press("Escape");

  // The non-admin Runtime owner grants the developer through Agent settings.
  await owner.page.goto(`${web}/${slug}/settings/runtimes`);
  await owner.page.getByText(translate("runtimes.profiles"), { exact: true }).first().waitFor();
  // The owner's profile stays "Run folder only"; the Admin's rename to "Weakened" (full access) was refused above.
  await owner.page.getByText("Run folder only", { exact: false }).first().waitFor();
  if (await owner.page.getByText("Weakened", { exact: false }).count()) throw new Error("Admin's profile change reached the Runtime owner's page");
  // Ticket 22: every full profile carries the full-access warning; the warning sits inside the profile row text.
  await owner.page.getByText(translate("runtimes.fullAccessWarning"), { exact: false }).first().waitFor();
  await owner.page.getByLabel(translate("runtimes.enforceSandbox")).waitFor();
  await owner.page.setViewportSize({ width: 1440, height: 900 });
  await Bun.write(`${evidenceDir}/runtime-profiles-settings.png`, await owner.page.screenshot({ fullPage: true }));

  await owner.page.goto(`${web}/${slug}/settings/agents`);
  await owner.page.getByText("Code Helper", { exact: true }).waitFor();
  const memberIds = await request<Array<{ userId: string; name: string }>>(admin, "list_members", { workspaceId });
  const developerId = memberIds.find((member) => member.name === "Developer")!.userId;
  await developer.page.goto(itemUrl);
  const developerAssignees = developer.page.getByRole("complementary", { name: translate("workItems.properties") }).getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) });
  await developerAssignees.click();
  const developerUnavailable = developer.page.getByRole("menuitemcheckbox", { name: /Code Helper Agent Can edit code needs permission from Runtime Owner/ });
  await developerUnavailable.waitFor();
  await developer.page.keyboard.press("Escape");
  const developerGrant = owner.page.getByLabel(`${translate("agents.mayUse")} Developer`);
  const ownerGrants = async () => (await createAgentActions(db).listManageableAgentAccess.handler({ userId: owner.userId }, { workspaceId })).find((agent) => agent.id === codeAgent.id)?.accessUserIds ?? [];
  await developerGrant.click({ force: true });
  for (let attempt = 0; attempt < 50 && !(await ownerGrants()).includes(developerId); attempt += 1) await Bun.sleep(100);
  if (!(await ownerGrants()).includes(developerId)) throw new Error(`Runtime owner access checkbox did not grant access: ${await owner.page.locator('[role="status"]').allTextContents()}`);
  await developerGrant.click({ force: true });
  for (let attempt = 0; attempt < 50 && (await ownerGrants()).includes(developerId); attempt += 1) await Bun.sleep(100);
  if ((await ownerGrants()).includes(developerId)) throw new Error("Runtime owner could not remove Developer access");
  await developerGrant.click({ force: true });
  for (let attempt = 0; attempt < 50 && !(await ownerGrants()).includes(developerId); attempt += 1) await Bun.sleep(100);
  if (!(await ownerGrants()).includes(developerId)) throw new Error("Runtime owner could not grant Developer access again");
  await developer.page.bringToFront();
  await developerAssignees.click();
  const available = developer.page.getByRole("menuitemcheckbox", { name: "Code Helper Agent Can edit code", exact: true });
  await available.waitFor();
  if (await available.getAttribute("aria-disabled") === "true") throw new Error("developer picker did not refresh access after focus");
  await available.click();
  for (let attempt = 0; attempt < 50 && await available.getAttribute("aria-checked") !== "true"; attempt += 1) await Bun.sleep(100);
  if (await available.getAttribute("aria-checked") !== "true") throw new Error("developer could not assign the granted Agent");
  if (!memberIds.some((member) => member.userId === developerId)) throw new Error("developer not listed in workspace");
  console.log("agent-access: Runtime owner grants developer access; reopened picker refreshes and developer selects Agent");

  await owner.page.goto(`${web}/${slug}/settings/agents`);
  const ownerAgentName = owner.page.getByText("Code Helper", { exact: true });
  await ownerAgentName.waitFor();
  const profileSelect = owner.page.getByLabel(translate("agents.runtimeProfile"));
  await profileSelect.waitFor();
  await profileSelect.selectOption(runtimeProfile.id);
  await owner.page.getByRole("button", { name: translate("agents.saveProfile"), exact: true }).click();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const profile = (await createAgentActions(db).listManageableAgentAccess.handler({ userId: owner.userId }, { workspaceId })).find((agent) => agent.id === codeAgent.id);
    if (profile?.runtimeProfileId === runtimeProfile.id) break;
    if (attempt === 49) throw new Error("Runtime owner could not bind the Agent to the sandbox profile");
    await Bun.sleep(100);
  }
  await owner.page.getByText("Run folder only", { exact: false }).first().waitFor();
  await ownerAgentName.scrollIntoViewIfNeeded();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 900 }, { width: 390, height: 844 }]) {
    await owner.page.setViewportSize(viewport);
    for (const theme of ["light", "dark"] as const) {
      await owner.page.evaluate((value) => { localStorage.setItem("weft.theme", value); document.documentElement.setAttribute("data-theme", value); }, theme);
      await Bun.write(`${evidenceDir}/runtime-owner-access-${viewport.width}-${theme}.png`, await owner.page.screenshot({ fullPage: true }));
    }
  }
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  const mine = await db.select({ id: workspaces.id }).from(workspaces).where(like(workspaces.slug, "agacc-%"));
  const bots = mine.length ? await db.select({ userId: agents.userId }).from(agents).where(inArray(agents.workspaceId, mine.map((row) => row.id))) : [];
  await db.delete(jobs);
  await db.delete(workspaces).where(like(workspaces.slug, "agent-access-%"));
  if (bots.length) await db.delete(users).where(inArray(users.id, bots.map((row) => row.userId)));
  await db.delete(users).where(like(users.email, "agacc-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
