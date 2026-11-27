// Browser end-to-end flow: Project General saves name and Visibility together with one Save; a Member without admin rights sees read-only values and no action buttons.
// Run with `bun e2e/project-general.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
// Captures of the General page (admin and read-only member, 1440 and 390 px) go to .local/captures/02/ in this worktree.
import { check, launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { mkdirSync } from "node:fs";
import type { Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31169);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52169);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const captures = `${import.meta.dir}/../.local/captures/02`;
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  mkdirSync(captures, { recursive: true });
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(page: Page, name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("General Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("General team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}**`);
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>(page, "create_project", { workspaceId, name: "General Demo", key: "GEN", visibility: "public" });

  // A second person joins the workspace by invite and is added to the project as a Member.
  const invite = await call<{ token: string }>(page, "create_invite", { workspaceId, role: "Member" });
  const memberContext = await newContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const member = await memberContext.newPage();
  await member.goto(`${web}/invite/${invite.token}`);
  await member.getByLabel(translate("auth.name")).fill("General Member");
  await member.getByLabel(translate("auth.email")).fill(`${slug}-member@example.test`);
  await member.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await member.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await member.getByRole("button", { name: translate("auth.signUp") }).click();
  await member.waitForURL(`${web}/${slug}**`);
  const members = await call<Array<{ userId: string; name: string }>>(page, "list_members", { workspaceId });
  const memberId = members.find((item) => item.name === "General Member")!.userId;
  await call(page, "add_project_member", { projectId: project.id, userId: memberId, role: "Member" });
  console.log("general ok: admin and member set up");

  // Save covers name and Visibility together: changing Visibility alone sends nothing until Save is pressed.
  const generalUrl = `${web}/${slug}/settings/projects/GEN`;
  const updates: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/actions/update_project")) updates.push(request.postData() ?? ""); });
  await page.goto(generalUrl);
  const name = page.getByLabel(translate("projects.name"));
  const visibility = page.getByLabel(translate("projects.visibility"));
  const save = page.getByRole("button", { name: translate("projects.save"), exact: true });
  await name.waitFor();
  await visibility.selectOption("private");
  await page.waitForTimeout(800);
  check(updates.length === 0, "changing Visibility alone sent a save before Save was pressed");
  check(await page.getByRole("status").getByText(translate("settings.saved")).count() === 0, "changing Visibility alone showed a saved status");
  await page.reload();
  await visibility.waitFor();
  check(await visibility.inputValue() === "public", "Visibility saved without Save: it is private after reload");
  await name.fill("General Demo Renamed");
  await visibility.selectOption("private");
  await save.click();
  await page.getByRole("status").getByText(translate("settings.saved")).waitFor();
  check(updates.length === 1, `Save sent ${updates.length} update_project calls, expected 1`);
  const sent = JSON.parse(updates[0]!) as { name?: string; visibility?: string };
  check(sent.name === "General Demo Renamed" && sent.visibility === "private", `Save sent ${updates[0]}, expected both name and visibility`);
  await page.reload();
  await name.waitFor();
  check(await name.inputValue() === "General Demo Renamed", "Save did not keep the name after reload");
  check(await visibility.inputValue() === "private", "Save did not keep the Visibility after reload");
  console.log("general ok: one Save saves name and Visibility together");

  // Admin capture of the General page, 1440 and 390 px.
  await page.getByText("GEN", { exact: true }).waitFor();
  await page.screenshot({ path: `${captures}/general-admin-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByText("GEN", { exact: true }).waitFor();
  check(await noSideScroll(page), "admin General page scrolls sideways at 390 px");
  await page.screenshot({ path: `${captures}/general-admin-390.png`, fullPage: true });
  console.log("general ok: admin captures written");

  // Member without admin rights: values read-only, no Save, Rename key, Archive.
  await member.setViewportSize({ width: 1440, height: 900 });
  await member.goto(generalUrl);
  const memberName = member.getByLabel(translate("projects.name"));
  await memberName.waitFor();
  check(await memberName.isDisabled(), "member can edit the project name");
  check(await member.getByLabel(translate("projects.visibility")).isDisabled(), "member can change Visibility");
  check(await member.getByRole("button", { name: translate("projects.save"), exact: true }).count() === 0, "member sees a Save button");
  check(await member.getByRole("button", { name: translate("projects.renameKey"), exact: true }).count() === 0, "member sees a Rename key button");
  check(await member.getByLabel(translate("projects.key"), { exact: true }).count() === 0, "member sees a key input");
  check(await member.getByRole("region", { name: translate("settings.dangerZone") }).count() === 0, "member sees the danger zone with Archive");
  check(await member.getByText("GEN", { exact: true }).isVisible(), "member does not see the project key");
  check(await memberName.inputValue() === "General Demo Renamed", "member does not see the saved name");
  await member.screenshot({ path: `${captures}/general-member-1440.png`, fullPage: true });
  await member.setViewportSize({ width: 390, height: 800 });
  await member.getByText("GEN", { exact: true }).waitFor();
  check(await noSideScroll(member), "member General page scrolls sideways at 390 px");
  await member.screenshot({ path: `${captures}/general-member-390.png`, fullPage: true });
  console.log("general ok: member read-only, captures written");

  await memberContext.close();
  await browser.close();
  console.log("general ok: Save covers name and Visibility; member sees read-only values and no action buttons");
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
