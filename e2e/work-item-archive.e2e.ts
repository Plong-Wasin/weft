// Browser end-to-end flow: a Member archives a completed work item from its page, sees the banner and read-only fields at 1440px and 390px, and restores it; a refusal from the Action is shown.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31142);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52142);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
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

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); if (!response.ok()) throw new Error(`${name} failed: ${response.status()}`); return await response.json() as T; };
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Archive Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const [item] = await Promise.all([call<{ id: string; displayId: string }>("create_work_item", { projectId: project!.id, title: "Alpha" })]);

  const t = (key: string) => translate(key as never);
  const base = `${web}/${slug}/browse/${item!.displayId}`;
  const archiveButton = page.getByRole("button", { name: t("workItems.archive"), exact: true });
  const states = await call<Array<{ id: string; group: string }>>("list_states", { projectId: project!.id });

  // Not eligible while the state is not completed or cancelled: no Archive command.
  await page.goto(base);
  await page.getByLabel(t("workItems.titleField")).waitFor();
  check(await archiveButton.count() === 0, "Archive shown for a work item that is not completed or cancelled");

  // A completed item shows Archive; archiving shows the banner and makes the fields read-only.
  await call("update_work_item", { workItemId: item!.id, stateId: states.find((state) => state.group === "completed")!.id });
  await page.reload();
  await archiveButton.waitFor();
  await archiveButton.click();
  const banner = page.getByRole("status").filter({ hasText: t("workItems.archivedBanner") });
  await banner.waitFor();
  check(await page.getByLabel(t("workItems.titleField")).isEditable() === false, "title still editable on an archived work item");
  check(await page.getByLabel(t("workItems.dueDate")).isDisabled(), "due date still editable on an archived work item");
  console.log("archives: archived from the work item page, banner and read-only fields shown");

  // The old link keeps opening it, also on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await banner.waitFor();
  const restore = banner.getByRole("button", { name: t("workItems.restore") });
  check(await restore.isVisible(), "Restore not visible at 390px");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page scrolls sideways at 390px");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Restore brings the page back to normal.
  await restore.click();
  await banner.waitFor({ state: "detached" });
  check(await page.getByLabel(t("workItems.titleField")).isEditable(), "title not editable after restore");
  await archiveButton.waitFor();
  console.log("archives: restored from the banner");

  // A refusal from the Action is shown: the item sits in a Module that is not completed or cancelled.
  const module = await call<{ id: string }>("create_module", { projectId: project!.id, name: "Open topic" });
  await call("add_module_items", { moduleId: module.id, workItemIds: [item!.id] });
  await page.reload();
  await archiveButton.click();
  await page.getByRole("alert").filter({ hasText: /Module/ }).waitFor();
  console.log("archives: refusal message shown");
  console.log("e2e archives: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  // The flow commits real rows (the servers use their own connections), so remove them: other tests expect an empty instance.
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
