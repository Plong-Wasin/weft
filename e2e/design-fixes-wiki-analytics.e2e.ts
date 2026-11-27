// Browser end-to-end flow: design fixes for the Wiki, Analytics and phone layouts.
// Wiki page comments: Reply opens an inline field under its thread, focused and labelled with the person it answers; Send submits it,
// Escape closes it; a resolved thread offers no Reply. Phone width: a long Wiki page title wraps instead of clipping, the Analytics
// project name is not cut off, the Wiki tabs keep "Shared with me" on one line, and no route scrolls the page sideways.
// Run with `bun e2e/design-fixes-wiki-analytics.e2e.ts` (set DATABASE_URL to an isolated test database).
import { check, launchBrowser, newContext, startApi, startLive, startWeb, waitFor } from "./harness";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31420);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52420);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31422);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startLive(livePort, web),
  startWeb(webPort, { api, live: `ws://localhost:${livePort}` }),
];

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const userName = "Design Tester";
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const replyLabel = (name: string) => `${translate("wiki.comments.replyTo")} ${name}`;
  // Anchor is an opaque string the editor reads back; any non-empty value stores a thread.
  const anchor = btoa("[]");
  const commentBody = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

  // Sign up and make a workspace with a project, a long-titled Wiki page carrying two comment threads, and a project for Analytics.
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill(userName);
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Design fixes");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/actions/create_workspace")), page.getByRole("button", { name: translate("workspace.create") }).click()]);
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("create_project", { workspaceId, name: "Field operations archive", key: "FOA", visibility: "public" });
  await call("create_work_item", { projectId: project.id, title: "Analytics graph fixture" });
  const pageId = (await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Quarterly operating review for the regional distribution network" })).id;
  const openThread = (await call<{ id: string }>("create_wiki_page_comment", { pageId, body: commentBody("Open thread text"), anchor })).id;
  const resolvedThread = (await call<{ id: string }>("create_wiki_page_comment", { pageId, body: commentBody("Resolved thread text"), anchor })).id;
  await call("resolve_wiki_page_comment", { commentId: resolvedThread, resolved: true });

  // Wiki page comments, at desktop width.
  await page.goto(`${web}/${slug}/wiki/${pageId}`);
  await page.getByTestId("wiki-details-toggle").click();
  await page.getByRole("tab", { name: new RegExp(`^${translate("wiki.comments.tab")}`) }).click();
  const openItem = page.locator("li", { hasText: "Open thread text" });
  await openItem.getByRole("button", { name: translate("wiki.comments.reply"), exact: true }).click();
  const replyField = page.getByRole("textbox", { name: replyLabel(userName), exact: true });
  await replyField.waitFor();
  check(await replyField.evaluate((node) => node === document.activeElement), "Reply must move focus to the inline reply field");
  check(await page.getByRole("button", { name: translate("wiki.comments.add"), exact: true }).isVisible(), "the bottom compose box keeps its Add comment button");
  await replyField.fill("Inline reply text");
  await openItem.getByRole("button", { name: translate("wiki.comments.send"), exact: true }).click();
  await openItem.getByText("Inline reply text").waitFor();
  check((await page.getByRole("textbox", { name: replyLabel(userName), exact: true }).count()) === 0, "a sent reply closes its inline field");
  console.log("wiki comment reply ok: inline field focused, sent, closed");

  // Escape closes the inline field without sending.
  await openItem.getByRole("button", { name: translate("wiki.comments.reply"), exact: true }).click();
  await page.getByRole("textbox", { name: replyLabel(userName), exact: true }).waitFor();
  await page.keyboard.press("Escape");
  check((await page.getByRole("textbox", { name: replyLabel(userName), exact: true }).count()) === 0, "Escape must close the inline reply field");
  console.log("wiki comment reply ok: Escape closes");

  // A resolved thread offers no Reply.
  await page.getByRole("checkbox", { name: translate("wiki.comments.showResolved") }).click();
  const resolvedItem = page.locator("li", { hasText: "Resolved thread text" });
  await resolvedItem.waitFor();
  check((await resolvedItem.getByRole("button", { name: translate("wiki.comments.reply"), exact: true }).count()) === 0, "a resolved thread must not offer Reply");
  console.log("wiki comment reply ok: resolved thread has no Reply");

  // Each thread shows one text action (Reply); Resolve and Edit live in a "more" menu.
  check((await openItem.getByRole("button", { name: translate("wiki.comments.resolve"), exact: true }).count()) === 0, "Resolve must not be a visible button in the thread row");
  check((await openItem.getByRole("button", { name: translate("wiki.comments.edit"), exact: true }).count()) === 0, "Edit must not be a visible button in the thread row");
  await openItem.getByRole("button", { name: translate("wiki.comments.more"), exact: true }).click();
  await page.getByRole("menuitem", { name: translate("wiki.comments.resolve"), exact: true }).click();
  await openItem.getByRole("button", { name: translate("wiki.comments.reply"), exact: true }).waitFor({ state: "detached" }); // resolving from the menu removes Reply
  await openItem.getByRole("button", { name: translate("wiki.comments.more"), exact: true }).click();
  await page.getByRole("menuitem", { name: translate("wiki.comments.reopen"), exact: true }).click();
  await openItem.getByRole("button", { name: translate("wiki.comments.reply"), exact: true }).waitFor();
  await openItem.getByRole("button", { name: translate("wiki.comments.more"), exact: true }).click();
  await page.getByRole("menuitem", { name: translate("wiki.comments.edit"), exact: true }).click();
  await page.getByRole("textbox", { name: translate("wiki.comments.edit"), exact: true }).waitFor();
  console.log("wiki comment menu ok: resolve, reopen and edit reachable from more");

  // Phone width: the long title wraps, and no route scrolls the page sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/wiki/${pageId}`);
  const title = page.getByRole("textbox", { name: translate("wiki.untitled"), exact: true });
  await title.waitFor();
  const titleFits = await title.evaluate((node) => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1);
  check(titleFits, "the Wiki page title must show its whole text on phone width");
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  check(await noSideScroll(), "Wiki page scrolls the page sideways on phone width");
  console.log("wiki title ok: wraps on phone, no sideways scroll");

  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("tab", { name: translate("pages.tab.shared"), exact: true }).waitFor();
  // A one-line tab is as tall as the "All" tab; a wrapped label is taller.
  const tabHeight = (name: string) => page.getByRole("tab", { name, exact: true }).evaluate((node) => node.getBoundingClientRect().height);
  const oneLine = await tabHeight(translate("pages.tab.all"));
  const sharedHeight = await tabHeight(translate("pages.tab.shared"));
  check(sharedHeight <= oneLine + 1, `the "Shared with me" tab wraps on phone width (height ${sharedHeight}px, one line ${oneLine}px)`);
  // The selected tab carries the accent underline; a class glued to the one before it (a missing space) loses it.
  const underline = await page.getByRole("tab", { selected: true }).first().evaluate((node) => {
    const probe = document.createElement("span");
    probe.style.background = "var(--primary)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { border: getComputedStyle(node).borderBottomColor, accent };
  });
  const idleUnderline = await page.getByRole("tab", { selected: false }).first().evaluate((node) => getComputedStyle(node).borderBottomColor);
  check(idleUnderline === "rgba(0, 0, 0, 0)", `an unselected Wiki tab shows an underline (${idleUnderline})`);
  check(underline.border === underline.accent, `the selected Wiki tab has no accent underline (border ${underline.border}, accent ${underline.accent})`);
  check(await noSideScroll(), "Wiki list scrolls the page sideways on phone width");
  console.log("wiki list ok: Shared with me on one line, no sideways scroll");

  await page.goto(`${web}/${slug}/analytics/overview`);
  const projectName = page.getByText("Field operations archive", { exact: true }).last();
  await projectName.waitFor();
  const screenshotPath = (name: string) => `${Bun.env.TMPDIR ?? "/tmp"}/weft-analytics-overview-${name}.png`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: screenshotPath("desktop"), fullPage: true });
  console.log(`analytics desktop render: ${screenshotPath("desktop")}`);
  const projectTable = page.getByRole("table", { name: translate("analytics.projectList") });
  check(await projectTable.getByRole("columnheader", { name: translate("analytics.total") }).count() === 1, "the Analytics project totals need an exposed column header");
  check(await projectTable.getByRole("rowheader", { name: /FOA Field operations archive/ }).count() === 1, "the Analytics project row needs an exposed row header");
  console.log("analytics overview ok: project totals expose table headers");
  await page.setViewportSize({ width: 390, height: 844 });
  const nameFits = await projectName.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
  check(nameFits, "the Analytics project name is cut off on phone width");
  check(await noSideScroll(), "Analytics overview scrolls the page sideways on phone width");
  await page.screenshot({ path: screenshotPath("phone"), fullPage: true });
  console.log(`analytics phone render: ${screenshotPath("phone")}`);
  console.log("analytics ok: project name not cut off, no sideways scroll");

  await page.goto(`${web}/${slug}/analytics/work-items`);
  await page.getByRole("heading", { name: translate("analytics.createdVsResolved"), exact: true }).waitFor();
  check(await page.locator("figure [role='img']").count() >= 3, "populated Analytics charts do not expose their rendered data");
  check(await noSideScroll(), "Analytics work items scrolls the page sideways on phone width");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: screenshotPath(`work-items-desktop-${theme}`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    check(await noSideScroll(), `Analytics work items scrolls sideways on phone width in ${theme} theme`);
    await page.screenshot({ path: screenshotPath(`work-items-phone-${theme}`), fullPage: true });
  }
  console.log("analytics ok: work items no sideways scroll");

  console.log("design fixes wiki analytics: all checks passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  process.exit(failed ? 1 : 0);
}
