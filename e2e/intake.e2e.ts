// Browser end-to-end flow: submit a work item to Intake, accept it, check it leaves Triage and shows in the project list.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Locator, type Page } from "playwright";
import { eq, like } from "drizzle-orm";
import { createDatabase, projectMembers, projects as dbProjects, users, workspaces } from "../packages/db/src";
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
  const submit = async (title: string, description = "", properties = false, attach?: Array<{ name: string; mimeType: string; buffer: Buffer }>) => {
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
      const labels = dialog.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) });
      await labels.click();
      await page.getByRole("searchbox", { name: translate("picker.search"), exact: true }).fill("E2E label");
      await page.getByRole("menuitemcheckbox", { name: "E2E label", exact: true }).click();
      await dialog.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}: .*E2E label`) }).waitFor();
      await dialog.getByLabel(translate("workItems.dueDate")).fill("2030-05-06");
    }
    if (attach) {
      await dialog.getByTestId("intake-attach-input").setInputFiles(attach);
      await dialog.getByText(attach[0]!.name, { exact: true }).waitFor();
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
  // Exercise the submit-then-retry flow without depending on the local object store.
  let uploadAttempts = 0;
  let evidenceFailures = 0;
  let assetListed = false;
  const uploadedAssets: Array<{ id: string; ownerType: string; ownerId: string; uploaderId: string; filename: string; contentType: string; size: number; inline: boolean; createdAt: string }> = [];
  const assetNames = new Map<string, string>();
  await page.route("**/actions/request_asset_upload", (route) => {
    const input = route.request().postDataJSON() as { filename: string; ownerId: string };
    uploadAttempts += 1;
    if (input.filename === "evidence.txt" && evidenceFailures++ === 0) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "simulated failure" }) });
    const assetId = crypto.randomUUID();
    assetNames.set(assetId, input.filename);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ assetId, url: "http://storage.test/upload", fields: {}, maxBytes: 5 * 1024 * 1024 }) });
  });
  await page.route("http://storage.test/upload", (route) => route.fulfill({ status: 204 }));
  await page.route("**/actions/complete_asset_upload", (route) => {
    const request = route.request().postDataJSON() as { assetId: string };
    uploadedAssets.push({ id: request.assetId, ownerType: "work_item", ownerId: "", uploaderId: "", filename: assetNames.get(request.assetId) ?? "file", contentType: "text/plain", size: 8, inline: false, createdAt: new Date().toISOString() });
    assetListed = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(uploadedAssets.at(-1)) });
  });
  await page.route("**/actions/list_assets", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(assetListed ? uploadedAssets : []) }));
  await page.route("**/actions/list_work_item_activities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(uploadedAssets.map((asset) => ({ id: asset.id, field: "attachment_added", oldValue: null, newValue: { filename: asset.filename }, actorName: "Intake Tester", createdAt: asset.createdAt }))) }));
  await add.click();
  const intakeDialog = page.getByRole("dialog", { name: translate("intake.modalTitle") });
  const titleField = intakeDialog.getByLabel(translate("intake.titleField"));
  await titleField.waitFor();
  await page.waitForFunction(() => document.querySelector("dialog")?.matches(":modal"));
  await intakeDialog.click({ position: { x: 4, y: 4 } });
  check(await intakeDialog.count() === 1, "clicking blank dialog padding closed the Intake dialog");
  await intakeDialog.getByRole("button", { name: translate("intake.submit"), exact: true }).focus();
  await page.keyboard.press("Tab");
  const focusState = await intakeDialog.evaluate((element) => ({ modal: element.matches(":modal"), contained: element.contains(document.activeElement), active: document.activeElement?.outerHTML.slice(0, 120) }));
  check(focusState.modal && focusState.contained, `keyboard focus escaped the modal Intake dialog: ${JSON.stringify(focusState)}`);
  await intakeDialog.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }).click();
  await intakeDialog.getByRole("menuitemcheckbox").first().waitFor();
  await page.keyboard.press("Escape");
  await intakeDialog.getByRole("menuitemcheckbox").first().waitFor({ state: "detached" });
  check(await intakeDialog.getByRole("menuitemcheckbox").count() === 0, "Escape did not close the open labels popover");
  check(await intakeDialog.evaluate((element) => element.matches(":modal")), "Escape closed the Intake dialog while its labels popover was open");
  await page.keyboard.press("Escape");
  await intakeDialog.waitFor({ state: "detached" });
  check(await add.evaluate((element) => document.activeElement === element), "closing the Intake dialog did not restore focus to its trigger");
  await add.click();
  const backdropDialog = page.getByRole("dialog", { name: translate("intake.modalTitle") });
  await backdropDialog.getByLabel(translate("intake.titleField")).waitFor();
  await page.mouse.click(0, 0);
  await backdropDialog.waitFor({ state: "detached" });
  check(await add.evaluate((element) => document.activeElement === element), "backdrop click did not restore focus to the Intake trigger");
  await submit("Dark mode please", "Users want a dark theme", true, [
    { name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("evidence") },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("saved") },
  ]);
  check(uploadAttempts === 2, `expected two creation upload requests; saw ${uploadAttempts}`);
  await page.getByTestId("intake-MOB-1").waitFor();
  await detail.getByLabel(translate("intake.titleField")).waitFor();
  check(await detail.getByLabel(translate("intake.titleField")).inputValue() === "Dark mode please", "created title was not available for inline editing");
  await detail.getByTestId("comment-editor").locator('[contenteditable="true"]').fill("Review discussion before acceptance");
  await detail.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  await detail.getByText("Review discussion before acceptance", { exact: true }).waitFor();
  await detail.getByTestId("description-editor").locator("strong").getByText("Users want a dark theme").waitFor();
  await detail.getByRole("alert").getByText("evidence.txt").waitFor();
  await detail.getByTestId("attachments").getByText("notes.txt").waitFor();
  await detail.getByRole("button", { name: translate("assets.retryFailed") }).click();
  await detail.getByTestId("attachments").getByText("evidence.txt").waitFor();
  await detail.getByText(new RegExp(`${translate("intake.attachmentAdded")}: evidence.txt`)).waitFor();
  await detail.getByTestId("attachments").getByText("notes.txt").waitFor();
  check(uploadAttempts === 3, `expected one successful upload, one failed upload and one retry; saw ${uploadAttempts} requests`);
  const chooser = page.waitForEvent("filechooser");
  await detail.getByTestId("attachment-dropzone").click();
  await chooser;
  // Workspace Admin access overrides a project Guest role for decisions.
  await e2eDatabase.db.update(projectMembers).set({ role: "Guest" }).where(eq(projectMembers.userId, userRow!.id));
  await page.reload();
  await page.getByTestId("intake-MOB-1").click();
  await detail.getByRole("button", { name: translate("intake.accept"), exact: true }).waitFor();
  await e2eDatabase.db.update(projectMembers).set({ role: "Admin" }).where(eq(projectMembers.userId, userRow!.id));
  await page.reload();
  await page.getByTestId("intake-MOB-1").click();
  await detail.getByLabel(translate("intake.titleField")).waitFor();
  await submit("Secondary draft");
  await detail.locator("header").getByText("MOB-2", { exact: true }).waitFor();
  await page.getByTestId("intake-MOB-1").click();
  await detail.locator("header").getByText("MOB-1", { exact: true }).waitFor();
  await detail.getByLabel(translate("intake.titleField")).fill("Dark theme please");
  await detail.getByLabel(translate("intake.priority")).selectOption("high");
  await detail.getByLabel(translate("workItems.assignees")).selectOption(userRow!.id);
  await detail.getByTestId("comment-editor").locator('[contenteditable="true"]').fill("Keep the draft");
  await detail.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  await detail.getByText("Keep the draft", { exact: true }).waitFor();
  await detail.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}: .*E2E label`) }).waitFor();
  await detail.getByLabel(translate("workItems.dueDate")).fill("2030-05-07");
  await page.reload();
  await page.getByTestId("intake-MOB-1").click();
  await detail.locator("header").getByText("MOB-1", { exact: true }).waitFor();
  await detail.getByLabel(translate("intake.priority")).selectOption("high");
  check(await detail.getByLabel(translate("intake.titleField")).inputValue() === "Dark theme please", "editing after reload discarded the draft");
  const editing = detail.getByTestId("description-editor").locator('[contenteditable="true"]');
  await editing.fill("Updated request");
  check(await page.evaluate(() => Object.values(sessionStorage).some((value) => value.includes("Updated request"))), "rich-text changes were not retained as a draft");
  await detail.getByTestId("description-toolbar").getByRole("button", { name: translate("editor.sourceMode") }).click();
  await detail.getByTestId("editor-source-text").fill("**Updated request**");
  await detail.getByTestId("description-toolbar").getByRole("button", { name: translate("editor.sourceMode") }).click();
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
  await page.route("**/actions/update_intake_item", async (route) => { await Bun.sleep(500); await route.abort(); });
  await detail.getByRole("button", { name: translate("intake.save"), exact: true }).click();
  await detail.getByLabel(translate("workItems.dueDate")).fill("2030-05-09");
  await detail.getByRole("alert").waitFor();
  await expectValue(detail.getByLabel(translate("workItems.dueDate")), "2030-05-09", "edit during failed save");
  const retainedTitle = await detail.getByLabel(translate("intake.titleField")).inputValue();
  check(retainedTitle === "Dark theme please", `failed save discarded title draft: ${retainedTitle}`);
  await detail.getByTestId("description-editor").locator('[contenteditable="true"]').getByText("Updated request").waitFor();
  await page.unroute("**/actions/update_intake_item");
  await page.route("**/actions/update_intake_item", async (route) => { const response = await route.fetch(); await Bun.sleep(500); await route.fulfill({ response }); }, { times: 1 });
  await detail.getByRole("button", { name: translate("intake.save"), exact: true }).click();
  await detail.getByLabel(translate("workItems.dueDate")).fill("2030-05-08");
  await detail.getByRole("button", { name: translate("intake.save"), exact: true }).waitFor({ state: "visible" });
  await expectValue(detail.getByLabel(translate("workItems.dueDate")), "2030-05-08", "edit during save");
  await detail.getByRole("button", { name: translate("intake.save"), exact: true }).click();
  await detail.getByLabel(translate("intake.titleField")).waitFor();
  await expectValue(detail.getByLabel(translate("intake.titleField")), "Dark theme please", "saved title");
  await expectValue(detail.getByLabel(translate("workItems.dueDate")), "2030-05-08", "saved due date");
  await page.reload();
  await page.getByRole("link", { name: translate("intake.title") }).click();
  const reopened = page.getByRole("region", { name: translate("intake.detail") });
  await page.getByTestId("intake-MOB-1").click();
  await reopened.locator("header").getByText("MOB-1", { exact: true }).waitFor();
  await expectValue(reopened.getByLabel(translate("intake.titleField")), "Dark theme please", "reopened title");
  await expectValue(reopened.getByLabel(translate("intake.priority")), "high", "reopened priority");
  await expectValue(reopened.getByLabel(translate("workItems.dueDate")), "2030-05-08", "reopened due date");
  check(JSON.stringify(await reopened.getByLabel(translate("workItems.assignees")).evaluate((node: HTMLSelectElement) => [...node.selectedOptions].map((option) => option.value))) === JSON.stringify([userRow!.id]), "assignee did not survive reload");
  check((await reopened.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}: .*E2E label`) }).count()) === 1, `label did not survive reload (${createdLabel.id})`);
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
  await page.getByTestId("intake-MOB-1").click();
  await detail.getByRole("button", { name: translate("intake.accept"), exact: true }).click();
  const acceptDialog = page.getByRole("dialog", { name: translate("intake.acceptIntoState") });
  const targetState = acceptDialog.getByLabel(translate("workItems.state"));
  await page.waitForFunction(() => {
    const select = document.querySelector<HTMLSelectElement>('dialog select[aria-label="State"]');
    return select?.options.length && [...select.options].some((option) => option.textContent === "Backlog") && [...select.options].some((option) => option.textContent === "Done") && [...select.options].some((option) => option.textContent === "Cancelled");
  });
  const backlogId = await targetState.locator("option", { hasText: "Backlog" }).getAttribute("value");
  check(await targetState.inputValue() === backlogId, "accept did not default to the first Backlog State");
  await targetState.selectOption({ label: "Done" });
  await acceptDialog.getByRole("button", { name: translate("intake.accept"), exact: true }).click();
  await acceptDialog.waitFor({ state: "detached" });
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
  await detail.locator("header").getByText("MOB-4", { exact: true }).waitFor();
  await detail.getByTestId("comment-editor").locator('[contenteditable="true"]').fill("Keep the duplicate decision discussion");
  await detail.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  await detail.getByText("Keep the duplicate decision discussion", { exact: true }).waitFor();
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
  await page.route("**/actions/list_intake_items", async (route) => {
    const response = await route.fetch();
    const items = await response.json() as Array<Record<string, unknown>>;
    for (const item of items) if (item.displayId === "MOB-4") { item.descriptionText = ""; item.descriptionMarkdown = "![[asset:11111111-1111-4111-8111-111111111111]]"; }
    await route.fulfill({ response, json: items });
  });
  await page.getByRole("tab", { name: translate("intake.tab.closed") }).click();
  for (const [key, status] of [["MOB-1", "accepted"], ["MOB-2", "rejected"], ["MOB-4", "duplicate"]] as const) {
    await page.getByTestId(`intake-${key}`).getByText(translate(`intake.status.${status}`), { exact: true }).waitFor();
  }
  check(await page.getByTestId("intake-MOB-3").count() === 0, "snoozed item showed in Closed");
  await page.getByTestId("intake-MOB-4").click();
  await detail.locator("header").getByText("MOB-4", { exact: true }).waitFor();
  await detail.getByTestId("description-editor").locator(".asset-image-node").waitFor();
  await page.unroute("**/actions/list_intake_items");
  await detail.getByText(translate("intake.duplicateOf").replace("{id}", "MOB-1")).waitFor();
  check(await detail.getByRole("button", { name: translate("intake.accept"), exact: true }).count() === 0, "decided item still offers Accept");
  await page.screenshot({ path: `${shots}/intake-closed-1440-light.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/intake-390-light.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  const { client: inviteClient, db: inviteDb } = createDatabase();
  const guestWorkspaceRow = await inviteDb.query.workspaces.findFirst({ where: (table, { eq }) => eq(table.slug, slug) });
  if (!guestWorkspaceRow) throw new Error("E2E workspace was not persisted");
  const guestSignup = async (name: string, suffix: string) => {
    const response = await page.request.post(`${api}/actions/create_invite`, { data: { workspaceId: guestWorkspaceRow.id, role: "Guest" } });
    const invite = await response.json() as { token: string };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    const guestPage = await context.newPage();
    await guestPage.goto(`${web}/invite/${invite.token}`);
    await guestPage.getByLabel(translate("auth.name")).fill(name);
    await guestPage.getByLabel(translate("auth.email")).fill(`${slug}-${suffix}@example.test`);
    await guestPage.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
    await guestPage.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
    await guestPage.getByRole("button", { name: translate("auth.signUp") }).click();
    await guestPage.waitForURL(`${web}/${slug}`);
    await guestPage.goto(`${web}/${slug}/projects/MOB/intake`);
    await guestPage.getByRole("button", { name: translate("intake.add"), exact: true }).waitFor();
    return { context, page: guestPage };
  };
  const firstGuest = await guestSignup("Intake Guest One", "guest-one");
  await firstGuest.page.getByRole("button", { name: translate("intake.add"), exact: true }).click();
  const guestDialog = firstGuest.page.getByRole("dialog");
  await guestDialog.getByLabel(translate("intake.titleField")).fill("Guest private request");
  await guestDialog.getByRole("button", { name: translate("intake.submit"), exact: true }).click();
  await firstGuest.page.getByText("Guest private request", { exact: true }).waitFor();
  const guestDetail = firstGuest.page.getByRole("region", { name: translate("intake.detail") });
  check(await guestDetail.getByRole("button", { name: translate("intake.accept"), exact: true }).count() === 0, "a Guest saw decision controls");
  await guestDetail.getByTestId("comment-editor").locator('[contenteditable="true"]').fill("Guest discussion");
  await guestDetail.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  await guestDetail.getByText("Guest discussion", { exact: true }).waitFor();
  const secondGuest = await guestSignup("Intake Guest Two", "guest-two");
  check(await secondGuest.page.getByText("Guest private request", { exact: true }).count() === 0, "a Guest could see another Guest's Intake item");
  await firstGuest.context.close();
  await secondGuest.context.close();
  await inviteClient.end();

  // Only the accepted item reaches the project list; declined, snoozed and duplicate stay out.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: /Dark theme please/ }).waitFor();
  for (const title of ["Export to CSV", "Slow search", "Typo on home"]) check(await page.getByRole("link", { name: new RegExp(title) }).count() === 0, `${title} showed in the project list`);

  // A failed image transfer and a failed description save both retain their inline intent.
  await page.goto(`${web}/${slug}/projects/MOB/intake`);
  let imageFailure = true;
  await page.route("**/actions/request_asset_upload", async (route) => {
    const input = route.request().postDataJSON() as { filename: string };
    if (input.filename === "retry.png" && imageFailure) { imageFailure = false; await Bun.sleep(500); return route.fulfill({ status: 500 }); }
    return route.fallback();
  });
  let imageUpdateAttempts = 0;
  let retriedDescription: unknown;
  await page.route("**/actions/update_intake_item", async (route) => {
    imageUpdateAttempts += 1;
    if (imageUpdateAttempts === 1) return route.fulfill({ status: 500 });
    retriedDescription = (route.request().postDataJSON() as { description: unknown }).description;
    await Bun.sleep(500);
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await add.click();
  const imageDialog = page.getByRole("dialog");
  await imageDialog.getByLabel(translate("intake.titleField")).fill("Images retry");
  await imageDialog.getByTestId("intake-inline-image-input").setInputFiles([
    { name: "retry.png", mimeType: "image/png", buffer: Buffer.from("image one") },
    { name: "saved.png", mimeType: "image/png", buffer: Buffer.from("image two") },
  ]);
  await imageDialog.getByRole("button", { name: translate("intake.submit"), exact: true }).click();
  check(await imageDialog.getByRole("button", { name: translate("intake.submit"), exact: true }).isDisabled(), "submission remained enabled during upload");
  check(await imageDialog.getByRole("button", { name: translate("intake.cancel"), exact: true }).last().isDisabled(), "submission could be dismissed during upload");
  check(await imageDialog.getByLabel(translate("intake.titleField")).isDisabled(), "submission fields remained editable during upload");
  await imageDialog.waitFor({ state: "detached" });
  await detail.getByRole("alert").getByText("retry.png").waitFor();
  await detail.getByRole("button", { name: translate("assets.retryFailed") }).click();
  await detail.getByTestId("description-editor").locator('[contenteditable="true"]').fill("Typing during retry");
  await detail.getByRole("alert").getByText("retry.png").waitFor({ state: "detached" });
  await detail.getByTestId("description-editor").getByText("Typing during retry").waitFor();
  const embedded = (retriedDescription as { content: Array<{ type: string }> }).content.filter((node) => node.type === "assetImage");
  check(imageUpdateAttempts === 2 && embedded.length === 2, "image retry did not preserve both inline images");
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
