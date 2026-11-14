// UI-only browser flow: a new workspace member signs in a Daemon, shares a Runtime,
// creates a Code-capable Agent, grants a second member access, and runs it from a work item.
// A scratch-only fake `codex` executable keeps the real Daemon path deterministic and offline.
import { chromium } from "playwright";
import { rm } from "node:fs/promises";
import { eq, like } from "drizzle-orm";
import { agents, createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31214);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52214);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const evidence = Bun.env.AGENT_ONBOARDING_SCREENSHOTS ?? "/tmp/claude-1000/-home-plong-orca-workspaces-weft-spurdog/4ede5172-06b6-4421-a1f0-57b9ca12a25c/scratchpad/ship-agent-safety-and-comment-ux/ticket-14-evidence";
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api, WEFT_DAEMON_TRACE: "1" }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, CHOKIDAR_USEPOLLING: "true" }, stdout: "ignore", stderr: "inherit" }),
];
const { client, db } = createDatabase();
const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const slug = `onboard-${suffix}`;
const adminEmail = `${slug}-admin@example.test`;
const developerEmail = `${slug}-developer@example.test`;
const pmEmail = `${slug}-pm@example.test`;
let browser: import("playwright").Browser | undefined;
let daemon: Bun.Subprocess | undefined;
let failed = false;

async function waitFor(url: string) {
  for (let n = 0; n < 120; n += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(250); }
  throw new Error(`${url} did not start`);
}
async function screenshotMatrix(page: import("playwright").Page, name: string, focus?: import("playwright").Locator) {
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await focus?.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => { localStorage.setItem("weft.theme", value); document.documentElement.setAttribute("data-theme", value); }, theme);
      await page.screenshot({ path: `${evidence}/${name}-${width}-${theme}.png`, fullPage: true });
    }
  }
}
function check(ok: boolean, message: string) { if (!ok) throw new Error(message); }

try {
  await Bun.$`mkdir -p ${evidence}`;
  const sandbox = `${evidence}/daemon-home`;
  await rm(sandbox, { recursive: true, force: true });
  const fakeBin = `${sandbox}/bin`;
  const configHome = `${sandbox}/config`;
  const scratchHome = `${sandbox}/home`;
  const daemonLog = `${sandbox}/daemon.log`;
  await Bun.$`mkdir -p ${fakeBin} ${configHome} ${scratchHome} ${sandbox}/tmp`;
  const launcher = `${fakeBin}/codex`;
  await Bun.write(launcher, `#!/bin/sh\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"The Runtime Agent completed its smoke run."}}'\n`);
  await Bun.$`chmod 700 ${launcher}`;
  const capturePath = `${sandbox}/login-url`;
  const openStub = `${fakeBin}/xdg-open`;
  await Bun.write(openStub, `#!/bin/sh\nprintf '%s\\n' "$1" > "$ORCA_LOGIN_CAPTURE"\n`);
  await Bun.$`chmod 700 ${openStub}`;
  await waitFor(`${api}/api/me`); await waitFor(web);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const admin = await adminContext.newPage();
  admin.on("pageerror", (error) => console.error("browser pageerror:", error.message));
  admin.on("response", async (response) => { if (response.status() >= 400 && response.url().includes("/actions/")) console.error(`browser action ${response.status()}: ${response.url()} ${(await response.text()).slice(0, 500)}`); if (["set_agent_project_access", "set_agent_access"].some((name) => response.url().endsWith(`/actions/${name}`))) console.log(`${response.url().split("/").pop()} ${response.status()}: ${(await response.text()).slice(0, 300)}`); });

  // New employee creates a workspace and project through the app.
  await admin.goto(web);
  await admin.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await admin.getByLabel(translate("auth.name")).fill("Runtime Owner");
  await admin.getByLabel(translate("auth.email")).fill(adminEmail);
  await admin.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await admin.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await admin.getByRole("button", { name: translate("auth.signUp") }).click();
  await admin.getByLabel(translate("workspace.name")).fill("Agent onboarding");
  await admin.getByLabel(translate("workspace.slug")).fill(slug);
  await admin.getByRole("button", { name: translate("workspace.create") }).click();
  await admin.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  await admin.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await admin.getByLabel(translate("projects.name")).fill("Engineering");
  await admin.getByLabel(translate("projects.key"), { exact: true }).fill("ENG");
  await admin.getByRole("button", { name: translate("projects.create") }).click();
  await admin.getByRole("link", { name: /ENG · Engineering/ }).waitFor();
  // Runtime Agents always use Autopilot, so the workspace Admin enables it before testing a Run.
  await admin.goto(`${web}/${slug}/settings`);
  const allowAutopilot = admin.getByLabel(translate("settings.allowAutopilot"));
  for (let attempt = 0; attempt < 50 && await allowAutopilot.isDisabled(); attempt += 1) await Bun.sleep(100);
  check(!(await allowAutopilot.isDisabled()), "workspace settings did not load the Admin controls");
  // The control is controlled by a query: it reverts until the save refetches, so click and poll instead of check().
  if (!(await allowAutopilot.isChecked())) await allowAutopilot.click();
  for (let attempt = 0; attempt < 50 && !(await allowAutopilot.isChecked()); attempt += 1) await Bun.sleep(100);
  check(await allowAutopilot.isChecked(), "workspace Autopilot setting did not enable");
  await screenshotMatrix(admin, "workspace-autopilot-settings");

  // Complete the browser-based `weft login` callback using the signed-in session.
  const loginDir = `${sandbox}/login-bin`;
  await Bun.$`mkdir -p ${loginDir}`;
  await Bun.write(`${loginDir}/xdg-open`, `#!/bin/sh\nprintf '%s\\n' "$1" > "$ORCA_LOGIN_CAPTURE"\n`);
  await Bun.$`chmod 700 ${loginDir}/xdg-open`;
  const bunPath = Bun.which("bun")!;
  const cliPath = `${process.cwd()}/apps/cli/src/index.ts`;
  const loginEnv = { PATH: `${loginDir}:/usr/bin:/bin`, HOME: scratchHome, XDG_CONFIG_HOME: configHome, ORCA_LOGIN_CAPTURE: capturePath, WEFT_API_URL: api, LANG: "C.UTF-8" };
  const login = Bun.spawn([bunPath, cliPath, "login"], { cwd: scratchHome, env: loginEnv, stdout: "pipe", stderr: "pipe" });
  for (let n = 0; n < 100 && !(await Bun.file(capturePath).exists()); n += 1) await Bun.sleep(100);
  check(await Bun.file(capturePath).exists(), "weft login did not open its browser sign-in page");
  await admin.goto((await Bun.file(capturePath).text()).trim());
  check((await admin.locator("body").innerText()).includes("Sign-in complete"), "browser sign-in did not complete the Daemon callback");
  const loginExit = await login.exited;
  check(loginExit === 0, `weft login exited with ${loginExit}: ${await new Response(login.stderr).text()}`);
  await admin.close();
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`${web}/${slug}`);

  // Start the actual Daemon from the disposable scratch directory; its only detected CLI is the fake Codex shim.
  daemon = Bun.spawn([bunPath, cliPath, "daemon", "start", "--foreground"], {
    cwd: scratchHome,
    env: { PATH: `${fakeBin}:/usr/bin:/bin`, HOME: scratchHome, XDG_CONFIG_HOME: configHome, TMPDIR: `${sandbox}/tmp`, LANG: "C.UTF-8", WEFT_API_URL: api, WEFT_DAEMON_CHILD: "1", WEFT_HOSTNAME: "ticket-14-scratch-runtime" },
    stdout: Bun.file(daemonLog), stderr: Bun.file(daemonLog),
  });
  await Bun.sleep(1200);
  await adminPage.goto(`${web}/${slug}/settings/runtimes`);
  const runtimeRow = adminPage.getByText("ticket-14-scratch-runtime", { exact: false }).first();
  await runtimeRow.waitFor({ timeout: 15_000 });
  await adminPage.getByRole("button", { name: translate("runtimes.share") }).click();
  await adminPage.getByText(translate("runtimes.shared")).waitFor();
  // Let the foreground Daemon complete its first WebSocket heartbeat so its work signal subscription is live.
  await Bun.sleep(16_000);
  await screenshotMatrix(adminPage, "runtime-shared");

  // Invite a developer and a PM from the UI; only the developer will receive Agent access.
  await adminPage.goto(`${web}/${slug}/settings/invites`);
  const makeInvite = async () => {
    await adminPage.getByRole("button", { name: translate("invite.create") }).click();
    return adminPage.getByLabel(translate("settings.inviteLink")).inputValue();
  };
  const developerInvite = await makeInvite();
  const pmInvite = await makeInvite();
  const join = async (name: string, email: string, url: string) => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    const page = await context.newPage();
    await page.goto(url);
    await page.getByLabel(translate("auth.name")).fill(name);
    await page.getByLabel(translate("auth.email")).fill(email);
    await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
    await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
    await page.getByRole("button", { name: translate("auth.signUp") }).click();
    await page.waitForURL(`${web}/${slug}`);
    return { context, page };
  };
  const { page: developer } = await join("Developer", developerEmail, developerInvite);
  const { page: pm } = await join("PM", pmEmail, pmInvite);
  await adminPage.goto(`${web}/${slug}/settings/projects/ENG/members`);
  await adminPage.getByLabel(translate("projects.addMember"), { exact: true }).selectOption({ label: "Developer" });
  await adminPage.getByRole("button", { name: translate("projects.addMember"), exact: true }).click();
  await adminPage.getByLabel(translate("projects.addMember"), { exact: true }).selectOption({ label: "PM" });
  await adminPage.getByRole("button", { name: translate("projects.addMember"), exact: true }).click();

  // Build and share the Code-capable Agent through Settings.
  await adminPage.goto(`${web}/${slug}/settings/agents`);
  await adminPage.getByLabel(translate("agents.name")).fill("Scratch Runtime Agent");
  await adminPage.getByLabel(translate("agents.instructions")).fill("Reply with a short completion note.");
  await adminPage.getByLabel(translate("agents.model")).fill("default");
  const runsOn = adminPage.getByLabel(translate("agents.runsOn"));
  const runtimeValue = await runsOn.locator("option").evaluateAll((options) => options.find((option) => option.textContent?.includes("ticket-14-scratch-runtime"))?.getAttribute("value"));
  check(!!runtimeValue, "the shared Runtime was not available to the Agent form");
  await runsOn.selectOption(runtimeValue!);
  await adminPage.getByRole("button", { name: translate("agents.save") }).click();
  const agentCard = adminPage.locator('[data-agent="Scratch Runtime Agent"]');
  await agentCard.waitFor();
  const allProjects = agentCard.getByLabel(translate("agents.allProjects"));
  await allProjects.click();
  for (let attempt = 0; attempt < 50 && !(await allProjects.isChecked()); attempt += 1) await Bun.sleep(100);
  if (!(await allProjects.isChecked())) throw new Error(`Could not open Agent to all projects; note: ${(await agentCard.getByRole("alert").allTextContents()).join("; ") || "none"}`);
  const developerAccess = agentCard.getByLabel(`${translate("agents.mayUse")} Developer`);
  await developerAccess.click();
  for (let attempt = 0; attempt < 50 && !(await developerAccess.isChecked()); attempt += 1) await Bun.sleep(100);
  if (!(await developerAccess.isChecked())) throw new Error(`Runtime owner could not grant Developer Agent access; note: ${(await agentCard.getByRole("alert").allTextContents()).join("; ") || "none"}`);
  const pmAccess = agentCard.getByLabel(`${translate("agents.mayUse")} PM`);
  check(!(await pmAccess.isChecked()), "PM unexpectedly has Code-capable Agent access");
  await screenshotMatrix(adminPage, "agent-access-settings");
  // Agents you can ask: the Developer may use the Agent; the PM sees it greyed with who to ask. Read-only for both.
  await developer.goto(`${web}/${slug}/settings/agents`);
  await developer.getByRole("heading", { name: translate("agents.askableTitle") }).waitFor();
  await developer.getByText(translate("agents.askableUsable"), { exact: true }).first().waitFor();
  // The askable list has no controls: no checkbox or button sits inside its block.
  check(await developer.locator("section", { has: developer.getByRole("heading", { name: translate("agents.askableTitle") }) }).getByRole("checkbox").count() === 0, "askable list must be read-only");
  await screenshotMatrix(developer, "developer-agents-settings");
  await pm.goto(`${web}/${slug}/settings/agents`);
  await pm.getByText(translate("agents.askableAsk").replace("{name}", "Runtime Owner"), { exact: true }).first().waitFor();
  await screenshotMatrix(pm, "pm-agents-settings");

  // Developer creates a work item, assigns the Agent in the UI, and sees the real Runtime Run complete.
  await developer.goto(`${web}/${slug}/projects/ENG/issues`);
  await developer.getByRole("button", { name: translate("workItems.addNew") }).click();
  await developer.getByRole("dialog", { name: translate("workItems.modal.title") }).getByLabel(translate("workItems.titleField")).fill("Run the setup check");
  await developer.getByRole("dialog", { name: translate("workItems.modal.title") }).getByRole("button", { name: translate("workItems.modal.submit") }).click();
  await developer.getByRole("link", { name: "Run the setup check" }).waitFor();
  await developer.goto(`${web}/${slug}/browse/ENG-1`);
  const properties = developer.getByRole("complementary", { name: translate("workItems.properties") });
  await pm.goto(`${web}/${slug}/browse/ENG-1`);
  const pmProperties = pm.getByRole("complementary", { name: translate("workItems.properties") });
  await pmProperties.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) }).click();
  const greyedAgent = pm.getByRole("menuitemcheckbox", { name: /Scratch Runtime Agent Agent Can edit code needs permission from Runtime Owner/ });
  await greyedAgent.waitFor();
  check(await greyedAgent.getAttribute("aria-disabled") === "true", "PM picker did not disable the Code-capable Agent");
  const greyBadge = greyedAgent.getByText(translate("agents.canEditCode"));
  const greyBadgeFontSize = await greyBadge.evaluate((node) => getComputedStyle(node).fontSize);
  check(parseFloat(greyBadgeFontSize) >= 12, `greyed code-capable chip is too small (${greyBadgeFontSize})`);
  await screenshotMatrix(pm, "greyed-code-agent-row", greyedAgent);
  await pm.keyboard.press("Escape");
  await properties.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) }).click();
  const codeAgent = developer.getByRole("menuitemcheckbox", { name: "Scratch Runtime Agent Agent Can edit code", exact: true });
  await codeAgent.waitFor();
  const badge = codeAgent.getByText(translate("agents.canEditCode"));
  const badgeStyle = await badge.evaluate((node) => ({ fontSize: getComputedStyle(node).fontSize, color: getComputedStyle(node).color }));
  check(parseFloat(badgeStyle.fontSize) >= 12, `code-capable chip is too small (${badgeStyle.fontSize})`);
  await screenshotMatrix(developer, "assignee-code-agent-row", badge);
  await developer.setViewportSize({ width: 1440, height: 900 });
  await codeAgent.scrollIntoViewIfNeeded();
  await codeAgent.click();
  await developer.keyboard.press("Escape");
  const runPanel = developer.getByTestId("runs-panel");
  try { await runPanel.getByText(translate("runs.status.completed"), { exact: true }).waitFor({ timeout: 30_000 }); }
  catch (error) {
    const panelText = await runPanel.innerText().catch(() => "Run panel missing");
    await developer.screenshot({ path: `${evidence}/runtime-run-stalled.png`, fullPage: true }).catch(() => {});
    const log = await Bun.file(daemonLog).text().catch(() => "Daemon log unavailable");
    throw new Error(`Runtime Run did not complete; panel: ${panelText}; Daemon log: ${log.slice(-3000)}; ${String(error)}`);
  }
  await developer.getByText("The Runtime Agent completed its smoke run.", { exact: true }).waitFor();
  await screenshotMatrix(developer, "runtime-run-completed");
  console.log(`agent-onboarding: UI login, Daemon registration, Runtime share, Agent creation/access, assignment, Run completion; workspace ${slug}`);

  // Capture and manually review remaining ticket screens through their real routes.
  await adminPage.goto(`${web}/${slug}/settings`); await adminPage.getByRole("heading", { name: translate("settings.workspaceTitle") }).waitFor();
  await adminPage.goto(`${web}/${slug}/settings/skills`); await adminPage.getByRole("heading", { name: translate("skills.title") }).waitFor(); await screenshotMatrix(adminPage, "skills-personal");
  await adminPage.getByRole("tab", { name: translate("skills.workspace") }).click(); await screenshotMatrix(adminPage, "skills-workspace");
  await adminPage.goto(`${web}/${slug}/ai`); await adminPage.getByRole("textbox", { name: translate("ai.message") }).waitFor(); await screenshotMatrix(adminPage, "ai-chat");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(5000)]);
    if (daemon.exitCode === null) { daemon.kill("SIGKILL"); await daemon.exited; }
  }
  if (browser) await browser.close();
  for (const server of servers) server.kill();
  const workspaceRows = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug));
  const botRows = workspaceRows.length ? await db.select({ userId: agents.userId }).from(agents).where(eq(agents.workspaceId, workspaceRows[0]!.id)) : [];
  if (workspaceRows.length) await db.delete(workspaces).where(eq(workspaces.id, workspaceRows[0]!.id));
  if (botRows.length) await db.delete(users).where(eq(users.id, botRows[0]!.userId));
  await db.delete(users).where(like(users.email, `${slug}-%@example.test`));
  await client.end();
}
process.exit(failed ? 1 : 0);
