// Browser end-to-end flow: submit a work item to Intake, accept it, check it leaves Triage and shows in the project list.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Locator, type Page } from "playwright";
import { eq, like } from "drizzle-orm";
import { createDatabase, projects as dbProjects, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3108);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5208);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
async function expectValue(locator: Locator, expected: string, label: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await locator.inputValue() === expected) return;
    await Bun.sleep(100);
  }
  throw new Error(`Expected ${label} value ${expected}; got ${await locator.inputValue()}`);
}
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
let e2eDatabase: ReturnType<typeof createDatabase> | null = null;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Intake Tester");
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
  await page.getByText(translate("projects.shapeFull"), { exact: true }).click(); // a new project starts Simple; this flow needs Cycles, Modules and Intake
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  e2eDatabase = createDatabase();
  const [workspaceRow] = await e2eDatabase.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug));
  const [projectRow] = await e2eDatabase.db.select({ id: dbProjects.id }).from(dbProjects).where(eq(dbProjects.workspaceId, workspaceRow!.id));
  const [userRow] = await e2eDatabase.db.select({ id: users.id }).from(users).where(eq(users.email, `${slug}@example.test`));
  const createdLabel = await page.evaluate(async ({ apiUrl, projectId }) => {
    const response = await fetch(`${apiUrl}/actions/create_label`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, name: "E2E label" }) });
    if (!response.ok) throw new Error(`create_label failed: ${response.status}`);
    return response.json() as Promise<{ id: string }>;
  }, { apiUrl: api, projectId: projectRow!.id });

  const shots = reviewShots("14-intake-ui");
  const add = page.getByRole("button", { name: translate("intake.add"), exact: true });
  const submit = async (title: string, description = "", properties = false) => {
    await add.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(translate("intake.titleField")).fill(title);
    if (description) {
      const editor = dialog.getByTestId("description-editor").locator('[contenteditable="true"]');
      await editor.fill(description);
      await editor.press("Control+A");
      await dialog.getByRole("toolbar").getByRole("button", { name: translate("wiki.tool.bold") }).click();
    }
    if (properties) {
      await dialog.getByLabel(translate("workItems.assignees")).selectOption(userRow!.id);
      await dialog.getByLabel(translate("workItems.labels")).selectOption(createdLabel.id);
      await dialog.getByLabel(translate("workItems.dueDate")).fill("2030-05-06");
    }
    await dialog.getByRole("button", { name: translate("intake.submit"), exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  };
  const detail = page.getByRole("region", { name: translate("intake.detail") });
  const decide = async (key: string, label: string) => {
    await page.getByTestId(`intake-${key}`).click();
    await detail.getByRole("button", { name: label, exact: true }).click();
  };

  await page.getByRole("link", { name: translate("intake.title") }).click();
  await add.waitFor();
  check(await page.getByRole("tab", { name: translate("intake.tab.open") }).getAttribute("aria-selected") === "true", "Open tab is not the default");
  await submit("Dark mode please", "Users want a dark theme", true);
  await page.getByTestId("intake-MOB-1").waitFor();
  await detail.getByLabel(translate("intake.titleField")).waitFor();
  check(await detail.getByLabel(translate("intake.titleField")).inputValue() === "Dark mode please", "created title was not available for inline editing");
  await detail.getByTestId("description-editor").locator("strong").getByText("Users want a dark theme").waitFor();
  await submit("Secondary draft");
  await detail.locator("header").getByText("MOB-2", { exact: true }).waitFor();
  await page.getByTestId("intake-MOB-1").click();
  await detail.locator("header").getByText("MOB-1", { exact: true }).waitFor();
  await detail.getByLabel(translate("intake.titleField")).fill("Dark theme please");
  await detail.getByLabel(translate("intake.priority")).selectOption("high");
  await detail.getByLabel(translate("workItems.assignees")).selectOption(userRow!.id);
  await detail.getByLabel(translate("workItems.labels")).selectOption(createdLabel.id);
  await detail.getByLabel(translate("workItems.dueDate")).fill("2030-05-07");
  const editing = detail.getByTestId("description-editor").locator('[contenteditable="true"]');
  await editing.fill("Updated request");
  check(await page.evaluate(() => Object.values(sessionStorage).some((value) => value.includes("Updated request"))), "rich-text changes were not retained as a draft");
  await detail.getByRole("toolbar").getByRole("button", { name: translate("editor.sourceMode") }).click();
  await detail.getByTestId("editor-source-text").fill("**Updated request**");
  await detail.getByRole("toolbar").getByRole("button", { name: translate("editor.sourceMode") }).click();
  await page.getByTestId("intake-MOB-2").click();
  await detail.locator("header").getByText("MOB-2", { exact: true }).waitFor();
  await page.getByTestId("intake-MOB-1").click();
  await detail.locator("header").getByText("MOB-1", { exact: true }).waitFor();
  await detail.getByLabel(translate("intake.titleField")).waitFor();
  const switchedTitle = await detail.getByLabel(translate("intake.titleField")).inputValue();
  check(switchedTitle === "Dark theme please", `switching items discarded the title draft: ${switchedTitle}; id=${await detail.locator("header span").first().innerText()}`);
  const draftEditorText = await detail.getByTestId("description-editor").locator('[contenteditable="true"]').innerText();
  check(draftEditorText.includes("Updated request"), `rich-text draft was not restored: ${draftEditorText}`);
  await detail.getByTestId("description-editor").locator("strong").getByText("Updated request").waitFor();
  const afterEditorTitle = await detail.getByLabel(translate("intake.titleField")).inputValue();
  check(afterEditorTitle === "Dark theme please", `switching items discarded the title draft: ${afterEditorTitle}`);
  await page.route("**/actions/update_intake_item", (route) => route.abort());
  await detail.getByRole("button", { name: translate("intake.save"), exact: true }).click();
  await detail.getByRole("alert").waitFor();
  const retainedTitle = await detail.getByLabel(translate("intake.titleField")).inputValue();
  check(retainedTitle === "Dark theme please", `failed save discarded title draft: ${retainedTitle}`);
  await detail.getByTestId("description-editor").locator('[contenteditable="true"]').getByText("Updated request").waitFor();
  await page.unroute("**/actions/update_intake_item");
  await detail.getByRole("button", { name: translate("intake.save"), exact: true }).click();
  await detail.getByLabel(translate("intake.titleField")).waitFor();
  await expectValue(detail.getByLabel(translate("intake.titleField")), "Dark theme please", "saved title");
  await expectValue(detail.getByLabel(translate("workItems.dueDate")), "2030-05-07", "saved due date");
  await page.reload();
  await page.getByRole("link", { name: translate("intake.title") }).click();
  const reopened = page.getByRole("region", { name: translate("intake.detail") });
  await page.getByTestId("intake-MOB-1").click();
  await reopened.locator("header").getByText("MOB-1", { exact: true }).waitFor();
  await expectValue(reopened.getByLabel(translate("intake.titleField")), "Dark theme please", "reopened title");
  await expectValue(reopened.getByLabel(translate("intake.priority")), "high", "reopened priority");
  await expectValue(reopened.getByLabel(translate("workItems.dueDate")), "2030-05-07", "reopened due date");
  check(JSON.stringify(await reopened.getByLabel(translate("workItems.assignees")).evaluate((node: HTMLSelectElement) => [...node.selectedOptions].map((option) => option.value))) === JSON.stringify([userRow!.id]), "assignee did not survive reload");
  check(JSON.stringify(await reopened.getByLabel(translate("workItems.labels")).evaluate((node: HTMLSelectElement) => [...node.selectedOptions].map((option) => option.value))) === JSON.stringify([createdLabel.id]), "label did not survive reload");
  await reopened.getByTestId("description-editor").locator("strong").getByText("Updated request").waitFor();
  await submit("Export to CSV");
  await submit("Slow search");
  await page.getByTestId("intake-MOB-4").waitFor();
  await page.getByTestId("intake-open-count").getByText("4", { exact: true }).waitFor();
  await page.screenshot({ path: `${shots}/intake-1440-light.png` });

  // Triage items stay out of the normal list and out of search.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  // Only Triage items exist in the project, so its list shows the empty state, not status groups.
  await page.getByRole("status").filter({ hasText: translate("workItems.emptyHint") }).waitFor();
  check(await page.getByRole("link", { name: /Dark theme please/ }).count() === 0, "a Triage work item showed in the project list");
  await page.goto(`${web}/${slug}/projects/MOB/intake`);

  // Accept MOB-1: it leaves Open and shows in Closed as Accepted.
  await decide("MOB-1", translate("intake.accept"));
  await page.getByTestId("intake-MOB-1").waitFor({ state: "detached" });
  // Decline MOB-2.
  await decide("MOB-2", translate("intake.reject"));
  await page.getByTestId("intake-MOB-2").waitFor({ state: "detached" });
  // Snooze MOB-3 from the more menu: it stays in Open, marked Snoozed.
  await page.getByTestId("intake-MOB-3").click();
  await detail.getByRole("button", { name: translate("intake.more") }).click();
  await page.getByRole("menuitem", { name: translate("intake.snooze"), exact: true }).click();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  await page.getByRole("dialog").getByLabel(translate("intake.snoozeTill")).fill(`${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T10:00`);
  await page.getByRole("dialog").getByRole("button", { name: translate("intake.snooze"), exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByTestId("intake-MOB-3").getByTestId("intake-status").getByText(translate("intake.status.snoozed")).waitFor();
  await page.getByTestId("intake-MOB-3").click();
  await detail.getByRole("button", { name: translate("intake.unsnooze"), exact: true }).click();
  await page.getByTestId("intake-MOB-3").getByTestId("intake-status").getByText(translate("intake.status.pending")).waitFor();
  // Mark MOB-4 as duplicate of the accepted MOB-1.
  await page.getByTestId("intake-MOB-4").click();
  await detail.getByRole("button", { name: translate("intake.more") }).click();
  await page.getByRole("menuitem", { name: translate("intake.markDuplicate"), exact: true }).click();
  await page.getByRole("dialog").getByLabel(translate("intake.duplicateTo")).fill("MOB-9");
  await page.getByRole("dialog").getByRole("button", { name: translate("intake.markDuplicate"), exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await page.getByRole("dialog").getByLabel(translate("intake.duplicateTo")).fill("MOB-1");
  await page.getByRole("dialog").getByRole("button", { name: translate("intake.markDuplicate"), exact: true }).click();
  await page.getByTestId("intake-MOB-4").waitFor({ state: "detached" });

  // Open holds the unsnoozed MOB-3; Closed holds the three decided items.
  await page.getByTestId("intake-open-count").getByText("1", { exact: true }).waitFor();
  await page.getByRole("tab", { name: translate("intake.tab.closed") }).click();
  for (const [key, status] of [["MOB-1", "accepted"], ["MOB-2", "rejected"], ["MOB-4", "duplicate"]] as const) {
    await page.getByTestId(`intake-${key}`).getByText(translate(`intake.status.${status}`), { exact: true }).waitFor();
  }
  check(await page.getByTestId("intake-MOB-3").count() === 0, "snoozed item showed in Closed");
  await page.getByTestId("intake-MOB-4").click();
  await detail.getByText(translate("intake.duplicateOf").replace("{id}", "MOB-1")).waitFor();
  check(await detail.getByRole("button", { name: translate("intake.accept"), exact: true }).count() === 0, "decided item still offers Accept");
  await page.screenshot({ path: `${shots}/intake-closed-1440-light.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/intake-390-light.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Only the accepted item reaches the project list; declined, snoozed and duplicate stay out.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: /Dark theme please/ }).waitFor();
  for (const title of ["Export to CSV", "Slow search", "Typo on home"]) check(await page.getByRole("link", { name: new RegExp(title) }).count() === 0, `${title} showed in the project list`);
  console.log("e2e intake: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  // The flow commits real rows (the servers use their own connections), so remove them: other tests expect an empty instance.
  e2eDatabase ??= createDatabase();
  await e2eDatabase.db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await e2eDatabase.db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await e2eDatabase.client.end();
}
process.exit(failed ? 1 : 0);
