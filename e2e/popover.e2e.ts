// Browser check for portal placement and dismissal of dropdowns inside a dialog.
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31420);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52420);
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
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Popover Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  if (await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).count()) await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Popover team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("POP");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /POP · Mobile/ }).waitFor();

  const t = (key: string) => translate(key as never);
  await page.goto(`${web}/${slug}/projects/POP/modules`);
  await page.getByRole("button", { name: t("modules.addNew") }).click();
  const modal = page.getByRole("dialog", { name: t("modules.addTitleModal") });
  await modal.getByLabel(t("modules.name")).fill("Popover module");
  const statusTrigger = modal.getByRole("button").nth(1);
  const modalScrollHeight = await modal.evaluate((element) => element.scrollHeight);
  await statusTrigger.click();
  const menu = page.locator('[role="menu"]').last();
  await menu.waitFor();
  check(await menu.evaluate((element) => element.parentElement === document.body), "dropdown should render in a body portal");
  check(await modal.evaluate((element) => element.scrollHeight) === modalScrollHeight, "dropdown should not grow the dialog scroll area");

  await statusTrigger.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    element.style.transform = `translateY(${window.innerHeight - bounds.bottom - 8}px)`;
  });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  const menuBounds = await menu.boundingBox();
  const triggerBounds = await statusTrigger.boundingBox();
  check(Boolean(menuBounds && triggerBounds && menuBounds.y + menuBounds.height < triggerBounds.y), "dropdown should flip above a trigger near the bottom edge");
  await statusTrigger.evaluate((element) => { element.style.removeProperty("transform"); });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  check(await modal.isVisible(), "Escape should close the dropdown without closing its dialog");

  await statusTrigger.click();
  await modal.getByLabel(t("modules.name")).click();
  await menu.waitFor({ state: "detached" });
  check(await modal.isVisible(), "outside click should close the dropdown without closing its dialog");
  await modal.getByRole("button", { name: t("modules.cancel") }).click();
  await modal.waitFor({ state: "detached" });
  console.log("e2e popover: portal, dialog scroll, edge flip, Escape and outside click ok");
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
