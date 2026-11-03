// Browser end-to-end flow: a Member sets, changes and clears an Estimate point from the work item page; no Estimate field shows while the project has none.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31141);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52141);
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
  await page.getByLabel(translate("auth.name")).fill("Estimate Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  if (await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).count()) await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
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
  const field = page.getByRole("complementary", { name: t("workItems.properties") });

  // No Estimate yet: the work item page shows no Estimate field.
  await page.goto(base);
  await field.getByText(t("workItems.priority")).first().waitFor();
  check(await field.getByText(t("workItems.estimate"), { exact: true }).count() === 0, "Estimate field shown without an Estimate");

  // Turn an Estimate on: the field appears and a point can be set, changed and cleared.
  const settings = `${web}/${slug}/settings/projects/MOB/estimates`;
  await page.goto(settings);
  await page.getByRole("button", { name: t("estimates.createButton") }).click();
  await page.getByRole("switch", { name: t("estimates.enabled") }).waitFor();
  console.log("estimates: created from the settings page");
  await page.goto(base);
  const trigger = () => field.getByRole("button", { name: new RegExp(`^${t("workItems.estimate")}:`) });
  await trigger().click();
  await page.getByRole("menuitemradio", { name: "5" }).click();
  await field.getByRole("button", { name: `${t("workItems.estimate")}: 5` }).waitFor();
  await page.reload();
  await field.getByRole("button", { name: `${t("workItems.estimate")}: 5` }).waitFor();
  console.log("estimates: set from the work item page, kept after reload");
  await trigger().click();
  await page.getByRole("menuitemradio", { name: "2" }).click();
  await field.getByRole("button", { name: `${t("workItems.estimate")}: 2` }).waitFor();
  await trigger().click();
  await page.getByRole("menuitemradio", { name: t("workItems.noEstimate") }).click();
  await field.getByRole("button", { name: `${t("workItems.estimate")}: ${t("workItems.noEstimate")}` }).waitFor();
  console.log("estimates: changed and cleared");

  // Activity names the field.
  await page.getByText(t("activity.field.estimate"), { exact: false }).first().waitFor();

  // The settings page asks before switching the system and says how many work items it clears.
  const scale = await call<{ points: Array<{ id: string; value: string }> }>("get_estimate", { projectId: project!.id });
  await call("update_work_item", { workItemId: item!.id, estimatePointId: scale.points.find((point) => point.value === "3")!.id });
  await page.goto(settings);
  let asked = "";
  page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.accept(); });
  await page.getByRole("button", { name: t("estimates.switchTo.categories") }).click();
  await page.getByText(t("estimates.type.categories"), { exact: true }).first().waitFor();
  check(asked.includes("1 work item"), `switch confirmation did not name the count: ${asked}`);
  const after = await call<{ type: string }>("get_estimate", { projectId: project!.id });
  check(after.type === "categories", "the Estimate did not switch to categories");
  console.log("estimates: switched from the settings page after confirming the count");

  // Turned off: the field is gone again.
  await call("update_estimate", { projectId: project!.id, enabled: false });
  await page.goto(base);
  await field.getByText(t("workItems.priority")).first().waitFor();
  check(await field.getByText(t("workItems.estimate"), { exact: true }).count() === 0, "Estimate field shown while the Estimate is off");
  console.log("e2e estimates: ok");
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
