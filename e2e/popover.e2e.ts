// Browser check for portal placement and dismissal of dropdowns inside a dialog.
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31420);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52420);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 } }, api, web, {
    account: { name: "Popover Tester", email: `${slug}@example.test` },
    workspace: { name: "Popover team", slug },
    project: { name: "Mobile", key: "POP", visibility: "public", shape: "full" },
  });
  const page = await context.newPage();
  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /POP · Mobile/ }).waitFor();

  const t = (key: string) => translate(key as never);
  await page.goto(`${web}/${slug}/projects/POP/modules`);
  await page.getByRole("button", { name: t("modules.addNew") }).click();
  const modal = page.getByRole("dialog", { name: t("modules.addTitleModal") });
  await modal.getByLabel(t("modules.name")).fill("Popover module");
  const statusTrigger = modal.getByRole("button", { name: new RegExp(`^${t("modules.status")}:`) });
  const modalScrollHeight = await modal.evaluate((element) => element.scrollHeight);
  await statusTrigger.click();
  const menu = page.locator('[role="menu"]').last();
  await menu.waitFor();
  check(await menu.evaluate((element, label) => element.closest("dialog")?.getAttribute("aria-label") === label, t("modules.addTitleModal")), "dropdown should stay inside its native modal");
  const menuScroll = await menu.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  check(menuScroll.scrollWidth <= menuScroll.clientWidth, `dropdown should not scroll sideways: ${JSON.stringify(menuScroll)}`);
  check(await modal.evaluate((element) => element.scrollHeight) === modalScrollHeight, "dropdown should not grow the dialog scroll area");

  const modalBounds = await modal.boundingBox();
  check(Boolean(modalBounds), "Module dialog has no layout box");
  await statusTrigger.evaluate((element, dialogBottom) => {
    const bounds = element.getBoundingClientRect();
    element.style.transform = `translateY(${dialogBottom - bounds.bottom - 8}px)`;
  }, modalBounds!.y + modalBounds!.height);
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  const menuBounds = await menu.boundingBox();
  const triggerBounds = await statusTrigger.boundingBox();
  check(Boolean(menuBounds && triggerBounds && menuBounds.y + menuBounds.height < triggerBounds.y), "dropdown should flip above a trigger near the bottom edge");
  await statusTrigger.evaluate((element) => { element.style.removeProperty("transform"); });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  check(await modal.isVisible(), "Escape should close the dropdown without closing its dialog");

  await statusTrigger.click();
  // The menu may open over the fields above its trigger: click the dialog's own padding, which it never covers.
  await modal.click({ position: { x: 8, y: 8 } });
  await menu.waitFor({ state: "detached" });
  check(await modal.isVisible(), "outside click should close the dropdown without closing its dialog");
  await modal.getByRole("button", { name: t("modules.cancel") }).click();
  await modal.waitFor({ state: "detached" });
  console.log("e2e popover: portal, dialog scroll, no sideways scroll, edge flip, Escape and outside click ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
