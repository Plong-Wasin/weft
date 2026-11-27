import { launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31181);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52181);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const evidenceDir = Bun.env.AGENT_ACCESS_SCREENSHOTS ?? "/home/plong/workspace/weft/.local/ai-ux-reliability/11";
// The dev server, not a build served by `vite preview`: a build writes apps/web/dist, which flows running side by side would overwrite under each other.
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];
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
  const browser = await launchBrowser();
  const adminContext = await newContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" });
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
    const context = await newContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" });
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
  const legacyFullAgent = await createAgentActions(db).createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Legacy Full Access", model: "default", runtimeId: runtime.id });
  const profileEditAsAdmin = await runtimeActions.updateRuntimeProfile.handler({ userId: me.user.id }, { profileId: runtimeProfile.id, name: "Weakened", sandbox: "full", filesystemAllowlist: [], networkAllowlist: [] }).then(() => false, () => true);
  if (!profileEditAsAdmin) throw new Error("Workspace Admin changed a Runtime owner's profile");
  await owner.page.goto(`${web}/${slug}/settings/runtimes`);
  const runtimeProfilesSummary = owner.page.getByText(new RegExp(`^${translate("runtimes.profiles")}`)).first();
  await runtimeProfilesSummary.waitFor();
  await runtimeProfilesSummary.click();
  const enforcement = owner.page.getByRole("checkbox", { name: translate("runtimes.enforceSandbox") });
  const requirements = owner.page.getByTestId("runtime-sandbox-requirements");
  await requirements.waitFor();
  const requirementsAtSettings = await requirements.innerText();
  if (!requirementsAtSettings.includes("SRT") || !requirementsAtSettings.includes("0.0.83") || !requirementsAtSettings.includes("npm install --global @anthropic-ai/sandbox-runtime") || !requirementsAtSettings.includes("On Linux") || !requirementsAtSettings.includes("bubblewrap (bwrap), socat, and ripgrep (rg)") || !requirementsAtSettings.includes("unprivileged user namespaces") || !requirementsAtSettings.includes("Settings do not verify these host requirements") || !requirementsAtSettings.includes("never falls back")) {
    throw new Error(`Sandbox requirements are not actionable or fail-closed: ${requirementsAtSettings}`);
  }
  const impact = owner.page.getByTestId("runtime-enforcement-warning");
  await impact.waitFor();
  const impactText = await impact.innerText();
  if (!impactText.includes("Full access") || !impactText.includes("claimed after this change") || !impactText.includes("already dispatched") || !impactText.includes("Wait for these Runs to finish or stop them")) {
    throw new Error(`Enforcement warning does not explain the claim boundary and existing Runs: ${impactText}`);
  }
  await Bun.$`mkdir -p ${evidenceDir}`;
  await owner.page.setViewportSize({ width: 1440, height: 900 });
  await impact.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await Bun.write(`${evidenceDir}/runtime-enforcement-warning-1440.png`, await owner.page.screenshot());
  await owner.page.setViewportSize({ width: 390, height: 844 });
  await impact.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await Bun.write(`${evidenceDir}/runtime-enforcement-warning-390.png`, await owner.page.screenshot());
  await owner.page.setViewportSize({ width: 1440, height: 900 });
  let cancelledConfirmation = "";
  owner.page.once("dialog", async (dialog) => { cancelledConfirmation = dialog.message(); await dialog.dismiss(); });
  await enforcement.click();
  if (!cancelledConfirmation.includes("Full access") || !cancelledConfirmation.includes("claimed after this change") || !cancelledConfirmation.includes("already dispatched") || !cancelledConfirmation.includes("Wait for these Runs to finish or stop them") || await enforcement.getAttribute("aria-checked") !== "false") {
    throw new Error(`Enforcement confirmation did not explain existing Runs or allowed an unconfirmed change: ${cancelledConfirmation}`);
  }
  let acceptedConfirmation = "";
  owner.page.once("dialog", async (dialog) => { acceptedConfirmation = dialog.message(); await dialog.accept(); });
  await enforcement.click();
  if (!acceptedConfirmation.includes("Full access") || !acceptedConfirmation.includes("claimed after this change") || !acceptedConfirmation.includes("already dispatched")) {
    throw new Error(`The enforcement confirmation omitted the claim boundary or existing Full access Runs: ${acceptedConfirmation}`);
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const listed = await request<Array<{ id: string; enforceSandbox: boolean }>>(owner.page, "list_runtimes", { workspaceId });
    if (listed.find((candidate) => candidate.id === runtime.id)?.enforceSandbox) break;
    if (attempt === 49) throw new Error("Confirmed sandbox enforcement was not saved");
    await Bun.sleep(100);
  }
  const legacyProfile = await createAgentActions(db).getAgent.handler({ userId: me.user.id }, { agentId: legacyFullAgent.id });
  if (legacyProfile.runtimeProfileSandbox !== "full") throw new Error("Enabling enforcement unexpectedly reassigned the existing Full access Agent");
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
  const unavailable = pm.page.getByRole("menuitemcheckbox", { name: /Code Helper Agent Can edit code Ask Runtime Owner for access/ });
  await unavailable.waitFor();
  if (await unavailable.getAttribute("aria-disabled") !== "true" || await unavailable.getAttribute("aria-checked") !== "false") throw new Error("PM picker did not mark the Code-capable Agent unavailable");
  await unavailable.click({ force: true });
  if (await unavailable.getAttribute("aria-checked") !== "false") throw new Error("PM selected unavailable Agent with the mouse");
  await unavailable.focus(); await pm.page.keyboard.press("Enter");
  if (await unavailable.getAttribute("aria-checked") !== "false") throw new Error("PM selected unavailable Agent with the keyboard");
  console.log("agent-access: PM sees reason and cannot select Agent by mouse or keyboard");

  await Bun.$`mkdir -p ${evidenceDir}`;
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 900 }, { width: 390, height: 844 }]) {
    await pm.page.setViewportSize(viewport);
    await pmAssignees.scrollIntoViewIfNeeded();
    // The layout change at a new width can hide the trigger, which closes the picker on purpose: open it again.
    if (!await unavailable.isVisible()) await pmAssignees.click();
    await unavailable.scrollIntoViewIfNeeded();
    for (const theme of ["light", "dark"] as const) {
      await pm.page.evaluate((value) => { localStorage.setItem("weft.theme", value); document.documentElement.setAttribute("data-theme", value); }, theme);
      await Bun.write(`${evidenceDir}/pm-picker-${viewport.width}-${theme}.png`, await pm.page.screenshot());
    }
  }
  await pm.page.keyboard.press("Escape");

  // The non-admin Runtime owner grants the developer through Agent settings.
  await owner.page.goto(`${web}/${slug}/settings/runtimes`);
  // The profile section is folded under a summary ("Runtime profiles · n"): open it to read the profiles.
  const profilesSummary = owner.page.getByText(new RegExp(`^${translate("runtimes.profiles")}`)).first();
  await profilesSummary.waitFor();
  await profilesSummary.click();
  // The owner's profile stays "Run folder only"; the Admin's rename to "Weakened" (full access) was refused above.
  await owner.page.getByText("Run folder only", { exact: false }).first().waitFor();
  if (await owner.page.getByText("Weakened", { exact: false }).count()) throw new Error("Admin's profile change reached the Runtime owner's page");
  // Ticket 22: every full profile carries the full-access warning; the warning sits inside the profile row text.
  await owner.page.getByText(translate("runtimes.fullAccessWarning"), { exact: false }).first().waitFor();
  await owner.page.getByRole("checkbox", { name: translate("runtimes.enforceSandbox") }).waitFor();
  const enforcementSetting = owner.page.getByRole("checkbox", { name: translate("runtimes.enforceSandbox") });
  const settingsRequirements = owner.page.getByTestId("runtime-sandbox-requirements");
  await settingsRequirements.waitFor();
  const settingsRequirementsText = await settingsRequirements.innerText();
  if (!settingsRequirementsText.includes("SRT") || !settingsRequirementsText.includes("0.0.83") || !settingsRequirementsText.includes("npm install --global @anthropic-ai/sandbox-runtime") || !settingsRequirementsText.includes("On Linux") || !settingsRequirementsText.includes("bubblewrap (bwrap), socat, and ripgrep (rg)") || !settingsRequirementsText.includes("unprivileged user namespaces") || !settingsRequirementsText.includes("Settings do not verify these host requirements") || !settingsRequirementsText.includes("never falls back")) {
    throw new Error(`Sandbox requirements are not actionable or fail-closed: ${settingsRequirementsText}`);
  }
  if (await enforcementSetting.getAttribute("aria-checked") !== "true") throw new Error("Confirmed sandbox enforcement is not shown as enabled");
  await owner.page.setViewportSize({ width: 1440, height: 900 });
  await settingsRequirements.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await Bun.write(`${evidenceDir}/runtime-profiles-settings.png`, await owner.page.screenshot());
  await owner.page.setViewportSize({ width: 390, height: 844 });
  await settingsRequirements.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await Bun.write(`${evidenceDir}/runtime-profiles-settings-mobile.png`, await owner.page.screenshot());
  await owner.page.setViewportSize({ width: 1440, height: 900 });

  await owner.page.goto(`${web}/${slug}/settings/agents`);
  const ownerAgentName = owner.page.locator("strong").getByText("Code Helper", { exact: true });
  await ownerAgentName.waitFor();
  const codeAgentRow = ownerAgentName.locator("xpath=../..");
  const memberIds = await request<Array<{ userId: string; name: string }>>(admin, "list_members", { workspaceId });
  const developerId = memberIds.find((member) => member.name === "Developer")!.userId;
  await developer.page.goto(itemUrl);
  const developerAssignees = developer.page.getByRole("complementary", { name: translate("workItems.properties") }).getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) });
  await developerAssignees.click();
  const developerUnavailable = developer.page.getByRole("menuitemcheckbox", { name: /Code Helper Agent Can edit code Ask Runtime Owner for access/ });
  await developerUnavailable.waitFor();
  await developer.page.keyboard.press("Escape");
  const developerGrant = codeAgentRow.getByRole("checkbox", { name: `${translate("agents.mayUse")} Developer` });
  const accessSave = codeAgentRow.getByRole("button", { name: translate("agents.save"), exact: true }).first();
  if (await accessSave.isEnabled()) throw new Error("Unchanged Agent access unexpectedly enabled Save");
  const ownerGrants = async () => (await createAgentActions(db).listManageableAgentAccess.handler({ userId: owner.userId }, { workspaceId })).find((agent) => agent.id === codeAgent.id)?.accessUserIds ?? [];
  const pmId = memberIds.find((member) => member.name === "PM")!.userId;
  // The checkbox is controlled by the list the page reloads after each save: wait until the page shows the new state before the next click, or the click toggles from a stale list.
  const settled = async (checked: boolean) => { for (let attempt = 0; attempt < 100 && await developerGrant.getAttribute("aria-checked") !== String(checked); attempt += 1) await Bun.sleep(100); if (await developerGrant.getAttribute("aria-checked") !== String(checked)) throw new Error(`Runtime owner access checkbox did not show ${checked ? "checked" : "unchecked"}`); };
  const pmGrant = codeAgentRow.getByRole("checkbox", { name: `${translate("agents.mayUse")} PM` });
  await pmGrant.click({ force: true });
  await pmGrant.click({ force: true });
  await developerGrant.click({ force: true });
  if ((await ownerGrants()).includes(developerId)) throw new Error("Agent access draft was saved before Save was clicked");
  if (await accessSave.isEnabled() !== true) throw new Error("Save did not become available for a changed access draft");
  const concurrentBase = await ownerGrants();
  await createAgentActions(db).setAgentAccess.handler({ userId: owner.userId }, { agentId: codeAgent.id, baseUserIds: concurrentBase, userIds: [...concurrentBase, pmId] });
  await accessSave.click();
  for (let attempt = 0; attempt < 50 && (!(await ownerGrants()).includes(developerId) || !(await ownerGrants()).includes(pmId)); attempt += 1) await Bun.sleep(100);
  if (!(await ownerGrants()).includes(developerId) || !(await ownerGrants()).includes(pmId)) throw new Error(`Concurrent access edit did not preserve both grants: ${await owner.page.locator('[role="status"]').allTextContents()}`);
  await settled(true);
  if (await pmGrant.getAttribute("aria-checked") !== "true") throw new Error("Agent access UI did not refresh the concurrent grant returned by Save");
  await developerGrant.click({ force: true });
  await owner.page.route("**/actions/set_agent_access", (route) => route.fulfill({ status: 500, body: "save failed" }));
  await accessSave.click();
  if (!(await ownerGrants()).includes(developerId) || await developerGrant.getAttribute("aria-checked") !== "false") throw new Error("Failed save changed server access or discarded the visible draft");
  for (let attempt = 0; attempt < 20 && !(await accessSave.isEnabled()); attempt += 1) await Bun.sleep(100);
  if (!(await accessSave.isEnabled())) throw new Error("Failed save discarded the unsaved access draft");
  await owner.page.unroute("**/actions/set_agent_access");
  await accessSave.click();
  for (let attempt = 0; attempt < 50 && (await ownerGrants()).includes(developerId); attempt += 1) await Bun.sleep(100);
  if ((await ownerGrants()).includes(developerId)) throw new Error("Runtime owner could not remove Developer access");
  await settled(false);
  await developerGrant.click({ force: true });
  await accessSave.click();
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
  await ownerAgentName.waitFor();
  const profileSelect = codeAgentRow.getByLabel(translate("agents.runtimeProfile"));
  await profileSelect.waitFor();
  const saveProfile = codeAgentRow.getByRole("button", { name: translate("agents.saveProfile"), exact: true });
  const agentProfile = async () => (await createAgentActions(db).listManageableAgentAccess.handler({ userId: owner.userId }, { workspaceId })).find((agent) => agent.id === codeAgent.id)?.runtimeProfileId;
  // The Runtime enforces a sandbox, so a new Agent on it is bound to the safest restricted profile ("Run folder only") from the start; Save stays off until the choice changes.
  if (await agentProfile() !== runtimeProfile.id) throw new Error("Agent on a sandbox-enforcing Runtime was not bound to the restricted profile by default");
  if (await profileSelect.inputValue() !== runtimeProfile.id) throw new Error("Agent settings did not show the bound profile");
  if (await saveProfile.isEnabled()) throw new Error("Save profile is enabled although the profile did not change");
  // The owner moves the Agent to another restricted profile.
  const readOnlyProfile = await runtimeActions.createRuntimeProfile.handler({ userId: owner.userId }, { runtimeId: runtime.id, name: "Read only", sandbox: "read-only", filesystemAllowlist: [], networkAllowlist: [] });
  await owner.page.reload();
  await profileSelect.selectOption(readOnlyProfile.id);
  await saveProfile.click();
  for (let attempt = 0; attempt < 50 && await agentProfile() !== readOnlyProfile.id; attempt += 1) await Bun.sleep(100);
  if (await agentProfile() !== readOnlyProfile.id) throw new Error("Runtime owner could not bind the Agent to the sandbox profile");
  await profileSelect.selectOption(runtimeProfile.id);
  await saveProfile.click();
  for (let attempt = 0; attempt < 50 && await agentProfile() !== runtimeProfile.id; attempt += 1) await Bun.sleep(100);
  if (await agentProfile() !== runtimeProfile.id) throw new Error("Runtime owner could not bind the Agent back to Run folder only");
  await codeAgentRow.getByText("Run folder only", { exact: false }).first().waitFor();
  await ownerAgentName.scrollIntoViewIfNeeded();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 900 }, { width: 390, height: 844 }]) {
    await owner.page.setViewportSize(viewport);
    await codeAgentRow.getByLabel(`${translate("agents.mayUse")} Developer`).scrollIntoViewIfNeeded();
    for (const theme of ["light", "dark"] as const) {
      await owner.page.evaluate((value) => { localStorage.setItem("weft.theme", value); document.documentElement.setAttribute("data-theme", value); }, theme);
      await Bun.write(`${evidenceDir}/runtime-owner-access-${viewport.width}-${theme}.png`, await owner.page.screenshot({ fullPage: true }));
    }
  }

  // A Workspace Admin who owns the Runtime must be able to bind their Agent to a profile.
  const adminToken = await createApiTokenActions(db).createApiToken.handler({ userId: me.user.id }, { name: "Admin Runtime" });
  const adminDaemon = await runtimeActions.registerDaemon.handler({ userId: me.user.id, apiTokenId: adminToken.id }, { hostname: "admin-profile-e2e", version: "1", agentClis: ["codex"] });
  const adminRuntime = adminDaemon.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: me.user.id }, { runtimeId: adminRuntime.id });
  const adminProfile = await runtimeActions.createRuntimeProfile.handler({ userId: me.user.id }, { runtimeId: adminRuntime.id, name: "Admin sandbox", sandbox: "run-folder", filesystemAllowlist: [], networkAllowlist: [] });
  const adminAgent = await createAgentActions(db).createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Admin Agent", model: "default", runtimeId: adminRuntime.id });
  await admin.goto(`${web}/${slug}/settings/agents`);
  const adminAgentRow = admin.locator('[data-agent="Admin Agent"]');
  const adminProfileSelect = adminAgentRow.getByLabel(translate("agents.runtimeProfile"));
  await adminProfileSelect.waitFor({ timeout: 5000 });
  await adminProfileSelect.selectOption(adminProfile.id);
  await adminAgentRow.getByRole("button", { name: translate("agents.saveProfile"), exact: true }).click();
  for (let attempt = 0; attempt < 50; attempt++) {
    const saved = await createAgentActions(db).getAgent.handler({ userId: me.user.id }, { agentId: adminAgent.id });
    if (saved.runtimeProfileId === adminProfile.id) break;
    if (attempt === 49) throw new Error("Admin could not bind their Agent to their Runtime profile");
    await Bun.sleep(100);
  }
  await Bun.write(`${evidenceDir}/admin-runtime-profile-desktop.png`, await adminAgentRow.screenshot());
  await admin.setViewportSize({ width: 390, height: 844 });
  await Bun.write(`${evidenceDir}/admin-runtime-profile-mobile.png`, await adminAgentRow.screenshot());
  await admin.setViewportSize({ width: 1440, height: 900 });

  // The workspace Admin also edits project access; a second editor's change must survive this stale UI draft.
  const docsProject = await projects.createProject.handler({ userId: me.user.id }, { workspaceId, name: "Docs", key: "DOC", visibility: "public" });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: codeAgent.id, allProjects: false, projectIds: [] });
  await admin.goto(`${web}/${slug}/settings/agents`);
  const agentRow = admin.locator('[data-agent="Code Helper"]');
  if (await agentRow.getByLabel(translate("agents.runtimeProfile")).count()) throw new Error("Admin must not change another owner’s Runtime profile");
  const mobileProject = agentRow.getByRole("checkbox", { name: "MOB · Mobile" });
  const projectSave = agentRow.getByRole("button", { name: translate("agents.save"), exact: true }).first();
  await mobileProject.waitFor();
  if (await projectSave.isEnabled()) throw new Error("Unchanged Agent project access unexpectedly enabled Save");
  await mobileProject.click();
  if ((await createAgentActions(db).listAgents.handler({ userId: me.user.id }, { workspaceId })).find((agent) => agent.id === codeAgent.id)?.projectIds.length !== 0) throw new Error("Project access draft was saved before Save was clicked");
  const projectBase = (await createAgentActions(db).getAgent.handler({ userId: me.user.id }, { agentId: codeAgent.id })).projectIds;
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: codeAgent.id, allProjects: false, baseAllProjects: false, baseProjectIds: projectBase, projectIds: [docsProject.id] });
  await projectSave.click();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const savedProjects = (await createAgentActions(db).getAgent.handler({ userId: me.user.id }, { agentId: codeAgent.id })).projectIds;
    if (savedProjects.includes(project.id) && savedProjects.includes(docsProject.id)) break;
    if (attempt === 49) throw new Error("Concurrent project access edit did not preserve both project grants");
    await Bun.sleep(100);
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
  await db.delete(workspaces).where(like(workspaces.slug, "agacc-%"));
  if (bots.length) await db.delete(users).where(inArray(users.id, bots.map((row) => row.userId)));
  await db.delete(users).where(like(users.email, "agacc-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
