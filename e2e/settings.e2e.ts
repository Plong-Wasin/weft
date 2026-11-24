// Browser end-to-end flow: workspace settings (general, members, invites) and project settings (general, members, labels, states, features).
// Run with `bun e2e/settings.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database). Screenshots go to .local/visual/review/16-settings-screens.
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31167);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52167);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("16-settings-screens");
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
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", colorScheme: "light" });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") console.error("console:", message.text().slice(0, 400)); });
  page.on("requestfailed", (request) => console.error("requestfailed:", request.url()));
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });
  // Records whether the Workspace links ever showed in this page's sidebar, so a direct visit to a project can be checked for a flash.
  await page.addInitScript((invitesLabel: string) => {
    const flags = window as unknown as { sawWorkspaceLinks?: boolean };
    flags.sawWorkspaceLinks = false;
    new MutationObserver(() => {
      for (const link of document.querySelectorAll("nav a")) if (link.textContent === invitesLabel) flags.sawWorkspaceLinks = true;
    }).observe(document, { childList: true, subtree: true });
  }, translate("settings.invites"));

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Settings Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
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
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const setFeature = async (feature: "cycles" | "modules" | "intake", on: boolean) => {
    const toggle = page.getByRole("switch", { name: translate(`features.${feature}`) });
    if (await toggle.isChecked() === on) return;
    await toggle.click();
    for (let attempt = 0; attempt < 30 && await toggle.isChecked() !== on; attempt += 1) await Bun.sleep(100);
    check(await toggle.isChecked() === on, `${feature} toggle did not settle`);
  };
  const members = () => call<Array<{ userId: string; name: string; role: string }>>("list_members", { workspaceId });

  // The Settings rail entry opens the settings sidebar: workspace sections plus every project with its sections.
  await page.getByRole("navigation", { name: translate("shell.rail") }).getByRole("link", { name: translate("nav.settings") }).click();
  await page.waitForURL(`${web}/${slug}/settings`);
  for (const label of [translate("settings.general"), translate("members.title"), translate("settings.invites")]) await sidebar.getByRole("link", { name: label, exact: true }).waitFor();
  await page.getByRole("heading", { name: translate("settings.workspaceTitle") }).waitFor();
  check(await page.getByLabel(translate("settings.workspaceName")).inputValue() === "E2E team", "workspace name not shown");
  check(await page.getByLabel(translate("settings.workspaceUrl")).inputValue() === slug, "workspace url not shown");
  await page.screenshot({ path: `${shots}/workspace-general-1440.png` });
  // The last Admin cannot leave: the danger zone shows the refusal.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: translate("settings.leave"), exact: true }).click();
  await page.getByRole("alert").getByText(translate("members.failed")).waitFor();
  console.log("settings ok: workspace general + danger zone");

  // Invites: create two, see them listed, revoke one, the invitee joins with the other.
  await sidebar.getByRole("link", { name: translate("settings.invites"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings/invites`);
  await page.getByText(translate("settings.invitesNone")).waitFor();
  await page.getByRole("button", { name: translate("invite.create") }).click();
  const link = await page.locator("input[readonly]").inputValue();
  check(link.startsWith(`${web}/invite/`), `invite link is ${link}`);
  await page.getByLabel(translate("invite.role")).selectOption("Guest");
  await page.getByRole("button", { name: translate("invite.create") }).click();
  await page.getByRole("button", { name: /^Revoke / }).nth(1).waitFor();
  check(await page.getByRole("button", { name: /Revoke Guest invite created by Settings Admin on/ }).count() === 1, "invite revoke action has no identifying accessible name");
  await page.screenshot({ path: `${shots}/workspace-invites-1440.png` });
  await page.getByRole("button", { name: /^Revoke / }).nth(1).click();
  await page.getByRole("status").getByText(translate("settings.revoked")).waitFor();
  check(await page.getByRole("button", { name: /^Revoke / }).count() === 1, "revoke did not remove the invite");
  const invitee = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const inviteePage = await invitee.newPage();
  await inviteePage.goto(link);
  await inviteePage.getByLabel(translate("auth.name")).fill("Invited Person");
  await inviteePage.getByLabel(translate("auth.email")).fill(`${slug}-invited@example.test`);
  await inviteePage.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await inviteePage.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await inviteePage.getByRole("button", { name: translate("auth.signUp") }).click();
  await inviteePage.waitForURL(`${web}/${slug}`);
  console.log("settings ok: invites create, list, revoke, accept");

  // Members: roles change, then a member is removed.
  await sidebar.getByRole("link", { name: translate("members.title"), exact: true }).click();
  await page.getByRole("heading", { name: translate("members.title") }).waitFor();
  const roleSelect = page.getByLabel(`${translate("settings.roleOf")} Invited Person`);
  await roleSelect.waitFor();
  await roleSelect.selectOption("Guest");
  for (let attempt = 0; attempt < 20 && (await members()).find((member) => member.name === "Invited Person")?.role !== "Guest"; attempt += 1) await Bun.sleep(150);
  check((await members()).find((member) => member.name === "Invited Person")?.role === "Guest", "role change did not apply");
  check(await page.getByRole("button", { name: "Remove Invited Person", exact: true }).count() === 1, "member remove action has no identifying accessible name");
  await page.screenshot({ path: `${shots}/workspace-members-1440.png` });
  const invited = (await members()).find((member) => member.name === "Invited Person")!;
  console.log("settings ok: workspace members role change");

  // Project settings: Workspace mode lists the projects as plain links, with Project order in the Workspace group. Opening one shows Project mode: a way back, the switcher and only that project's sections.
  check(await sidebar.getByRole("navigation", { name: new RegExp(`^${translate("settings.label")} [A-Z]+$`) }).count() === 0, "settings sidebar shows a project's sections before a project is chosen");
  check(await sidebar.getByRole("link", { name: translate("settings.projectOrder"), exact: true }).count() === 1, "Project order is not a Workspace link");
  check(await sidebar.getByText(translate("projects.title"), { exact: true }).count() === 1, "Workspace mode has no Projects heading");
  await sidebar.getByRole("list", { name: translate("projects.title") }).getByRole("link", { name: "Mobile" }).click();
  check(await sidebar.getByRole("combobox", { name: translate("sidebar.projectSwitcher"), exact: true }).inputValue() === "MOB", "project switcher shows another project than the open one (MOB)");
  check(await sidebar.getByRole("link", { name: translate("settings.invites"), exact: true }).count() === 0, "Project mode still shows the Workspace links");
  check(await sidebar.getByRole("link", { name: translate("settings.projectOrder"), exact: true }).count() === 0, "Project mode still shows Project order");
  check(await sidebar.getByText(translate("projects.title"), { exact: true }).count() === 0, "Project mode still shows the Projects heading");
  const projectNav = sidebar.getByRole("navigation", { name: `${translate("settings.label")} MOB` });
  for (const label of [translate("settings.general"), translate("members.title"), translate("labels.title"), translate("states.title"), translate("settings.features"), translate("recurrences.title")]) await projectNav.getByRole("link", { name: label, exact: true }).waitFor();

  // Switching project keeps the section: from Labels of MOB to Labels of SWT, with the sections of SWT only.
  await call("create_project", { workspaceId, name: "Switch target", key: "SWT", visibility: "public" });
  await page.reload();
  await projectNav.getByRole("link", { name: translate("labels.title"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings/projects/MOB/labels`);
  // The URL changes before React commits the new page; the switcher reads the section from that page, so wait until Labels shows as the current section.
  await projectNav.getByRole("link", { name: translate("labels.title"), exact: true }).and(page.locator('[aria-current="page"]')).waitFor();
  await sidebar.getByRole("combobox", { name: translate("sidebar.projectSwitcher"), exact: true }).selectOption("SWT");
  await page.waitForURL(`${web}/${slug}/settings/projects/SWT/labels`);
  await sidebar.getByRole("navigation", { name: `${translate("settings.label")} SWT` }).waitFor();
  check(await sidebar.getByRole("navigation", { name: `${translate("settings.label")} MOB` }).count() === 0, "switching project left the old project's sections in the sidebar");
  // A key that is not a project (a typo) gets the list of projects, not sections that lead nowhere.
  await page.goto(`${web}/${slug}/settings/projects/NOPE`);
  await sidebar.getByRole("list", { name: translate("projects.title") }).getByRole("link", { name: "Mobile" }).waitFor();
  check(await sidebar.getByRole("navigation", { name: `${translate("settings.label")} NOPE` }).count() === 0, "an unknown project key shows sections in the settings sidebar");
  check(await sidebar.getByRole("link", { name: translate("sidebar.backToWorkspace"), exact: true }).count() === 0, "an unknown project key shows the Project mode back link");
  // An archived project leaves the list, so its key gets the list too, not its sections.
  const archivedId = (await call<Array<{ id: string; key: string }>>("list_projects", { workspaceId, archived: false })).find((project) => project.key === "SWT")!.id;
  await call("archive_project", { projectId: archivedId });
  await page.goto(`${web}/${slug}/settings/projects/SWT`);
  await sidebar.getByRole("list", { name: translate("projects.title") }).getByRole("link", { name: "Mobile" }).waitFor();
  check(await sidebar.getByRole("navigation", { name: `${translate("settings.label")} SWT` }).count() === 0, "an archived project key shows its sections in the settings sidebar");
  // A direct visit shows Project mode at once: the Workspace links never showed in that page.
  await page.goto(`${web}/${slug}/settings/projects/MOB/labels`);
  await projectNav.waitFor();
  check(!(await page.evaluate(() => (window as unknown as { sawWorkspaceLinks?: boolean }).sawWorkspaceLinks)), "a direct visit showed the Workspace links before Project mode");
  console.log("settings ok: project switcher keeps the section, unknown and archived keys, direct visit");

  // The back link leaves Project mode for Workspace settings General.
  await sidebar.getByRole("link", { name: translate("sidebar.backToWorkspace"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings`);
  await sidebar.getByRole("link", { name: translate("settings.projectOrder"), exact: true }).waitFor();
  check(await sidebar.getByRole("link", { name: translate("settings.general"), exact: true }).and(page.locator('[aria-current="page"]')).count() === 1, "the back link did not land on Workspace settings General");
  await page.goto(`${web}/${slug}/settings/projects/MOB`);
  await projectNav.waitFor();
  console.log("settings ok: back link to Workspace settings General");

  // Captures of both modes at 1440 and 390 px: no sideways scroll; the images are opened and checked for clipped labels and overlap.
  const captureDir = join(import.meta.dir, "..", ".local", "captures", "01-settings-sidebar-modes");
  mkdirSync(captureDir, { recursive: true });
  for (const width of [1440, 390]) {
    // Below 768 px the sidebar lives in the drawer behind the top bar's Open menu button.
    const openSidebar = async () => { if (width < 768) await page.getByRole("button", { name: translate("shell.openMenu"), exact: true }).click(); };
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    await page.goto(`${web}/${slug}/settings`);
    await openSidebar();
    await sidebar.getByRole("link", { name: translate("settings.projectOrder"), exact: true }).waitFor();
    check(await noSideScroll(page), `Workspace mode scrolls sideways at ${width} px`);
    await page.screenshot({ path: join(captureDir, `workspace-mode-${width}.png`) });
    await page.goto(`${web}/${slug}/settings/projects/MOB/labels`);
    await openSidebar();
    await projectNav.waitFor();
    // The switcher shows the project's name once the list is in; capture after that, not the key shown while it loads.
    await sidebar.getByRole("combobox", { name: translate("sidebar.projectSwitcher"), exact: true }).locator("option", { hasText: "Mobile" }).waitFor({ state: "attached" });
    check(await noSideScroll(page), `Project mode scrolls sideways at ${width} px`);
    await page.screenshot({ path: join(captureDir, `project-mode-${width}.png`) });
  }
  // Back to desktop on a fresh load: the phone drawer stays open otherwise.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}/${slug}/settings/projects/MOB`);
  await projectNav.waitFor();
  console.log(`settings ok: sidebar modes captured in ${captureDir}`);

  // Recurrences: create from the settings tab, run once, and verify timeline provenance.
  await projectNav.getByRole("link", { name: translate("recurrences.title"), exact: true }).click();
  await page.getByRole("button", { name: translate("recurrences.create") }).click();
  await page.getByLabel(translate("recurrences.name")).fill("Weekly report");
  await page.getByLabel(translate("workItems.titleField")).fill("Generated weekly report");
  await page.getByRole("button", { name: translate("recurrences.save") }).click();
  const recurrenceRow = page.getByRole("listitem").filter({ hasText: "Weekly report" });
  await recurrenceRow.getByRole("button", { name: translate("recurrences.runNow") }).click();
  await page.getByRole("status").getByText(translate("recurrences.ranNow")).waitFor();
  await page.goto(web + "/" + slug + "/projects/MOB/issues");
  await page.getByText("Generated weekly report", { exact: true }).click();
  // The timeline opens on Comments; provenance is an Activity entry.
  await page.getByRole("combobox", { name: translate("timeline.filter", "en"), exact: true }).selectOption("all");
  await page.getByText(translate("workItems.activity.fromRecurrence").replace("{name}", "Weekly report")).waitFor();
  await page.goto(web + "/" + slug + "/settings/projects/MOB");
  console.log("settings ok: recurrence create, run now, and provenance");

  // General: rename, visibility, key rename (URL follows), archive and unarchive in the danger zone.
  await projectNav.getByRole("link", { name: translate("settings.general"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings/projects/MOB`);
  await page.getByLabel(translate("projects.name")).fill("Mobile app");
  await page.getByRole("button", { name: translate("projects.save"), exact: true }).click();
  await page.getByText("MOB · Mobile app").waitFor();
  await page.getByLabel(translate("projects.visibility")).selectOption("private");
  await page.getByRole("button", { name: translate("projects.save"), exact: true }).click();
  await page.getByRole("status").getByText(translate("settings.saved")).waitFor();
  await page.screenshot({ path: `${shots}/project-general-1440.png` });
  await page.getByRole("button", { name: translate("projects.renameKey"), exact: true }).click();
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOBX");
  await page.getByRole("button", { name: translate("projects.renameConfirm"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings/projects/MOBX`);
  const danger = page.getByRole("region", { name: translate("settings.dangerZone") });
  await danger.getByRole("button", { name: translate("projects.archive") }).click();
  await page.getByText(translate("projects.archivedBadge")).waitFor();
  await danger.getByRole("button", { name: translate("projects.unarchive") }).click();
  await danger.getByRole("button", { name: translate("projects.archive") }).waitFor();
  console.log("settings ok: project general");

  // Members: add, change role, remove.
  await page.getByRole("navigation", { name: `${translate("settings.label")} MOBX` }).getByRole("link", { name: translate("members.title"), exact: true }).click();
  await page.getByLabel(translate("projects.addMember"), { exact: true }).selectOption(invited.userId);
  await page.getByRole("button", { name: translate("projects.addMember"), exact: true }).click();
  const projectRole = page.getByLabel(`${translate("settings.roleOf")} Invited Person`);
  const guestSaved = page.waitForResponse((response) => response.url().endsWith("/actions/change_project_member_role"));
  await projectRole.selectOption("Guest");
  await guestSaved;
  await inviteePage.goto(web + "/" + slug + "/settings/projects/MOBX/recurrences");
  await inviteePage.getByText("Weekly report").waitFor();
  check(await inviteePage.getByRole("button", { name: translate("recurrences.create") }).count() === 0, "Guest can see the Recurrence create control");
  check(await inviteePage.getByRole("button", { name: translate("recurrences.runNow") }).count() === 0, "Guest can see Recurrence management controls");
  // A person who is not a workspace Admin reaches no Admin controls: each page says so in its own words, and the Audit log link is not offered.
  await inviteePage.goto(`${web}/${slug}/settings/invites`);
  await inviteePage.getByText(translate("settings.adminOnly")).waitFor();
  check(await inviteePage.getByRole("button", { name: translate("invite.create") }).count() === 0, "non-Admin can see the invite controls");
  await inviteePage.goto(`${web}/${slug}/settings/audit`);
  await inviteePage.getByText(translate("account.auditAdminOnly")).waitFor();
  check(await inviteePage.getByRole("link", { name: translate("account.auditTitle") }).count() === 0, "non-Admin is offered the Audit log link");
  check(await inviteePage.getByRole("button", { name: translate("account.exportCsv") }).count() === 0, "non-Admin can see the audit export");
  // Integrations are off in this run: the page sends the visitor back to General, and the merge setting is not on the features page.
  await inviteePage.goto(`${web}/${slug}/settings/integrations`);
  await inviteePage.waitForURL(new RegExp(`^${web}/${slug}/settings/?$`));
  console.log("settings ok: non-Admin cannot reach Admin controls");
  const adminSaved = page.waitForResponse((response) => response.url().endsWith("/actions/change_project_member_role"));
  await projectRole.selectOption("Admin");
  await adminSaved;
  await page.screenshot({ path: `${shots}/project-members-1440.png` });
  await projectRole.waitFor();
  const row = page.getByRole("listitem").filter({ hasText: "Invited Person" });
  await row.getByRole("button", { name: translate("members.remove") }).click();
  await row.waitFor({ state: "detached" });
  console.log("settings ok: project members add, role, remove");

  // Labels: create, edit, delete.
  await page.getByRole("navigation", { name: `${translate("settings.label")} MOBX` }).getByRole("link", { name: translate("labels.title"), exact: true }).click();
  await page.getByLabel(translate("labels.name"), { exact: true }).fill("Bug");
  await page.getByRole("button", { name: translate("labels.create") }).click();
  await page.getByText("Bug", { exact: true }).waitFor();
  await page.getByRole("button", { name: translate("labels.edit") }).click();
  await page.getByRole("listitem").getByLabel(translate("labels.name")).fill("Defect");
  await page.getByRole("button", { name: translate("labels.save") }).click();
  await page.getByText("Defect", { exact: true }).waitFor();
  await page.screenshot({ path: `${shots}/project-labels-1440.png` });
  await page.getByRole("button", { name: translate("labels.delete") }).click();
  await page.getByText(translate("labels.empty")).waitFor();
  console.log("settings ok: labels create, edit, delete");

  // States: add, rename, reorder, delete.
  await page.getByRole("navigation", { name: `${translate("settings.label")} MOBX` }).getByRole("link", { name: translate("states.title"), exact: true }).click();
  const startedBlock = page.locator("section").filter({ has: page.getByRole("heading", { name: translate("states.group.started") }) }).last();
  await startedBlock.getByRole("button", { name: translate("states.add"), exact: true }).click();
  await startedBlock.getByLabel(translate("states.name")).fill("Review");
  await startedBlock.getByRole("button", { name: translate("states.create"), exact: true }).click();
  await startedBlock.getByText("Review", { exact: true }).waitFor();
  await startedBlock.getByRole("listitem").filter({ hasText: "Review" }).getByRole("button", { name: new RegExp(`^${translate("sortable.actions")}`) }).click();
  await page.getByRole("menuitem", { name: translate("states.moveUp") }).click();
  const stateNames = async () => (await startedBlock.getByRole("listitem").locator("span.flex-1").allTextContents());
  for (let attempt = 0; attempt < 20 && (await stateNames())[0] !== "Review"; attempt += 1) await Bun.sleep(150);
  check((await stateNames())[0] === "Review", `reorder did not apply: ${(await stateNames()).join(",")}`);
  await startedBlock.getByRole("listitem").filter({ hasText: "Review" }).getByRole("button", { name: new RegExp(`^${translate("sortable.actions")}`) }).click();
  await page.getByRole("menuitem", { name: translate("states.rename") }).click();
  await startedBlock.getByRole("listitem").getByLabel(translate("states.name")).fill("In review");
  await startedBlock.getByRole("button", { name: translate("labels.save") }).click();
  await startedBlock.getByText("In review", { exact: true }).waitFor();
  await page.screenshot({ path: `${shots}/project-states-1440.png` });
  await startedBlock.getByRole("listitem").filter({ hasText: "In review" }).getByRole("button", { name: new RegExp(`^${translate("sortable.actions")}`) }).click();
  await page.getByRole("menuitem", { name: translate("states.remove") }).click();
  await startedBlock.getByText("In review", { exact: true }).waitFor({ state: "detached" });
  console.log("settings ok: states add, rename, reorder, delete");

  // Features: the toggles hide and show the project menus at once (client-side navigation, no reload).
  await page.getByRole("navigation", { name: `${translate("settings.label")} MOBX` }).getByRole("link", { name: translate("settings.features"), exact: true }).click();
  for (const feature of ["cycles", "modules", "intake"] as const) await setFeature(feature, false);
  await page.screenshot({ path: `${shots}/project-features-1440.png` });
  await page.getByRole("link", { name: /MOBX · Mobile app/ }).click();
  const projectMenu = sidebar.getByRole("navigation", { name: new RegExp(translate("projectNav.label")) });
  await projectMenu.getByRole("link", { name: translate("projectNav.views") }).waitFor();
  for (const label of [translate("cycles.title"), translate("modules.title"), translate("intake.title")]) check(await projectMenu.getByRole("link", { name: label }).count() === 0, `${label} menu still shown with the feature off`);
  await page.goto(`${web}/${slug}/settings/projects/MOBX/features`);
  for (const feature of ["cycles", "modules", "intake"] as const) await setFeature(feature, true);
  await page.getByRole("link", { name: /MOBX · Mobile app/ }).click();
  for (const label of [translate("cycles.title"), translate("modules.title"), translate("intake.title")]) await projectMenu.getByRole("link", { name: label }).waitFor();
  await page.goto(`${web}/${slug}/settings/projects/MOBX/features`);
  await page.getByRole("switch").first().waitFor();
  check(await page.getByText(translate("projectMerge.title")).count() === 0, "the merge setting is shown while integrations are off");
  console.log("settings ok: feature toggles hide and show the menus");

  // Old project settings URL redirects.
  await page.goto(`${web}/${slug}/projects/MOBX/settings`);
  await page.waitForURL(`${web}/${slug}/settings/projects/MOBX`);

  // Remove the invited member from the workspace.
  await page.goto(`${web}/${slug}/settings/members`);
  // The members page lists each person twice: the roster (with Remove) and the "Members and access" security list.
  const memberRow = page.getByRole("listitem").filter({ hasText: "Invited Person" }).filter({ has: page.getByRole("button", { name: translate("members.remove") }) });
  // Removing a member asks first: a dismissed confirm keeps the member.
  const asked = page.waitForEvent("dialog");
  const removing = memberRow.getByRole("button", { name: translate("members.remove") }).click();
  (await asked).dismiss();
  await removing;
  await memberRow.getByRole("button", { name: translate("members.remove") }).waitFor();
  page.once("dialog", (dialog) => void dialog.accept());
  await memberRow.getByRole("button", { name: translate("members.remove") }).click();
  await memberRow.waitFor({ state: "detached" });
  console.log("settings ok: workspace member removed");

  // 390px: every settings page scrolls only inside itself; the drawer holds the settings sidebar.
  await page.setViewportSize({ width: 390, height: 844 });
  const phonePages: Array<[string, string]> = [
    ["", "workspace-general"], ["/members", "workspace-members"], ["/invites", "workspace-invites"],
    ["/projects/MOBX", "project-general"], ["/projects/MOBX/members", "project-members"], ["/projects/MOBX/labels", "project-labels"],
    ["/projects/MOBX/states", "project-states"], ["/projects/MOBX/features", "project-features"],
  ];
  for (const [path, name] of phonePages) {
    await page.goto(`${web}/${slug}/settings${path}`);
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    check(await noSideScroll(page), `${name} scrolls sideways at 390px`);
    await page.screenshot({ path: `${shots}/${name}-390.png` });
  }
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  // The last page is a project's: the drawer shows Project mode, so its way back is there and the Workspace links are not.
  const drawer = page.getByRole("dialog", { name: translate("shell.sidebar") });
  await drawer.getByRole("link", { name: translate("sidebar.backToWorkspace"), exact: true }).waitFor();
  check(await drawer.getByRole("link", { name: translate("settings.invites"), exact: true }).count() === 0, "the phone drawer shows the Workspace links in Project mode");
  await page.screenshot({ path: `${shots}/settings-drawer-390.png` });
  console.log("settings ok: 390px");

  console.log("e2e settings: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
