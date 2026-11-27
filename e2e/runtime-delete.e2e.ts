// Browser flow for deleting a Runtime from the Runtimes page: an offline Runtime with no Agent is deleted after the confirmation and its card disappears; an offline Runtime
// with an enabled bound Agent refuses the delete, and the dialog names that Agent. The dialog is checked at desktop and phone width. The Runtimes are registered through the
// same actions the Daemon calls, so no CLI is started. Screenshots go to RUNTIME_DELETE_SCREENSHOTS (default /tmp/weft-runtime-delete-e2e). Run with `bun e2e/run-all.ts runtime-delete`.
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import type { Page } from "playwright";
import { eq } from "drizzle-orm";
import { createDatabase, runtimes, workspaces } from "../packages/db/src";
import { createAgentActions, createApiTokenActions, createRuntimeActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31193);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52193);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const screenshots = Bun.env.RUNTIME_DELETE_SCREENSHOTS ?? "/tmp/weft-runtime-delete-e2e";
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

let failed = false;
const { client, db } = createDatabase();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await Bun.$`mkdir -p ${screenshots}`;
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" }, api, web, {
    account: { name: "Delete Tester", email },
    workspace: { name: "E2E delete", slug },
  });
  const page: Page = await context.newPage();

  await page.goto(`${web}/${slug}`);
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const ownerId = me.user.id;
  await db.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspaceId));

  // An idle Runtime that went offline two hours ago, and a Runtime with an enabled Coder Agent bound to it, offline too.
  const runtimeActions = createRuntimeActions(db);
  const tokenFor = async (name: string) => (await createApiTokenActions(db).createApiToken.handler({ userId: ownerId }, { name })).id;
  const idle = await runtimeActions.registerDaemon.handler({ userId: ownerId, apiTokenId: await tokenFor("idle daemon") }, { hostname: "delete-box", version: "1", agentClis: ["claude"] });
  const busy = await runtimeActions.registerDaemon.handler({ userId: ownerId, apiTokenId: await tokenFor("busy daemon") }, { hostname: "busy-box", version: "1", agentClis: ["claude"] });
  const busyRuntime = busy.runtimes[0]!;
  await runtimeActions.shareRuntime.handler({ userId: ownerId }, { runtimeId: busyRuntime.id });
  await createAgentActions(db).createAgent.handler({ userId: ownerId }, { workspaceId, name: "Coder", model: "default", runtimeId: busyRuntime.id });
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  await db.update(runtimes).set({ lastSeenAt: twoHoursAgo }).where(eq(runtimes.id, idle.runtimes[0]!.id));
  await db.update(runtimes).set({ lastSeenAt: twoHoursAgo }).where(eq(runtimes.id, busyRuntime.id));

  await page.goto(`${web}/${slug}/settings/runtimes`);
  const idleCard = page.locator("li", { hasText: "delete-box" }).first();
  const busyCard = page.locator("li", { hasText: "busy-box" }).first();
  await idleCard.waitFor();
  // The Runtime Delete button sits before the profile controls, which have a Delete of their own: hence `.first()` on the card.
  const dialog = page.getByRole("dialog");
  const confirmDelete = dialog.getByRole("button", { name: translate("runtimes.deleteConfirm"), exact: true });

  // The refusal first: the dialog names the enabled Agent and nothing is deleted.
  await busyCard.getByRole("button", { name: translate("runtimes.delete"), exact: true }).first().click();
  await confirmDelete.click();
  await dialog.getByText(translate("runtimes.deleteRefusedAgentsAdmin").replace("{names}", "Coder")).waitFor();
  check(await dialog.getByText(translate("runtimes.deleteRefusedTitle")).isVisible(), "refusal title missing");
  // The refusal replaces the confirm view under the focus: it must land on Close, never on a button that deletes.
  await page.waitForFunction((label) => document.activeElement?.textContent === label, translate("runtimes.deleteClose"), { timeout: 3000 }).catch(() => { throw new Error("focus must be on Close after a refusal"); });
  await page.keyboard.press("Escape");
  await busyCard.waitFor();
  console.log("runtime-delete: the busy Runtime refuses the delete and the dialog names the bound Coder Agent");

  // The idle Runtime: the confirmation says what is lost, then the card goes.
  await idleCard.getByRole("button", { name: translate("runtimes.delete"), exact: true }).first().click();
  await dialog.getByText(translate("runtimes.deleteBody")).waitFor();
  await confirmDelete.click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("li", { hasText: "delete-box" }).first().waitFor({ state: "detached" });
  console.log("runtime-delete: the idle Runtime is deleted after the confirmation and its card disappears");

  // Phone width: the refusal dialog fits the viewport without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator("li", { hasText: "busy-box" }).first().getByRole("button", { name: translate("runtimes.delete"), exact: true }).first().click();
  await confirmDelete.click();
  await dialog.getByText(translate("runtimes.deleteRefusedAgentsAdmin").replace("{names}", "Coder")).waitFor();
  const fits = await page.evaluate(() => {
    const panel = document.querySelector("[role=dialog]")?.getBoundingClientRect();
    return { noOverflow: document.documentElement.scrollWidth <= window.innerWidth, inside: !!panel && panel.left >= 0 && panel.right <= window.innerWidth };
  });
  await saveShot(page, { path: `${screenshots}/runtime-delete-refused-390.png` });
  check(fits.noOverflow && fits.inside, `dialog at 390 px: ${JSON.stringify(fits)}`);
  console.log("runtime-delete: the refusal dialog fits at 390 px with no sideways scroll");

  await browser.close();
  console.log("runtime-delete: passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  await client.end();
}
process.exit(failed ? 1 : 0);
