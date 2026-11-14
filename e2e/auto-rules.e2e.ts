// Browser end-to-end flow: a project Admin turns on auto-close in Automation settings, previews the effect, and the daily run
// (called directly here, the worker runs it in production) closes an idle item. The item's timeline names the rule and offers Undo,
// and Undo puts the state back. Run with `bun e2e/run-all.ts auto-rules`; set DATABASE_URL to a throwaway database.
import { chromium } from "playwright";
import { eq } from "drizzle-orm";
import { activities, createDatabase, workItems } from "../packages/db/src";
import { applyAutoRules } from "../packages/actions/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31151);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52151);
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

const { client, db } = createDatabase();
let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); if (!response.ok()) throw new Error(`${name} failed: ${response.status()}`); return await response.json() as T; };
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const t = (key: string) => translate(key as never);

  await page.goto(web);
  await page.getByRole("button", { name: t("auth.signUp"), exact: true }).click();
  await page.getByLabel(t("auth.name")).fill("Automation Tester");
  await page.getByLabel(t("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(t("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(t("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: t("auth.signUp") }).click();
  await page.getByLabel(t("workspace.name")).fill("E2E team");
  await page.getByLabel(t("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: t("workspace.create") }).click();
  await page.getByRole("button", { name: t("projects.new"), exact: true }).click();
  await page.getByLabel(t("projects.name")).fill("Mobile");
  await page.getByLabel(t("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: t("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId, archived: false });
  const states = await call<Array<{ id: string; group: string; name: string }>>("list_states", { projectId: project!.id });
  const started = states.find((state) => state.group === "started")!;
  const done = states.find((state) => state.group === "completed")!;
  const idle = await call<{ id: string; displayId: string }>("create_work_item", { projectId: project!.id, title: "Waiting on the vendor", stateId: started.id });

  // Automation settings: off until switched on; preview counts without changing anything.
  await page.goto(`${web}/${slug}/settings/projects/MOB/automation`);
  await page.getByRole("heading", { name: t("autoRules.title") }).waitFor();
  check(!(await page.getByLabel(t("autoRules.closeOn")).isChecked()), "auto-close is on before anyone turned it on");
  await page.getByLabel(t("autoRules.closeOn")).check();
  await page.getByLabel(t("autoRules.closeAfter")).fill("30");
  await page.getByLabel(started.name).check();
  await page.getByLabel(t("autoRules.moveTo")).selectOption({ label: done.name });
  await page.getByRole("button", { name: t("autoRules.preview") }).click();
  // The item was just created, so nothing is idle yet: the preview says so.
  await page.getByText(t("autoRules.previewResult").replace("{close}", "0").replace("{archive}", "0")).waitFor();
  await page.getByRole("button", { name: t("autoRules.save") }).click();
  await page.getByText(t("autoRules.saved")).waitFor();
  await page.reload();
  await page.getByLabel(t("autoRules.closeOn")).waitFor();
  check(await page.getByLabel(t("autoRules.closeOn")).isChecked(), "the saved rule did not come back after a reload");
  check((await page.getByLabel(t("autoRules.closeAfter")).inputValue()) === "30", "the saved number of days did not come back");
  await page.screenshot({ path: reviewShots("auto-rules-settings.png"), fullPage: true });

  // The item goes idle: its last change, and its activity, are 31 days old.
  const old = new Date(Date.now() - 31 * 86_400_000);
  await db.update(workItems).set({ updatedAt: old }).where(eq(workItems.id, idle.id));
  await db.update(activities).set({ createdAt: old }).where(eq(activities.entityId, idle.id));
  await applyAutoRules(db, new Date());
  const [after] = await db.select().from(workItems).where(eq(workItems.id, idle.id));
  check(after!.stateId === done.id, "the daily run did not close the idle item");

  await page.goto(`${web}/${slug}/browse/${idle.displayId}`);
  await page.getByText(t("autoRules.systemActor")).first().waitFor();
  check(await page.getByText("No activity for 30 days in In Progress, so it moved to Done").count() === 1, "the timeline does not give the rule's reason");
  check(await page.getByRole("button", { name: t("autoRules.undo") }).count() >= 1, "the automatic change has no Undo");
  await page.screenshot({ path: reviewShots("auto-rules-timeline.png"), fullPage: true });
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("undo_auto_rule_change") && response.ok()),
    page.getByRole("button", { name: t("autoRules.undo") }).first().click(),
  ]);
  const [restored] = await db.select().from(workItems).where(eq(workItems.id, idle.id));
  check(restored!.stateId === started.id, "Undo did not put the state back");
  console.log("auto-rules e2e: settings saved, daily run closed the item, timeline shows the rule, Undo restored it");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  await client.end();
}
process.exit(failed ? 1 : 0);
