// Browser flow for Skills settings. Run with `bun e2e/skills.e2e.ts`.
import { chromium, type Page } from "playwright";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { like } from "drizzle-orm";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31167);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52167);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];
async function waitFor(url: string) { for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).status < 500) return; } catch { /* startup */ } await Bun.sleep(200); } throw new Error(`${url} did not start`); }
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
async function signup(page: Page, slug: string, name: string, email: string, invite?: string) {
  await page.goto(invite ?? web);
  if (!invite) await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill(name);
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  if (await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).count()) await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  if (!invite) {
    await page.getByLabel(translate("workspace.name")).fill("Skills E2E");
    await page.getByLabel(translate("workspace.slug")).fill(slug);
    await page.getByRole("button", { name: translate("workspace.create") }).click();
  }
  await page.waitForURL(`${web}/${slug}`);
}
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const adminContext = await browser.newContext({ locale: "en-US" });
  const admin = await adminContext.newPage();
  const slug = `skills-${crypto.randomUUID().slice(0, 8)}`;
  await signup(admin, slug, "Skills Admin", `${slug}@example.test`);
  const { client, db } = createDatabase();
  const workspace = await db.query.workspaces.findFirst({ where: (table, { eq }) => eq(table.slug, slug) });
  check(!!workspace, "created workspace missing");
  const request = async <T>(name: string, body: unknown) => await (await admin.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const inviteAndJoin = async (role: "Member" | "Guest", suffix: string) => {
    const invite = await request<{ token: string }>("create_invite", { workspaceId: workspace!.id, role });
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    await signup(page, slug, `Skills ${role}`, `${slug}-${suffix}@example.test`, `${web}/invite/${invite.token}`);
    return { page, context };
  };
  const sidebar = admin.getByRole("navigation", { name: translate("shell.sidebar") });
  await admin.getByRole("navigation", { name: translate("shell.rail") }).getByRole("link", { name: translate("nav.settings") }).click();
  await sidebar.getByRole("link", { name: translate("settings.skills"), exact: true }).click();
  await admin.waitForURL(`${web}/${slug}/settings/skills`);
  await admin.getByRole("tab", { name: translate("skills.personal") }).waitFor();
  await admin.getByRole("tab", { name: translate("skills.workspace") }).click();

  // A malformed name gets a clear inline error; a valid Personal skill can be created, edited and confirmed for deletion.
  await admin.getByRole("tab", { name: translate("skills.personal") }).click();
  await admin.getByRole("button", { name: translate("skills.create"), exact: true }).click();
  await admin.getByRole("button", { name: translate("skills.save") }).click();
  await admin.getByRole("alert").getByText(translate("skills.nameRequired")).waitFor();
  await admin.getByLabel(translate("skills.name")).fill("Not Valid");
  await admin.getByLabel(translate("skills.descriptionField")).fill("A useful description");
  await admin.getByLabel(translate("skills.instructions")).fill("A useful instruction");
  await admin.getByRole("button", { name: translate("skills.save") }).click();
  await admin.getByRole("alert").getByText(translate("skills.nameFormat")).waitFor();
  await admin.getByLabel(translate("skills.name")).fill("weekly-summary");
  await admin.getByRole("button", { name: translate("skills.save") }).click();
  await admin.getByText("weekly-summary", { exact: true }).waitFor();
  const personalRow = admin.getByRole("listitem").filter({ hasText: "weekly-summary" });
  await personalRow.getByRole("button", { name: translate("skills.edit") }).click();
  await admin.getByLabel(translate("skills.descriptionField")).fill("Updated summary description");
  await admin.getByRole("button", { name: translate("skills.save") }).click();
  await admin.getByText("Updated summary description").waitFor();
  admin.once("dialog", (dialog) => void dialog.dismiss());
  await personalRow.getByRole("button", { name: translate("skills.delete") }).click();
  await admin.getByText("weekly-summary", { exact: true }).waitFor();
  admin.once("dialog", (dialog) => void dialog.accept());
  await personalRow.getByRole("button", { name: translate("skills.delete") }).click();
  await admin.getByText(translate("skills.none")).waitFor();

  // Workspace Skills are manageable by Admins and read-only for Members and Guests.
  await admin.getByRole("tab", { name: translate("skills.workspace") }).click();
  await admin.getByRole("button", { name: translate("skills.create"), exact: true }).click();
  await admin.getByLabel(translate("skills.name")).fill("release-notes");
  await admin.getByLabel(translate("skills.descriptionField")).fill("Draft release notes");
  await admin.getByLabel(translate("skills.instructions")).fill("Summarize changes.");
  await admin.getByRole("button", { name: translate("skills.save") }).click();
  await admin.getByText("release-notes", { exact: true }).waitFor();

  const member = await inviteAndJoin("Member", "member");
  const guest = await inviteAndJoin("Guest", "guest");
  for (const { page, role } of [{ page: member.page, role: "Member" }, { page: guest.page, role: "Guest" }] as const) {
    await page.goto(`${web}/${slug}/settings/skills`);
    await page.getByRole("tab", { name: translate("skills.workspace") }).click();
    await page.getByText("release-notes", { exact: true }).waitFor();
    check(await page.getByRole("button", { name: translate("skills.create"), exact: true }).count() === 0, `${role} sees Workspace create control`);
    const workspaceSkill = page.getByRole("listitem").filter({ hasText: "release-notes" });
    check(await workspaceSkill.getByRole("button").count() === 0, `${role} sees Workspace edit or delete controls`);
    await page.getByRole("tab", { name: translate("skills.personal") }).click();
    check(await page.getByRole("button", { name: translate("skills.create"), exact: true }).count() === (role === "Member" ? 1 : 0), `${role} Personal create control is wrong`);
  }
  await member.context.close(); await guest.context.close();
  await adminContext.close(); await browser.close();
  await client.end();
  console.log("skills ok: tabs, role-based controls, validation, CRUD and delete confirmation");
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "skills-%"));
  await db.delete(users).where(like(users.email, "skills-%@example.test"));
  await client.end();
}
