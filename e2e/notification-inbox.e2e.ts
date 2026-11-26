// Notification Inbox navigation, read state and responsive layout.
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, notifications, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3118);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5218);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = "/home/plong/workspace/weft/.local/ai-ux-follow-up/05";
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
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();

  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspace = me.workspaces.find((item) => item.slug === slug)!;
  const project = await call<{ id: string }>("get_project", { workspaceId: workspace.id, key: "MOB" });
  const item = await call<{ id: string; sequence: number }>("create_work_item", { projectId: project.id, title: "Inbox destination" });
  const database = createDatabase();
  await database.db.insert(notifications).values({ workspaceId: workspace.id, userId: me.user.id, actorId: me.user.id, kind: "mention", workItemId: item.id, jobId: crypto.randomUUID() });
  await database.db.insert(notifications).values({ workspaceId: workspace.id, userId: me.user.id, actorId: me.user.id, kind: "secret_output_blocked", detail: null, readAt: new Date(), jobId: crypto.randomUUID() });
  await database.client.end();
  const fixtureInbox = await call<{ unreadCount: number; notifications: Array<{ id: string; workItemId: string | null }> }>("list_notifications", { workspaceId: workspace.id });
  check(fixtureInbox.unreadCount === 1, `notification fixture was not visible to the member: ${JSON.stringify(fixtureInbox)}`);
  const notificationId = fixtureInbox.notifications.find((notification) => notification.workItemId === item.id)!.id;

  await page.goto(`${web}/${slug}/notifications`);
  const inboxNav = page.locator(`a[href="/${slug}/notifications"]`).first();
  await inboxNav.waitFor();
  await page.waitForFunction((label) => [...document.querySelectorAll(`a[href="/${location.pathname.split("/")[1]}/notifications"]`)].some((link) => link.textContent?.includes("Inbox") && link.getAttribute("aria-label")?.includes(label)), translate("inbox.unread").replace("{count}", "1"));
  await page.getByRole("link", { name: /MOB-1 Inbox destination/ }).waitFor();
  const markReadButton = page.getByRole("button", { name: new RegExp(`${translate("inbox.markRead")}.*MOB-1 Inbox destination`) });
  await markReadButton.waitFor();
  const markReadLabelledBy = await markReadButton.getAttribute("aria-labelledby");
  check(markReadLabelledBy?.split(" ").some((id) => id.startsWith("notification-description-")) ?? false, "notification read action is not programmatically associated with its row");
  await page.getByText(translate("inbox.secretOutputBlockedDetail")).waitFor();
  check(await page.getByText(translate("inbox.secretOutputBlockedDetail")).count() === 1, "Runtime secret alert did not render a generic retry message");
  await page.getByRole("link", { name: translate("topbar.notifications") }).waitFor();
  await page.getByRole("button", { name: translate("inbox.markAllRead") }).waitFor();
  await page.getByRole("tab", { name: new RegExp(translate("inbox.unreadTab")) }).waitFor();
  await page.screenshot({ path: `${shots}/inbox-1440.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "desktop Inbox overflows horizontally");

  const topBarCenters = async () => page.evaluate((labels) => labels.map((label) => {
    const el = [...document.querySelectorAll("header a, header button")].find((node) => node.getAttribute("aria-label") === label);
    if (!el) return null;
    const box = (el.querySelector("svg") ?? el).getBoundingClientRect();
    return Math.round((box.top + box.height / 2) * 10) / 10;
  }), [translate("topbar.notifications"), translate("topbar.help")]);
  const [bellCenter, helpCenter] = await topBarCenters();
  check(bellCenter !== null && helpCenter !== null && Math.abs(bellCenter - helpCenter) <= 1, `top bar bell and help icon glyphs must share a vertical center at 1440px, found ${bellCenter} and ${helpCenter}`);
  // Touch layouts enlarge targets (pointer: coarse), which once left the bell link above its neighbours.
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(page.url(), { waitUntil: "domcontentloaded" });
  await touchPage.getByRole("link", { name: translate("topbar.notifications") }).waitFor();
  const [touchBellCenter, touchHelpCenter] = await touchPage.evaluate((labels) => labels.map((label) => {
    const el = [...document.querySelectorAll("header a, header button")].find((node) => node.getAttribute("aria-label") === label);
    if (!el) return null;
    const box = (el.querySelector("svg") ?? el).getBoundingClientRect();
    return Math.round((box.top + box.height / 2) * 10) / 10;
  }), [translate("topbar.notifications"), translate("topbar.help")]);
  check(touchBellCenter !== null && touchHelpCenter !== null && Math.abs(touchBellCenter - touchHelpCenter) <= 1, `top bar bell and help icon glyphs must share a vertical center on touch at 390px, found ${touchBellCenter} and ${touchHelpCenter}`);
  await touchContext.close();

  await page.setViewportSize({ width: 390, height: 844 });
  const notificationActionHeights = await page.locator('section[aria-labelledby="inbox-title"] ul li button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  check(notificationActionHeights.length > 0, "mobile Inbox must show notification actions");
  check(notificationActionHeights.every((height) => height >= 44), `mobile notification actions must be at least 44px tall, found ${notificationActionHeights.join(", ")}`);
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

  const targetLink = () => page.getByRole("link", { name: /MOB-1 Inbox destination/ });
  const targetEntry = () => page.locator("li").filter({ has: targetLink() });
  const assertUnread = async (expected: number, context: string) => {
    const current = await call<{ unreadCount: number }>("list_notifications", { workspaceId: workspace.id });
    check(current.unreadCount === expected, `${context}: expected ${expected} unread, found ${current.unreadCount}`);
  };
  await page.route(`${api}/actions/get_work_item`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "temporary failure" }) }));
  check((await targetLink().getAttribute("href"))?.includes(`inboxNotificationId=${notificationId}`) ?? false, "notification link does not carry its id in the destination URL");
  await targetLink().click();
  await page.waitForURL(`${web}/${slug}/browse/MOB-1`);
  await page.getByText(translate("workItems.notFound"), { exact: true }).waitFor();
  await assertUnread(1, "failed destination load");
  await page.unroute(`${api}/actions/get_work_item`);
  await page.goto(`${web}/${slug}/notifications`);

  await page.route(`${api}/actions/get_work_item`, (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }));
  await targetLink().click();
  await page.waitForURL(`${web}/${slug}/browse/MOB-1`);
  await page.getByText(translate("workItems.notFound"), { exact: true }).waitFor();
  await assertUnread(1, "inaccessible destination");
  await page.unroute(`${api}/actions/get_work_item`);
  await page.goto(`${web}/${slug}/notifications`);

  let readRequests = 0;
  page.on("request", (request) => { if (request.url().includes("/actions/mark_notification_read")) readRequests += 1; });
  const [openedInNewTab] = await Promise.all([context.waitForEvent("page"), targetLink().click({ modifiers: ["Control"] })]);
  let openedTabReadResponses = 0;
  openedInNewTab.on("response", (response) => { if (response.url().includes("/actions/mark_notification_read")) openedTabReadResponses += 1; });
  const newTabRead = openedInNewTab.waitForResponse((response) => response.url().includes("/actions/mark_notification_read"));
  await openedInNewTab.getByRole("heading", { name: "MOB-1" }).waitFor();
  check((await newTabRead).ok(), "successfully loaded new tab could not mark its notification read");
  check(openedTabReadResponses === 1, `new tab made ${openedTabReadResponses} read updates for one destination load`);
  await openedInNewTab.waitForURL((url) => !url.searchParams.has("inboxNotificationId"));
  check(readRequests === 0, "modified click fired the current-page auto-read handler");
  await assertUnread(0, "successfully loaded new tab");
  await openedInNewTab.goto(`${web}/${slug}`);
  await openedInNewTab.getByRole("heading", { name: translate("projects.title") }).waitFor();
  check(!new URL(openedInNewTab.url()).searchParams.has("inboxNotificationId"), "notification id leaked into unrelated navigation");
  check(openedTabReadResponses === 1, "new tab repeated the read update on unrelated navigation");
  check(readRequests === 0, "new-tab read handler fired on unrelated navigation");
  await assertUnread(0, "unrelated navigation after new-tab open");
  await openedInNewTab.close();

  await call("mark_notification_unread", { notificationId });
  await assertUnread(1, "reset before failed new-tab load");
  await context.route(`${api}/actions/get_work_item`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "temporary failure" }) }));
  const [failedInNewTab] = await Promise.all([context.waitForEvent("page"), targetLink().click({ modifiers: ["Control"] })]);
  let failedTabReadRequests = 0;
  failedInNewTab.on("request", (request) => { if (request.url().includes("/actions/mark_notification_read")) failedTabReadRequests += 1; });
  await failedInNewTab.getByText(translate("workItems.notFound"), { exact: true }).waitFor();
  await failedInNewTab.waitForURL((url) => !url.searchParams.has("inboxNotificationId"));
  await assertUnread(1, "failed new-tab destination");
  await failedInNewTab.goto(`${web}/${slug}`);
  await failedInNewTab.getByRole("heading", { name: translate("projects.title") }).waitFor();
  check(failedTabReadRequests === 0, "failed new tab attempted to mark its notification read");
  check(readRequests === 0, "failed new-tab load fired an auto-read request on the originating page");
  await assertUnread(1, "unrelated navigation after failed new-tab load");
  await failedInNewTab.close();
  await context.unroute(`${api}/actions/get_work_item`);

  await page.getByRole("link", { name: /MOB-1 Inbox destination/ }).click();
  await page.getByRole("heading", { name: "MOB-1" }).waitFor();
  await page.waitForURL((url) => !url.searchParams.has("inboxNotificationId"));
  await page.waitForFunction(() => [...document.querySelectorAll('a[href$="/notifications"]')].some((link) => link.textContent?.includes("Inbox") && link.getAttribute("aria-label") === "Inbox"));
  await assertUnread(0, "successfully loaded destination");
  await page.goto(`${web}/${slug}/notifications`);
  await page.getByRole("link", { name: /MOB-1 Inbox destination/ }).waitFor();
  await targetEntry().getByRole("button", { name: translate("inbox.markUnread") }).click();
  await targetEntry().getByRole("button", { name: translate("inbox.markRead") }).waitFor();
  await assertUnread(1, "manual mark unread");
  await targetEntry().getByRole("button", { name: translate("inbox.markRead") }).click();
  await targetEntry().getByRole("button", { name: translate("inbox.markUnread") }).waitFor();
  await assertUnread(0, "manual mark read");
  await targetEntry().getByRole("button", { name: translate("inbox.markUnread") }).click();
  await targetEntry().getByRole("button", { name: translate("inbox.markRead") }).waitFor();
  await assertUnread(1, "second manual mark unread");
  await page.waitForFunction((countLabel) => [...document.querySelectorAll('a[href$="/notifications"]')].some((link) => link.textContent?.includes("Inbox") && link.getAttribute("aria-label")?.includes(countLabel)), translate("inbox.unread").replace("{count}", "1"));
  await page.getByRole("tab", { name: new RegExp(translate("inbox.unreadTab")) }).click();
  await page.getByRole("link", { name: /MOB-1 Inbox destination/ }).waitFor();
  await page.getByRole("button", { name: translate("inbox.markAllRead") }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('a[href$="/notifications"]')].some((link) => link.textContent?.includes("Inbox") && link.getAttribute("aria-label") === "Inbox"));
  const allRead = await call<{ unreadCount: number }>("list_notifications", { workspaceId: workspace.id });
  check(allRead.unreadCount === 0, "mark all read did not update the live unread count");
  console.log("e2e notification Inbox: navigation, responsive layout, read and unread updates ok");
  await browser.close();
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
