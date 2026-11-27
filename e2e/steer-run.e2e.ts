// Browser end-to-end flow: a person mentions an Agent while its Run on the Weft server is active, and the comment joins that Run (a Steer).
// No Follow-up Run appears, the Wake outcome says steered, and the Run page shows the comment as a message from the person at its place.
// The model is a scripted fake: the first step waits until this flow releases it, and the next step answers the steered comment. Screenshots go to STEER_SCREENSHOT_DIR (default /tmp). Run with `bun e2e/steer-run.e2e.ts`.
import { createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import { inArray, like } from "drizzle-orm";
import { agents, createDatabase, jobs, users, workspaces } from "../packages/db/src";
import { createAgentActions, createJobHandlers, runNextJob, type RunModel } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31181);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52181);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.STEER_SCREENSHOT_DIR ?? "/tmp";
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

let failed = false;
let stopWorker = false;
const { client, db } = createDatabase();

// The first step waits until the flow releases it. A steered comment makes the Run take a second step, which answers it.
let release!: () => void;
const released = new Promise<void>((resolve) => { release = resolve; });
let markStarted!: () => void;
const started = new Promise<void>((resolve) => { markStarted = resolve; });
let steps = 0;
const model: RunModel = {
  async step(request) {
    const usage = { inputTokens: 10, outputTokens: 5 };
    steps += 1;
    if (steps === 1) {
      markStarted();
      await released;
      return { text: "First answer.", toolCalls: [], usage };
    }
    const steered = JSON.stringify(request.messages).includes("Also check the Safari redirect.");
    return { text: steered ? "Second answer: checked the Safari redirect." : "Second answer.", toolCalls: [], usage };
  },
};
const handlers = createJobHandlers(undefined, { runModel: model });
const worker = (async () => { while (!stopWorker) { const result = await runNextJob(db, handlers); if (result.status === "idle") await Bun.sleep(200); } })();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" }, api, web, {
    account: { name: "Steer Tester", email },
    workspace: { name: "E2E team", slug },
    project: { name: "Mobile", key: "MOB", visibility: "public", shape: "simple" },
  });
  const page = await context.newPage();
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });

  // An Admin creates an Agent that may work in every project; the Agent runs on the server.
  const agent = await createAgentActions(db).createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Helper Bot", instructions: "Answer the newest request.", model: "default" });
  await createAgentActions(db).setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const item = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Login page" });
  const longLogToken = "x".repeat(160);
  const mention = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: agent.userId, label: "Helper Bot" } }, { type: "text", text: ` ${text}` }] }] });

  // Assigning the Agent starts its Run; the Run waits in the model until this flow releases it.
  const assigned = await call<{ wakeOutcomes: Array<{ status: string }> }>("update_work_item", { workItemId: item.id, assigneeIds: [agent.userId] });
  if (assigned.wakeOutcomes[0]?.status !== "started") throw new Error("the assignment did not start the Run");
  // The first step is under way (the Run is running): the person mentions the busy Agent again, so the comment joins the active Run (a Steer) during that step.
  await Promise.race([started, Bun.sleep(30_000).then(() => { throw new Error("the Run's first step did not start"); })]);
  const steered = await call<{ wakeOutcomes: Array<{ status: string }> }>("create_comment", { workItemId: item.id, body: mention(`Also check the Safari redirect. ${longLogToken}`) });
  if (steered.wakeOutcomes[0]?.status !== "steered") throw new Error("the mention during the active Run did not steer it");
  console.log("steer: the mention joins the active Run; the Wake outcome says steered");

  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const panel = page.getByTestId("runs-panel");
  await panel.getByText(translate("runs.status.running"), { exact: true }).first().waitFor({ timeout: 30_000 });
  release();
  await panel.getByText(translate("runs.status.completed"), { exact: true }).first().waitFor({ timeout: 60_000 });
  await page.reload();
  // The transcript is folded until a person opens it.
  const show = page.getByTestId("runs-panel").getByRole("button", { name: translate("runs.showTranscript") });
  await show.first().click({ timeout: 30_000 }).catch(() => { /* already open */ });
  const message = page.getByTestId("runs-panel").locator('[data-step="person"]');
  await message.waitFor({ timeout: 30_000 });
  if (await page.getByTestId("runs-panel").getByText(translate("runs.status.follow_up"), { exact: true }).count() > 0) throw new Error("a Follow-up Run exists for a steered mention");
  if (await page.getByTestId("runs-panel").getByText(translate("runs.status.completed"), { exact: true }).count() !== 1) throw new Error("the steered comment made a second Run");
  await panel.scrollIntoViewIfNeeded();
  await Bun.write(`${shots}/steer-run-desktop-1440.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  await message.waitFor();
  await panel.scrollIntoViewIfNeeded();
  const phoneFits = await page.evaluate(() => {
    const transcript = document.querySelector('[data-testid="run-transcript-content"]');
    const card = transcript?.closest("li[data-run-status]");
    return Boolean(transcript && card && document.documentElement.scrollWidth <= window.innerWidth && card.getBoundingClientRect().right <= window.innerWidth);
  });
  if (!phoneFits) throw new Error("long transcript content overflows the phone viewport");
  await Bun.write(`${shots}/steer-run-phone-390.png`, await page.screenshot({ fullPage: true }));
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("steer: the Run page shows the steered comment as a message from the person, and no Follow-up Run exists");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  release();
  stopWorker = true;
  await worker;
  for (const server of servers) server.kill();
  const mine = await db.select({ id: workspaces.id }).from(workspaces).where(like(workspaces.slug, "e2e-%"));
  const bots = mine.length === 0 ? [] : await db.select({ userId: agents.userId }).from(agents).where(inArray(agents.workspaceId, mine.map((row) => row.id)));
  await db.delete(jobs);
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  if (bots.length > 0) await db.delete(users).where(inArray(users.id, bots.map((row) => row.userId)));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
