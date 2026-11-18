// Browser flow for an Admin deleting a Runtime whose Agent is bound to it: an offline Runtime with an enabled bound Agent refuses the delete, the refusal dialog offers
// "unbind Agents and delete" to the Admin, and choosing it deletes the Runtime, so its card disappears and the Agent is back on the Weft server. The refusal dialog is checked
// at phone width too. The Runtime is registered through the same actions the Daemon calls, so no CLI is started. Screenshots go to RUNTIME_UNBIND_SCREENSHOTS
// (default /tmp/weft-runtime-unbind-e2e). Run with `bun e2e/run-all.ts runtime-unbind-delete`.
import { chromium, type Page } from "playwright";
import { eq } from "drizzle-orm";
import { agents, createDatabase, runtimes, workspaces } from "../packages/db/src";
import { createAgentActions, createApiTokenActions, createRuntimeActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31193);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52193);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const screenshots = Bun.env.RUNTIME_UNBIND_SCREENSHOTS ?? "/tmp/weft-runtime-unbind-e2e";
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

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };

let failed = false;
const { client, db } = createDatabase();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await Bun.$`mkdir -p ${screenshots}`;
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page: Page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Unbind Tester");
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E unbind");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const ownerId = me.user.id;
  await db.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspaceId));

  // An offline Runtime that was shared, with an enabled Coder Agent bound to it. The creator of the workspace is its Admin.
  const runtimeActions = createRuntimeActions(db);
  const apiTokenId = (await createApiTokenActions(db).createApiToken.handler({ userId: ownerId }, { name: "busy daemon" })).id;
  const busy = await runtimeActions.registerDaemon.handler({ userId: ownerId, apiTokenId }, { hostname: "busy-box", version: "1", agentClis: ["claude"] });
  const busyRuntime = busy.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: ownerId }, { runtimeId: busyRuntime.id });
  const coder = await createAgentActions(db).createAgent.handler({ userId: ownerId }, { workspaceId, name: "Coder", model: "default", runtimeId: busyRuntime.id });
  await db.update(runtimes).set({ lastSeenAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(runtimes.id, busyRuntime.id));

  await page.goto(`${web}/${slug}/settings/runtimes`);
  const busyCard = page.locator("li", { hasText: "busy-box" }).first();
  await busyCard.waitFor();
  const dialog = page.getByRole("dialog");
  const confirmDelete = dialog.getByRole("button", { name: translate("runtimes.delete"), exact: true });

  // The refusal names the Coder Agent, and an Admin sees the choice to unbind the Agents and delete.
  await busyCard.getByRole("button", { name: translate("runtimes.delete"), exact: true }).first().click();
  await confirmDelete.click();
  await dialog.getByText(translate("runtimes.deleteRefusedAgents").replace("{names}", "Coder")).waitFor();
  const unbind = dialog.getByRole("button", { name: translate("runtimes.unbindAndDelete"), exact: true });
  await unbind.waitFor();
  check(await dialog.getByText(translate("runtimes.adminChoiceTitle")).isVisible(), "admin choice title missing");
  console.log("runtime-unbind-delete: the offline Runtime refuses the delete and the Admin sees the unbind choice");

  // Phone width: the refusal dialog with the Admin choices fits the viewport without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = await page.evaluate(() => {
    const panel = document.querySelector("[role=dialog]")?.getBoundingClientRect();
    return { noOverflow: document.documentElement.scrollWidth <= window.innerWidth, inside: !!panel && panel.left >= 0 && panel.right <= window.innerWidth };
  });
  await Bun.write(`${screenshots}/runtime-unbind-refused-390.png`, await page.screenshot());
  check(fits.noOverflow && fits.inside, `dialog at 390 px: ${JSON.stringify(fits)}`);
  console.log("runtime-unbind-delete: the refusal dialog with the Admin choices fits at 390 px with no sideways scroll");

  // The Admin chooses unbind and delete: the card disappears and the Coder Agent is back on the Weft server.
  await unbind.click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("li", { hasText: "busy-box" }).first().waitFor({ state: "detached" });
  const [after] = await db.select({ runtimeId: agents.runtimeId, autopilot: agents.autopilot }).from(agents).where(eq(agents.id, coder.id));
  check(after?.runtimeId === null && after?.autopilot === false, `Coder after unbind: ${JSON.stringify(after)}`);
  console.log("runtime-unbind-delete: the Admin unbinds the Agents and deletes; the card disappears and Coder is back on the Weft server");

  await browser.close();
  console.log("runtime-unbind-delete: passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  await client.end();
}
process.exit(failed ? 1 : 0);
