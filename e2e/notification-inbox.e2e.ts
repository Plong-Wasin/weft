// The Inbox opens a reading pane on wide layouts and the full destination on narrow ones.
// Assert work item titles (the current heading) and seed via the API so unrelated onboarding chrome can change.
import { check, launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { type Browser, type Page } from "playwright";
import { eq, like } from "drizzle-orm";
import { createDatabase, notifications, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { createJobHandlers, runNextJob } from "../packages/actions/src";
import { WeftClient } from "../tools/visual/weft-client";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3118);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5218);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = ".local/shots/shadcn-finish-12";
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

const goto = (page: Page, url: string) => page.goto(url, { waitUntil: "domcontentloaded" });
const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
const inboxUrl = `${web}/${slug}/notifications`;
const longEnglish = "Review the notification preferences and verify the schedule for all workspace members before publishing the rollout plan";
const longThai = "ตรวจสอบการตั้งค่าการแจ้งเตือนและกำหนดเวลาสำหรับสมาชิกทุกคนในเวิร์กสเปซก่อนเผยแพร่แผนการเปิดตัว";
const primaryTitle = "Inbox destination";
const phoneTitle = "Open and return to this older item";
const viewports = [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }];
const extraViewports = [{ width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 844, height: 390 }, { width: 667, height: 375 }];

const topBarCenters = (page: Page) => page.evaluate((labels) => labels.map((label) => {
  const element = [...document.querySelectorAll("header a, header button")].find((node) => node.getAttribute("aria-label") === label);
  const box = (element?.querySelector("svg") ?? element)?.getBoundingClientRect();
  return box ? box.top + box.height / 2 : null;
}), [translate("topbar.notifications"), translate("topbar.help")]);
async function checkTopBarAlignment(page: Page, layout: string) {
  const [bell, help] = await topBarCenters(page);
  check(bell !== null && help !== null && Math.abs(bell - help) <= 1, `bell and help glyphs must align at ${layout}, got ${bell} and ${help}`);
}
async function checkLayout(page: Page) {
  const layout = await page.evaluate(() => ({
    pageFits: document.documentElement.scrollWidth <= window.innerWidth,
    mainFits: document.querySelector("main")!.scrollWidth <= document.querySelector("main")!.clientWidth,
    rows: [...document.querySelectorAll('section[aria-labelledby="inbox-title"] li')].filter((row) => row.querySelector("a")).map((row) => row.getBoundingClientRect().height),
    // A row without a target cannot be opened, so nothing of its text may be cut off.
    targetlessClipped: [...document.querySelectorAll('section[aria-labelledby="inbox-title"] li')].filter((row) => !row.querySelector("a")).map((row) => {
      const text = row.querySelector<HTMLElement>("[id^='notification-description-']")!;
      return text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1 || !["none", ""].includes(getComputedStyle(text).webkitLineClamp);
    }),
  }));
  check(!layout.targetlessClipped.includes(true), `[F1] a row without a target clips its text at ${JSON.stringify(page.viewportSize())}`);
  check(layout.pageFits && layout.mainFits, `Inbox overflows at ${JSON.stringify(page.viewportSize())}`);
  check(layout.rows.length > 0 && Math.max(...layout.rows) - Math.min(...layout.rows) <= 1, `Inbox rows have unequal heights: ${layout.rows.join(", ")}`);
}

let failed = false;
let browser: Browser | undefined;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await Bun.$`mkdir -p ${shots}`;
  browser = await launchBrowser({ args: ["--renderer-process-limit=3"] });
  const operator = new WeftClient(api, web);
  const member = new WeftClient(api, web);
  const password = "a-secure-password";
  await operator.signUp("Inbox Tester", `${slug}@example.test`, password);
  const workspace = await operator.action<{ id: string }>("create_workspace", { name: "Inbox team", slug });
  const project = await operator.action<{ id: string }>("create_project", { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const invite = await operator.action<{ token: string }>("create_invite", { workspaceId: workspace.id, role: "Member" });
  await member.signUp("Inbox Teammate", `${slug}-member@example.test`, password);
  await member.action("accept_invite", { token: invite.token });
  const people = await operator.action<Array<{ userId: string; name: string }>>("list_members", { workspaceId: workspace.id });
  const recipientId = people.find((person) => person.name === "Inbox Tester")!.userId;
  const actorId = people.find((person) => person.name === "Inbox Teammate")!.userId;
  await operator.action("add_project_member", { projectId: project.id, userId: actorId, role: "Member" });
  const createItem = (title: string) => operator.action<{ id: string; displayId: string }>("create_work_item", { projectId: project.id, title });
  const item = await createItem(primaryTitle);
  const english = await createItem(longEnglish);
  const thai = await createItem(longThai);
  const older = await createItem(phoneTitle);
  const filler = await createItem("Earlier Inbox entry");
  const wikiTitle = "Inbox reference guide";
  const wiki = await operator.action<{ id: string }>("create_wiki_page", { workspaceId: workspace.id, projectId: project.id, title: wikiTitle });
  const comment = await member.action<{ id: string }>("create_comment", {
    workItemId: item.id,
    body: { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Please review this Inbox reference. " },
      { type: "mention", attrs: { id: recipientId, label: "Inbox Tester" } },
    ] }] },
  });
  const database = createDatabase();
  try {
    // Run the real mention job. Seed the other notifications to control their order and read state.
    const handlers = createJobHandlers();
    while ((await runNextJob(database.db, handlers)).status !== "idle") { /* drain this flow's queue */ }
    const fixture = { workspaceId: workspace.id, userId: recipientId, actorId };
    const now = Date.now();
    const readAt = new Date(now);
    await database.db.insert(notifications).values([
      { ...fixture, kind: "assignment", workItemId: english.id, jobId: crypto.randomUUID(), createdAt: new Date(now + 2000) },
      { ...fixture, kind: "assignment", workItemId: thai.id, jobId: crypto.randomUUID(), readAt, createdAt: new Date(now + 1000) },
      { ...fixture, kind: "mention", wikiPageId: wiki.id, jobId: crypto.randomUUID(), readAt, createdAt: new Date(now - 3000) },
      { ...fixture, kind: "secret_output_blocked", detail: null, jobId: crypto.randomUUID(), readAt, createdAt: new Date(now - 4000) },
      ...Array.from({ length: 14 }, (_, index) => ({ ...fixture, kind: "assignment" as const, workItemId: filler.id, jobId: crypto.randomUUID(), readAt, createdAt: new Date(now - 5000 - index * 1000) })),
      { ...fixture, kind: "assignment", workItemId: older.id, jobId: crypto.randomUUID(), createdAt: new Date(now - 20000) },
    ]);
  } finally { await database.client.end(); }

  type Notice = { id: string; workItemId: string | null; wikiPageId: string | null; readAt: string | null };
  const fetchInbox = () => operator.action<{ unreadCount: number; notifications: Notice[] }>("list_notifications", { workspaceId: workspace.id });
  const fixtureInbox = await fetchInbox();
  check(fixtureInbox.unreadCount === 3, `fixture must have three unread notifications, found ${fixtureInbox.unreadCount}`);
  const noticeFor = (workItemId: string) => fixtureInbox.notifications.find((notice) => notice.workItemId === workItemId)!;
  const notice = noticeFor(item.id);
  const assertUnread = async (id: string, expected: boolean, label: string) => {
    const row = (await fetchInbox()).notifications.find((value) => value.id === id);
    check(Boolean(row) && (row?.readAt === null) === expected, `${label}: notification should be ${expected ? "unread" : "read"}`);
  };
  const cookies = operator.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" }));
  const context = await newContext(browser, { viewport: viewports[0], locale: "en-US", reducedMotion: "reduce" });
  await context.addCookies(cookies);
  const page = await context.newPage();
  const primaryLink = (inbox: Page = page, title = primaryTitle) => inbox.getByRole("link", { name: new RegExp(title) }).first();
  const rowFor = (inbox = page, title = primaryTitle) => inbox.getByRole("listitem").filter({ has: primaryLink(inbox, title) });
  const markRead = (inbox = page, title = primaryTitle) => rowFor(inbox, title).getByRole("button", { name: new RegExp(translate("inbox.markRead")) });
  const markUnread = (inbox = page, title = primaryTitle) => rowFor(inbox, title).getByRole("button", { name: new RegExp(translate("inbox.markUnread")) });
  const selectUrl = (id: string) => `${inboxUrl}?notification=${id}`;
  const openAsSelected = (id: string) => page.waitForURL((url) => url.searchParams.get("notification") === id);
  const expectSelected = (inbox: Page, title: string) => primaryLink(inbox, title).and(inbox.locator('[aria-current="true"]')).waitFor();
  const getWorkItemUrl = `${api}/actions/get_work_item`;
  const loadError = (status: number) => ({ status, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });

  await goto(page, inboxUrl);
  await primaryLink().waitFor();
  await page.getByRole("link", { name: `Inbox, ${translate("inbox.unread").replace("{count}", "3")}` }).waitFor();
  await page.getByRole("link", { name: translate("topbar.notifications") }).waitFor();
  await checkTopBarAlignment(page, "1440px");
  await checkLayout(page);
  const noticeWithoutTarget = page.locator('section[aria-labelledby="inbox-title"] li').filter({ hasText: translate("inbox.secretOutputBlockedDetail") });
  check(await noticeWithoutTarget.count() === 1, "Runtime secret alert should render one generic retry message");
  check(await noticeWithoutTarget.getByRole("link").count() === 0 && await noticeWithoutTarget.getByRole("button").count() === 1,
    "the targetless row should have just its read-state action");
  check(await noticeWithoutTarget.getByText(translate("inbox.secretOutputBlockedDetail")).evaluate((text) => getComputedStyle(text).cursor === "auto"),
    "the targetless summary should have the default cursor");
  const rowBeforeHover = await primaryLink().boundingBox();
  await primaryLink().hover({ position: { x: 5, y: 65 } });
  check(JSON.stringify(await primaryLink().boundingBox()) === JSON.stringify(rowBeforeHover), "hover shifted the row");

  const label = await markRead().getAttribute("aria-labelledby");
  check(label?.split(" ").some((id) => id.startsWith("notification-description-")) ?? false, "the read action should name its row");
  await markRead().click();
  await markUnread().waitFor();
  check(page.url() === inboxUrl, "marking read opened a row");
  await assertUnread(notice.id, false, "manual mark read");
  await markUnread().click();
  await markRead().waitFor();
  await assertUnread(notice.id, true, "manual mark unread");

  const readAction = (url: string) => url.endsWith("/actions/mark_notification_read");
  let originReads = 0;
  page.on("request", (request) => { if (readAction(request.url())) originReads += 1; });
  const settle = () => Bun.sleep(1000); // long enough for a wrong late mark-read to be sent
  const retries = [
    { status: 500, how: "click", run: () => primaryLink().click({ position: { x: 5, y: 65 } }) },
    { status: 403, how: "Enter", run: () => primaryLink().press("Enter") },
  ];
  for (const { status, how, run } of retries) {
    await page.route(getWorkItemUrl, (route) => route.fulfill(loadError(status)));
    await primaryLink().click({ position: { x: 5, y: 65 } });
    await openAsSelected(notice.id);
    await expectSelected(page, primaryTitle);
    await page.getByRole("alert").filter({ hasText: translate("workItems.notFound") }).waitFor();
    await settle();
    check(originReads === 0, `[F6] failed reading pane load (${status}) sent a mark-read`);
    await assertUnread(notice.id, true, `failed reading pane load (${status})`);
    await page.unroute(getWorkItemUrl);
    await run();
    await page.getByRole("heading", { name: primaryTitle, exact: true }).waitFor({ timeout: 5000 })
      .catch(() => { throw new Error(`[F4] ${how} on the failed row did not retry`); });
    await markUnread().waitFor();
    await operator.action("mark_notification_unread", { notificationId: notice.id });
    originReads = 0;
    await goto(page, inboxUrl);
  }
  console.log("Inbox checks passed: row geometry, independent read action and failed previews");
  check((await primaryLink().getAttribute("href"))?.includes(`inboxNotificationId=${notice.id}`) ?? false, "the destination href lost the unread notification token");
  check(new URL(await primaryLink().evaluate((element) => (element as HTMLAnchorElement).href)).hash === `#comment-${comment.id}`, "mention link lost its comment target");

  // Use native new-tab links even when a regular click would select a reading pane.
  const newTabRead = context.waitForEvent("response", { predicate: (response) => readAction(response.url()) });
  const [opened] = await Promise.all([context.waitForEvent("page"), primaryLink().click({ modifiers: ["Control"] })]);
  let successfulTabReads = 0;
  opened.on("request", (request) => { if (readAction(request.url())) successfulTabReads += 1; });
  await opened.getByRole("heading", { name: primaryTitle, exact: true }).waitFor();
  check((await newTabRead).ok(), "successfully loaded new tab could not mark read");
  await opened.waitForURL((url) => !url.searchParams.has("inboxNotificationId"));
  await assertUnread(notice.id, false, "Ctrl-click destination");
  await goto(opened, `${web}/${slug}/projects`);
  await opened.getByRole("heading", { name: translate("projects.title"), exact: true }).waitFor();
  check(successfulTabReads === 1 && originReads === 0, "Ctrl-click should only mark read once, from the new tab");
  check(!new URL(opened.url()).searchParams.has("inboxNotificationId"), "notification token leaked into unrelated navigation");
  await opened.close();

  await operator.action("mark_notification_unread", { notificationId: notice.id });
  await goto(page, inboxUrl);
  await context.route(getWorkItemUrl, (route) => route.fulfill(loadError(500)));
  const [failedTab] = await Promise.all([context.waitForEvent("page"), primaryLink().click({ button: "middle" })]);
  let failedTabReads = 0;
  failedTab.on("request", (request) => { if (readAction(request.url())) failedTabReads += 1; });
  await failedTab.getByText(translate("workItems.notFound"), { exact: true }).waitFor();
  await failedTab.waitForURL((url) => !url.searchParams.has("inboxNotificationId"));
  await goto(failedTab, `${web}/${slug}/projects`);
  await failedTab.getByRole("heading", { name: translate("projects.title"), exact: true }).waitFor();
  check(failedTabReads === 0 && originReads === 0, "a failed middle-click destination attempted to mark read");
  await assertUnread(notice.id, true, "failed middle-click destination");
  await failedTab.close();
  await context.unroute(getWorkItemUrl);
  console.log("Inbox checks passed: native Ctrl-click and middle-click destinations");

  // Clicking outside the text selects the same row, loads the work item and retains its comment anchor.
  await primaryLink().click({ position: { x: 5, y: 65 } });
  await openAsSelected(notice.id);
  await expectSelected(page, primaryTitle);
  await page.getByRole("heading", { name: primaryTitle, exact: true }).waitFor();
  await page.getByText("Please review this Inbox reference.", { exact: false }).waitFor();
  await markUnread().waitFor();
  await assertUnread(notice.id, false, "successfully loaded reading pane");
  check(new URL(page.url()).hash === `#comment-${comment.id}`, "the reading pane lost the mention anchor");
  check(JSON.stringify(await primaryLink().boundingBox()) === JSON.stringify(rowBeforeHover), "selection changed the row dimensions");

  await page.getByRole("textbox", { name: translate("workItems.titleField") }).focus();
  await page.keyboard.press("ArrowDown");
  check(new URL(page.url()).searchParams.get("notification") === notice.id, "an arrow key in the editor changed selection");
  await primaryLink().focus();
  await page.keyboard.press("k");
  await expectSelected(page, longThai);
  await page.keyboard.press("j");
  await expectSelected(page, primaryTitle);
  await page.keyboard.press("ArrowUp");
  await expectSelected(page, longThai);
  await page.keyboard.press("ArrowDown");
  await expectSelected(page, primaryTitle);
  await primaryLink(page, longThai).press("Space");
  await expectSelected(page, longThai);
  await primaryLink().press("Enter");
  await expectSelected(page, primaryTitle);

  // F3: a title typed but not blurred survives the pane unmounting.
  const titleField = page.getByRole("textbox", { name: translate("workItems.titleField") });
  const heading = (name: string) => page.getByRole("heading", { name, exact: true });
  const expectSavedTitle = async (expected: string, label: string) => {
    let saved = "";
    for (let attempt = 0; attempt < 30 && saved !== expected; attempt += 1) {
      saved = (await operator.action<{ title: string }>("get_work_item", { workspaceId: workspace.id, displayId: item.displayId })).title;
      if (saved !== expected) await Bun.sleep(100);
    }
    check(saved === expected, `[F3] ${label} lost the typed title: "${saved}"`);
    await operator.action("update_work_item", { workItemId: item.id, title: primaryTitle });
  };
  for (const [label, unmount] of [
    ["narrowing the window", () => page.setViewportSize(viewports[1]!)],
    ["browser Back", () => page.goBack()],
  ] as const) {
    await goto(page, inboxUrl);
    await primaryLink().click();
    await heading(primaryTitle).waitFor();
    await titleField.fill(`${primaryTitle} half typed`);
    await unmount();
    await titleField.waitFor({ state: "detached" });
    await expectSavedTitle(`${primaryTitle} half typed`, label);
    await page.setViewportSize(viewports[0]!);
  }

  // F5: J/K need no focused row, ignore key repeat, and stay out of editors, menus and dialogs.
  const englishNotice = noticeFor(english.id);
  const selectedNow = () => new URL(page.url()).searchParams.get("notification");
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await goto(page, selectUrl(notice.id));
  await heading(primaryTitle).waitFor();
  await blur();
  await page.keyboard.press("k");
  await expectSelected(page, longThai).catch(() => { throw new Error("[F5] K without a focused row did nothing after a reload"); });
  await blur();
  await page.keyboard.press("j");
  await expectSelected(page, primaryTitle);
  await goto(page, selectUrl(noticeFor(thai.id).id));
  await heading(longThai).waitFor();
  await primaryLink(page, longThai).focus();
  await page.keyboard.down("j");
  await expectSelected(page, primaryTitle);
  await page.keyboard.down("j");
  await page.keyboard.up("j");
  await settle();
  check(selectedNow() === notice.id, "[F5] a held J kept moving the selection");

  const expectStill = async (label: string) => {
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    await page.keyboard.press("k");
    check(selectedNow() === notice.id, `[F6] J/K in ${label} changed the selection`);
  };
  await heading(primaryTitle).waitFor();
  await titleField.focus();
  await expectStill("the title");
  await titleField.fill(primaryTitle);
  const description = page.getByTestId("description-editor").locator("[contenteditable='true']");
  await description.click();
  await expectStill("the description editor");
  for (let index = 0; index < 3; index += 1) await page.keyboard.press("Backspace");
  await page.getByRole("button", { name: translate("topbar.help") }).click();
  await page.getByRole("menuitem").first().focus();
  await expectStill("a menu");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").evaluate((dialog) => { (dialog as HTMLElement).tabIndex = -1; (dialog as HTMLElement).focus(); });
  await expectStill("a dialog");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });

  // F6: J onto an unread row marks it read once it loads; moving away from a slow load leaves it unread.
  await goto(page, inboxUrl);
  await primaryLink(page, longEnglish).waitFor();
  await blur();
  await page.keyboard.press("j");
  await expectSelected(page, longEnglish);
  await heading(longEnglish).waitFor();
  await markUnread(page, longEnglish).waitFor();
  await assertUnread(englishNotice.id, false, "[F6] J onto an unread row");
  await operator.action("mark_notification_unread", { notificationId: englishNotice.id });
  await goto(page, selectUrl(notice.id));
  await heading(primaryTitle).waitFor();
  let releaseLoad = () => {};
  const held = new Promise<void>((resolve) => { releaseLoad = resolve; });
  await page.route(getWorkItemUrl, async (route) => {
    if (route.request().postData()?.includes(english.displayId)) await held;
    await route.continue();
  });
  originReads = 0;
  const slowRequest = page.waitForRequest((request) => request.url() === getWorkItemUrl && Boolean(request.postData()?.includes(english.displayId)));
  await primaryLink(page, longEnglish).click();
  await slowRequest;
  await primaryLink().click();
  await heading(primaryTitle).waitFor();
  releaseLoad();
  await settle();
  check(originReads === 0, "[F6] a load abandoned by switching rows sent a mark-read");
  await assertUnread(englishNotice.id, true, "[F6] abandoned slow load");
  await page.unroute(getWorkItemUrl);
  await goto(page, selectUrl(notice.id));
  await expectSelected(page, primaryTitle);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectSelected(page, primaryTitle);
  await page.getByRole("heading", { name: primaryTitle, exact: true }).waitFor();

  await primaryLink(page, wikiTitle).click();
  const wikiNotice = fixtureInbox.notifications.find((row) => row.wikiPageId === wiki.id)!;
  await openAsSelected(wikiNotice.id);
  await page.getByRole("heading", { name: wikiTitle, exact: true }).waitFor();
  const openWiki = page.getByRole("link", { name: translate("inbox.open"), exact: true });
  const wikiHref = await openWiki.getAttribute("href");
  check(wikiHref?.endsWith(`/${wiki.id}`) ?? false, "a wiki notification should link to its original destination");
  await page.goBack();
  await expectSelected(page, primaryTitle);
  console.log("Inbox checks passed: row click, selection URL, keyboard and wiki summary");

  const touch = await newContext(browser, { viewport: viewports[2], hasTouch: true, isMobile: true, locale: "en-US", storageState: await context.storageState() });
  const phone = await touch.newPage();
  await goto(phone, `${web}/${slug}/projects`);
  await phone.getByRole("button", { name: translate("shell.openMenu") }).tap();
  const drawer = phone.getByRole("dialog", { name: translate("shell.sidebar") });
  const inboxNav = drawer.getByRole("link", { name: `Inbox, ${translate("inbox.unread").replace("{count}", "2")}` });
  await inboxNav.tap();
  await phone.waitForURL(inboxUrl);
  await drawer.waitFor({ state: "detached" });
  await primaryLink(phone).waitFor();
  await checkTopBarAlignment(phone, "390px touch");
  await checkLayout(phone);
  const actionBoxes = await phone.locator('section[aria-labelledby="inbox-title"] li button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
  check(actionBoxes.length > 0 && actionBoxes.every(({ width, height }) => width >= 44 && height >= 44), "touch read-state targets should be at least 44px in both dimensions");
  const phoneLink = primaryLink(phone, phoneTitle);
  const main = phone.getByRole("main");
  await phoneLink.scrollIntoViewIfNeeded();
  const scrollTop = await main.evaluate((element) => element.scrollTop);
  check(scrollTop > 0, "the phone test must open a row below the fold");
  await phoneLink.tap();
  await phone.getByRole("heading", { name: phoneTitle, exact: true }).waitFor();
  await phone.waitForURL((url) => url.pathname.endsWith(`/browse/${older.displayId}`) && !url.searchParams.has("inboxNotificationId"));
  await phone.goBack();
  await expectSelected(phone, phoneTitle);
  await markUnread(phone, phoneTitle).waitFor();
  check(Math.abs(await main.evaluate((element) => element.scrollTop) - scrollTop) <= 2, "phone Back did not restore the Inbox scroll position");
  await assertUnread(noticeFor(older.id).id, false, "phone tap destination");
  await touch.close();
  console.log("Inbox checks passed: touch navigation, tap targets and scroll restoration");

  // Capture all width/theme/language combinations with mixed read states and both long titles.
  for (const locale of ["en", "th"] as const) {
    await operator.action("set_my_locale", { locale });
    for (const theme of ["light", "dark"] as const) {
      for (const { width, height } of viewports) {
        // Only the tablet and phone sizes are touch screens.
        const capture = await newContext(browser, { viewport: { width, height }, locale: locale === "th" ? "th-TH" : "en-US", colorScheme: theme, reducedMotion: "reduce", hasTouch: width < 1440, storageState: await context.storageState() });
        await capture.addInitScript(({ locale, theme }) => {
          localStorage.setItem("weft.locale", locale);
          localStorage.setItem("weft.theme", theme);
        }, { locale, theme });
        const shot = await capture.newPage();
        await goto(shot, selectUrl(noticeFor(thai.id).id));
        await shot.getByRole("heading", { name: translate("inbox.title", locale), exact: true }).waitFor();
        await expectSelected(shot, longThai);
        // Two panes need 720px of content: at 820px the app rail leaves less, so only 1440px has a reading pane.
        const peekHeading = shot.getByRole("heading", { name: longThai, exact: true });
        if (width === 1440) await peekHeading.waitFor();
        else check(await peekHeading.count() === 0, `unexpected reading pane at ${width}px`);
        await shot.evaluate(() => document.fonts.ready);
        await checkLayout(shot);
        await shot.screenshot({ path: `${shots}/inbox-${width}x${height}-${theme}-${locale}.png`, animations: "disabled" });
        await capture.close();
      }
    }
  }
  await operator.action("set_my_locale", { locale: "en" });
  await goto(page, selectUrl(noticeFor(thai.id).id));
  await expectSelected(page, longThai);
  for (const viewport of extraViewports) {
    await page.setViewportSize(viewport);
    await checkLayout(page);
  }

  await page.setViewportSize(viewports[0]);
  await goto(page, inboxUrl);
  await page.getByRole("tab", { name: new RegExp(translate("inbox.unreadTab")) }).click();
  await primaryLink(page, longEnglish).waitFor();
  check(await primaryLink().count() === 0, "the Unread tab included a read row");
  await page.getByRole("button", { name: translate("inbox.markAllRead") }).click();
  await page.getByText(translate("inbox.empty")).waitFor();
  await page.getByRole("link", { name: "Inbox", exact: true }).waitFor();
  check((await fetchInbox()).unreadCount === 0, "Mark all read did not clear the live unread count");
  console.log("e2e notification Inbox: wide selection and keyboard, new tabs, success-only read, touch Back, filters, layout and 12 screenshots passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
  const database = createDatabase();
  try {
    await database.db.delete(workspaces).where(eq(workspaces.slug, slug));
    await database.db.delete(users).where(like(users.email, `${slug}%@example.test`));
  } finally { await database.client.end(); }
}
process.exit(failed ? 1 : 0);
