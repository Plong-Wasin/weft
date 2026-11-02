// Browser end-to-end flow: an archived work item shows on the project Archives page, newest archive first, and Restore from its row removes it.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31143);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52143);
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
  await page.getByLabel(translate("auth.name")).fill("Archive Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const states = await call<Array<{ id: string; group: string }>>("list_states", { projectId: project!.id });
  const done = states.find((state) => state.group === "completed")!.id;
  const make = (title: string) => call<{ id: string; displayId: string }>("create_work_item", { projectId: project!.id, title, stateId: done });
  const first = await make("Old job"); const second = await make("Newer job"); const open = await call<{ id: string }>("create_work_item", { projectId: project!.id, title: "Still open" });
  await call("archive_work_item", { workItemId: first.id });
  await Bun.sleep(20);
  await call("archive_work_item", { workItemId: second.id });

  const t = (key: string) => translate(key as never);
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("navigation", { name: new RegExp(t("projectNav.label")) }).getByRole("link", { name: t("projectNav.archives") }).click();
  await page.waitForURL(`**/projects/MOB/archives`);
  const rows = page.locator("[data-testid^=archived-row-]");
  await rows.first().waitFor();
  check(await rows.count() === 2, "the Archives page does not list exactly the archived items");
  check((await rows.first().innerText()).includes("Newer job"), "newest archive is not first");
  check(await page.getByText("Still open").count() === 0, "an item that is not archived is listed");
  await rows.first().getByRole("button", { name: t("archives.restore") }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid^=archived-row-]").length === 1);
  const back = await call<{ archivedAt: string | null }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: second.displayId });
  check(back.archivedAt === null, "Restore did not clear the archive time");
  await rows.first().getByRole("button", { name: t("archives.restore") }).click();
  await page.getByText(t("archives.empty")).waitFor();
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
