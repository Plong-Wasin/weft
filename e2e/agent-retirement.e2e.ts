// Browser end-to-end flow: an admin tries to delete an Agent that has written a comment, the settings dialog shows the refusal counts
// and offers Disable, disabling keeps the comment, and an Agent that never wrote anything is deleted after one confirmation. Runs at 1440 and 390 px.
// Run with `bun e2e/agent-retirement.e2e.ts`.
import { chromium, type Page } from "playwright";
import { eq, inArray, like } from "drizzle-orm";
import { agents, comments, createDatabase, jobs, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31191);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52191);
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
const { client, db } = createDatabase();

/** Saves a full-page screenshot into E2E_SHOT_DIR when that is set. */
async function shot(page: Page, name: string) {
  if (Bun.env.E2E_SHOT_DIR) await page.screenshot({ path: `${Bun.env.E2E_SHOT_DIR}/${name}`, fullPage: true });
}

/** Fails when the page scrolls sideways at the current width. */
async function assertNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) throw new Error(`${label}: page scrolls sideways by ${overflow}px`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Retirement Tester");
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Retire");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("RET");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /RET · Retire/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "RET" });

  // An admin creates two Agents: one will write a comment, the other never writes anything.
  await page.goto(`${web}/${slug}/settings/agents`);
  for (const name of ["Retire Bot", "Idle Bot"]) {
    await page.getByRole("button", { name: translate("agents.newAgent"), exact: true }).click();
    await page.getByLabel(translate("agents.name")).fill(name);
    await page.getByLabel(translate("agents.instructions")).fill("Triage new work.");
    // Each Agent already listed has its own (disabled) Save buttons; the creation form's one is the submit.
    await page.getByRole("button", { name: translate("agents.save") }).and(page.locator('[type="submit"]')).click();
    await page.locator(`[data-agent="${name}"]`).waitFor();
  }
  const retireBot = (await call<Array<{ id: string; userId: string; name: string }>>("list_agents", { workspaceId })).find((agent) => agent.name === "Retire Bot")!;
  const item = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Written on" });
  // The Agent's comment is written straight to the database: the flow tests the delete refusal, not how comments are posted.
  await db.insert(comments).values({ workspaceId, projectId: project.id, workItemId: item.id, authorId: retireBot.userId, body: { type: "doc", content: [] }, bodyMarkdown: "Triaged.", bodyText: "Triaged." });
  console.log("agent-retirement: an admin creates two Agents, one has written a comment");

  // At 1440 px: Delete on the Agent that wrote a comment opens the refusal dialog with the count and offers Disable.
  const card = page.locator('[data-agent="Retire Bot"]');
  const buttons = await card.getByRole("button").allTextContents();
  const disableAt = buttons.indexOf(translate("agents.disable"));
  const deleteAt = buttons.indexOf(translate("agents.delete"));
  if (disableAt < 0 || deleteAt < 0 || disableAt > deleteAt) throw new Error(`Disable must come before Delete, got ${JSON.stringify(buttons)}`);
  await card.getByRole("button", { name: translate("agents.delete"), exact: true }).click();
  const dialog = card.getByRole("alertdialog");
  await dialog.waitFor();
  await dialog.getByTestId("retire-counts").getByText(`${translate("agents.retire.kind.comments")}: 1`, { exact: true }).waitFor();
  await assertNoHorizontalScroll(page, "1440 dialog");
  await shot(page, "retirement-refusal-1440.png");
  console.log("agent-retirement: at 1440 px the refusal dialog shows the comment count and Disable");

  // Disable from the dialog: the Agent is disabled, its comment stays, and the dialog closes.
  await dialog.getByRole("button", { name: translate("agents.disable"), exact: true }).click();
  await card.getByRole("button", { name: translate("agents.enable"), exact: true }).waitFor();
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  const kept = await db.select({ id: comments.id }).from(comments).where(eq(comments.authorId, retireBot.userId));
  if (kept.length !== 1) throw new Error(`expected the Agent's comment to stay, found ${kept.length}`);
  console.log("agent-retirement: Disable from the dialog keeps the comment and disables the Agent");

  // At 390 px the dialog still fits the screen, with no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await card.waitFor();
  await card.getByRole("button", { name: translate("agents.delete"), exact: true }).click();
  await card.getByRole("alertdialog").waitFor();
  // The counts are inside the 390 px screen, and an Agent that is already disabled is not offered Disable again.
  const narrowCounts = card.getByRole("alertdialog").getByTestId("retire-counts");
  await narrowCounts.waitFor();
  const narrowBox = await narrowCounts.boundingBox();
  if (!narrowBox || narrowBox.x < 0 || narrowBox.x + narrowBox.width > 390) throw new Error(`the counts must fit in 390 px, got ${JSON.stringify(narrowBox)}`);
  if ((await card.getByRole("alertdialog").getByRole("button", { name: translate("agents.disable"), exact: true }).count()) !== 0) throw new Error("a disabled Agent must not be offered Disable in the dialog");
  await assertNoHorizontalScroll(page, "390 dialog");
  await shot(page, "retirement-refusal-390.png");
  await card.getByRole("button", { name: translate("agents.retire.close"), exact: true }).click();
  console.log("agent-retirement: at 390 px the dialog fits without sideways scroll");

  // An Agent that never wrote anything is deleted after the one confirmation.
  page.once("dialog", (confirmation) => void confirmation.accept());
  await page.locator('[data-agent="Idle Bot"]').getByRole("button", { name: translate("agents.delete"), exact: true }).click();
  await page.locator('[data-agent="Idle Bot"]').waitFor({ state: "detached" });
  const remaining = await call<Array<{ name: string }>>("list_agents", { workspaceId });
  if (remaining.some((agent) => agent.name === "Idle Bot")) throw new Error("Idle Bot was not deleted");
  console.log("agent-retirement: an Agent with no content is still deleted");

  console.log("e2e agent-retirement: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  // Bot users are not removed with the workspace, and the jobs this flow queued must not linger for other test runs.
  const mine = await db.select({ id: workspaces.id }).from(workspaces).where(like(workspaces.slug, "e2e-%"));
  const bots = mine.length === 0 ? [] : await db.select({ userId: agents.userId }).from(agents).where(inArray(agents.workspaceId, mine.map((row) => row.id)));
  await db.delete(jobs);
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  if (bots.length > 0) await db.delete(users).where(inArray(users.id, bots.map((row) => row.userId)));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
