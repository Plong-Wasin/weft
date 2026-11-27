// Browser flow for an Admin deleting a Runtime whose Agent is bound to it: an offline Runtime with an enabled bound Agent refuses the delete, the refusal dialog offers
// "unbind Agents and delete" to the Admin, and choosing it deletes the Runtime, so its card disappears and the Agent is back on the Weft server. The refusal dialog is checked
// at phone width too. The Runtime is registered through the same actions the Daemon calls, so no CLI is started. Screenshots go to RUNTIME_UNBIND_SCREENSHOTS
// (default /tmp/weft-runtime-unbind-e2e). Run with `bun e2e/run-all.ts runtime-unbind-delete`.
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import type { Page } from "playwright";
import { eq } from "drizzle-orm";
import { agents, createDatabase, runtimes, workspaces } from "../packages/db/src";
import { createAgentActions, createApiTokenActions, createRuntimeActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31193);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52193);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const screenshots = Bun.env.RUNTIME_UNBIND_SCREENSHOTS ?? "/tmp/weft-runtime-unbind-e2e";
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
    account: { name: "Unbind Tester", email },
    workspace: { name: "E2E unbind", slug },
  });
  const page: Page = await context.newPage();

  await page.goto(`${web}/${slug}`);
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
  const confirmDelete = dialog.getByRole("button", { name: translate("runtimes.deleteConfirm"), exact: true });

  // The refusal names the Coder Agent, and an Admin sees the choice to unbind the Agents and delete.
  await busyCard.getByRole("button", { name: translate("runtimes.delete"), exact: true }).first().click();
  await confirmDelete.click();
  await dialog.getByText(translate("runtimes.deleteRefusedAgentsAdmin").replace("{names}", "Coder")).waitFor();
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
  await saveShot(page, { path: `${screenshots}/runtime-unbind-refused-390.png` });
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
