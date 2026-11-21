// Notification Inbox navigation, read state and responsive layout.
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, notifications, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3118);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5218);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = "/home/plong/workspace/weft/.local/ai-ux-reliability/12-notification-inbox";
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await Bun.$`mkdir -p ${shots}`;
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Inbox Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Inbox team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();

  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspace = me.workspaces.find((item) => item.slug === slug)!;
  const project = await call<{ id: string }>("get_project", { workspaceId: workspace.id, key: "MOB" });
  const item = await call<{ id: string; sequence: number }>("create_work_item", { projectId: project.id, title: "Inbox destination" });
  const database = createDatabase();
  await database.db.insert(notifications).values({ workspaceId: workspace.id, userId: me.user.id, actorId: me.user.id, kind: "mention", workItemId: item.id, jobId: crypto.randomUUID() });
  const fixtureInbox = await call<{ unreadCount: number; notifications: Array<{ id: string }> }>("list_notifications", { workspaceId: workspace.id });
  check(fixtureInbox.unreadCount === 1, `notification fixture was not visible to the member: ${JSON.stringify(fixtureInbox)}`);

  await page.goto(`${web}/${slug}/notifications`);
  const inboxNav = page.locator(`a[href="/${slug}/notifications"]`).first();
  await inboxNav.waitFor();
  await page.waitForFunction((label) => [...document.querySelectorAll(`a[href="/${location.pathname.split("/")[1]}/notifications"]`)].some((link) => link.textContent?.includes("Inbox") && link.getAttribute("aria-label")?.includes(label)), translate("inbox.unread").replace("{count}", "1"));
  await page.getByRole("link", { name: /MOB-1 Inbox destination/ }).waitFor();
  await page.getByRole("link", { name: translate("topbar.notifications") }).waitFor();
  await page.getByRole("button", { name: translate("inbox.markAllRead") }).waitFor();
  await page.getByRole("button", { name: new RegExp(translate("inbox.unreadTab")) }).waitFor();
  await page.screenshot({ path: `${shots}/inbox-1440.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "desktop Inbox overflows horizontally");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/inbox-390.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile Inbox overflows horizontally");
  await page.goto(`${web}/${slug}`);
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  const drawer = page.getByRole("dialog", { name: translate("shell.sidebar") });
  const navEntry = drawer.locator(`a[href="/${slug}/notifications"]`);
  await navEntry.waitFor();
  check((await navEntry.getAttribute("aria-label"))?.includes(translate("inbox.unread").replace("{count}", "1")) ?? false, "mobile Inbox navigation does not show the unread count");
  await navEntry.click();
  await page.waitForURL(`${web}/${slug}/notifications`);
  await drawer.waitFor({ state: "detached" });
  check(await drawer.count() === 0, "mobile navigation drawer did not close after route change");

  await page.getByRole("link", { name: /MOB-1 Inbox destination/ }).click();
  await page.getByRole("heading", { name: "MOB-1" }).waitFor();
  const read = await call<{ unreadCount: number }>("list_notifications", { workspaceId: workspace.id });
  check(read.unreadCount === 0, "opening a reachable destination did not mark its notification read");
  await page.goto(`${web}/${slug}/notifications`);
  await page.getByRole("link", { name: /MOB-1 Inbox destination/ }).waitFor();
  await page.getByRole("button", { name: translate("inbox.markUnread") }).click();
  await page.waitForFunction((countLabel) => [...document.querySelectorAll('a[href$="/notifications"]')].some((link) => link.textContent?.includes("Inbox") && link.getAttribute("aria-label")?.includes(countLabel)), translate("inbox.unread").replace("{count}", "1"));
  const unread = await call<{ unreadCount: number }>("list_notifications", { workspaceId: workspace.id });
  check(unread.unreadCount === 1, "mark unread did not restore the unread count");
  await page.getByRole("button", { name: new RegExp(translate("inbox.unreadTab")) }).click();
  await page.getByRole("link", { name: /MOB-1 Inbox destination/ }).waitFor();
  await page.getByRole("button", { name: translate("inbox.markAllRead") }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('a[href$="/notifications"]')].some((link) => link.textContent?.includes("Inbox") && link.getAttribute("aria-label") === "Inbox"));
  const allRead = await call<{ unreadCount: number }>("list_notifications", { workspaceId: workspace.id });
  check(allRead.unreadCount === 0, "mark all read did not update the live unread count");
  console.log("e2e notification Inbox: navigation, responsive layout, read and unread updates ok");
  await browser.close();
  await database.client.end();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  const database = createDatabase();
  await database.db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await database.db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await database.client.end();
}
process.exit(failed ? 1 : 0);
