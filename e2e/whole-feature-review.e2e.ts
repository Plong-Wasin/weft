import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createDatabase } from "../packages/db/src";
import { activities } from "../packages/db/src/schema";
import { createProjectActions, createWikiActions, createWorkItemActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31310);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52310);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31311);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const captures = `${process.cwd()}/.scratch-captures`;
const selectedCaptureStages = new Set((Bun.env.E2E_CAPTURE_STAGES ?? "").split(",").filter(Boolean));
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true", VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];
const { client, db } = createDatabase();
let failed = false;
async function waitFor(url: string) { for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); } throw new Error(`${url} did not start`); }
try {
  mkdirSync(captures, { recursive: true });
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const slug = `whole-${crypto.randomUUID().slice(0, 8)}`;
  const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  const call = async (name: string, data: unknown) => { const response = await page.request.post(`${api}/actions/${name}`, { data }); if (!response.ok()) throw new Error(`${name}: ${response.status()} ${await response.text()}`); return response.json(); };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Feature Reviewer");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword", "en")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Feature review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`);
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((w) => w.slug === slug)!.id;
  const userId = me.user.id;
  const project = await createProjectActions(db).createProject.handler({ userId }, { workspaceId, name: "Review", key: "REV", visibility: "public" });
  const items = createWorkItemActions(db);
  const item = await items.createWorkItem.handler({ userId }, { projectId: project.id, title: "Capture review" });
  const activityNow = Date.now();
  await db.insert(activities).values([
    { workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: "description", oldValue: "Earlier description", newValue: "Current description", actorId: userId, source: "ui", createdAt: new Date(activityNow - 30_000) },
    { workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: "description", oldValue: "Current description", newValue: "Latest description", actorId: userId, source: "ui", createdAt: new Date(activityNow - 20_000) },
  ]);
  const wikiActions = createWikiActions(db);
  const target = await wikiActions.createWikiPage.handler({ userId }, { workspaceId, title: "Reference page", contentMarkdown: "A page to open from a Backlink." });
  await call("update_work_item", { workItemId: item.id, descriptionMarkdown: `Initial description.\n\n[[Reference page|wiki:${target.id}]]` });
  const wiki = await wikiActions.createWikiPage.handler({ userId }, { workspaceId, title: "Feature notes", contentMarkdown: ["Initial note.", "", `[[Reference page|wiki:${target.id}]]`, "", "```diff", "-old", "+new", "```", "", "```mermaid", "flowchart LR", "  A[Write] --> B[Review]", "```"].join("\n") });
  const errorWiki = await wikiActions.createWikiPage.handler({ userId }, { workspaceId, title: "Diagram needs a fix", contentMarkdown: "```mermaid\nthis is not a diagram\n```" });
  const detail = `${web}/${slug}/browse/REV-${item.sequence}`;
  const wikiUrl = `${web}/${slug}/wiki/${wiki.id}`;
  const targetUrl = `${web}/${slug}/wiki/${target.id}`;
  let importedUrl: string | null = null;
  let importedWarnings: { code: string; message: string }[] = [];
  const capture = async (stage: string, locale: "en" | "th", width: 1280 | 390, theme: "light" | "dark" = "light") => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.waitForTimeout(150);
    if (width === 390) check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${stage} causes horizontal scrolling at phone width`);
    if (width === 390) {
      const sourceBounds = await page.getByTestId("editor-source-text").evaluateAll((elements) => elements.map((element) => { const rect = element.getBoundingClientRect(); const parent = element.parentElement!.getBoundingClientRect(); const main = element.closest("#main-content")!.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, parent: { left: parent.left, right: parent.right, width: parent.width }, main: { left: main.left, right: main.right, width: main.width }, viewport: window.innerWidth }; }));
      check(sourceBounds.every(({ left, right, width: sourceWidth }) => left >= 0 && right <= 390 && sourceWidth <= 390), `${stage} source editor is clipped at phone width: ${JSON.stringify(sourceBounds)}`);
      const actions = page.getByRole("group", { name: translate("workItems.actions", locale), exact: true });
      const actionBounds = await actions.evaluateAll((elements) => elements.map((element) => { const rect = element.getBoundingClientRect(); const children = [...element.children].map((child) => { const box = child.getBoundingClientRect(); return { left: box.left, right: box.right }; }); return { left: rect.left, right: rect.right, children }; }));
      check(actionBounds.every(({ left, right, children }) => left >= 0 && right <= 390 && children.every((child) => child.left >= 0 && child.right <= 390)), `${stage} work-item action controls are clipped at phone width: ${JSON.stringify(actionBounds)}`);
      const activityBounds = await page.locator("li button[aria-controls^='activity-group-']").evaluateAll((elements) => elements.map((element) => { const rect = element.getBoundingClientRect(); const children = [...element.querySelectorAll("*")].map((child) => { const box = child.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width, client: (child as HTMLElement).clientWidth, scroll: (child as HTMLElement).scrollWidth }; }); return { left: rect.left, right: rect.right, width: rect.width, children }; }));
      check(activityBounds.every(({ left, right, width: buttonWidth, children }) => left >= 0 && right <= 390 && buttonWidth <= 390 && children.every((child) => child.left >= 0 && child.right <= 390 && child.scroll <= child.client + 1)), `${stage} timeline group is clipped at phone width: ${JSON.stringify(activityBounds)}`);
    }
    if (stage === "comment") await page.locator("li[id^='comment-']").last().getByRole("button").last().scrollIntoViewIfNeeded();
    if (stage === "empty-comment") await page.getByTestId("comment-editor").last().scrollIntoViewIfNeeded();
    if (stage === "comment-source" && await page.locator("li[id^='comment-']").count()) await page.locator("li[id^='comment-']").last().scrollIntoViewIfNeeded();
    if (stage === "comment-edit-actions") await page.locator("li[id^='comment-']").last().scrollIntoViewIfNeeded();
    if (stage === "backlink") await page.getByRole("region", { name: translate("outlinks.title", locale), exact: true }).evaluate((element) => element.scrollIntoView({ block: "center" }));
    if (stage === "description-updating") await page.getByRole("region", { name: translate("outlinks.title", locale), exact: true }).evaluate((element) => element.scrollIntoView({ block: "center" }));
    if (selectedCaptureStages.size && !selectedCaptureStages.has(stage)) return;
    const path = `${captures}/10-${stage}-${width}-${locale}-${theme}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(path);
  };
  for (const locale of ["en", "th"] as const) {
    await call("set_my_locale", { locale });
    await page.goto(detail);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: translate("workItems.more", locale), exact: true }).click();
    await page.getByRole("menuitem", { name: translate("workItems.copyLink", locale), exact: true }).waitFor();
    await page.getByRole("menuitem", { name: translate("workItems.delete", locale), exact: true }).waitFor();
    check(await page.getByRole("navigation", { name: translate("workItems.breadcrumb", locale) }).getByText(`REV-${item.sequence}`, { exact: true }).isVisible(), "the work item key should stay visible beside the phone More menu");
    await capture("work-item-more", locale, 390);
    await page.keyboard.press("Escape");
    const description = page.getByTestId("description-editor");
    const descriptionLinks = page.getByRole("region", { name: translate("outlinks.title", locale), exact: true });
    await descriptionLinks.getByRole("link", { name: /Reference page/ }).waitFor();
    let releaseDescriptionUpdate!: () => void;
    const descriptionUpdateGate = new Promise<void>((resolve) => { releaseDescriptionUpdate = resolve; });
    await page.route("**/actions/update_work_item", async (route) => { await descriptionUpdateGate; await route.continue(); });
    const descriptionSourceToggle = description.getByRole("button", { name: translate("editor.sourceMode", locale) });
    check((await descriptionSourceToggle.getAttribute("class"))?.includes("secondary"), "source mode needs a clearly styled button");
    await descriptionSourceToggle.click();
    const descSource = description.getByTestId("editor-source-text");
    await descSource.fill(`A description edited in source mode.${locale === "th" ? "\n\nอัปเดตในรอบภาษาไทย" : ""}\n\n[[Reference page|wiki:${target.id}]]`);
    await description.getByRole("button", { name: translate("editor.visualMode", locale) }).click();
    await description.locator(".ProseMirror").getByText("A description edited in source mode.").waitFor();
    await page.getByTestId("outlinks-updating").getByText(translate("outlinks.updating", locale), { exact: true }).waitFor();
    await descriptionLinks.getByRole("link", { name: /Reference page/ }).waitFor();
    for (const width of [1280, 390] as const) await capture("description-updating", locale, width);
    releaseDescriptionUpdate();
    await page.unroute("**/actions/update_work_item");
    await page.unroute("**/actions/update_work_item");
    const descriptionSaved = page.getByTestId("description-save-status").getByText(translate("workItems.descriptionSave.saved", locale), { exact: true });
    await descriptionSaved.waitFor();
    await page.reload();
    await descriptionSaved.waitFor();
    await descriptionLinks.getByRole("link", { name: /Reference page/ }).waitFor();
    const detailText = await page.locator("body").innerText();
    check(!detailText.includes(`[[Reference page|wiki:${target.id}]]`) && !detailText.includes(target.id), "activity summaries should show the readable link label instead of Markdown ids");
    const groupExpand = page.locator("li button[aria-controls^='activity-group-']").first();
    await groupExpand.waitFor();
    check((await groupExpand.getAttribute("aria-expanded")) === "false" && await groupExpand.evaluate((element) => element.innerHTML.includes("<br")), "timeline groups use a real expand button and put the changed value on a new line");
    if (locale === "th") check(detailText.includes("เป็น:"), "Thai timeline identifies the new value with เป็น:");
    for (const width of [1280, 390] as const) await capture("description-visual", locale, width);
    await description.getByRole("button", { name: translate("editor.sourceMode", locale) }).click();
    check((await description.getByTestId("editor-source-text").inputValue()).includes("A description edited in source mode."), "description source mode must preserve the written text after switching modes");
    await description.getByText(translate("editor.sourceReferenceHelp", locale), { exact: true }).waitFor();
    await descriptionSaved.waitFor();
    for (const width of [1280, 390] as const) await capture("description-source", locale, width);
    await page.goto(wikiUrl);
    const wikiEditor = page.locator("[data-testid=wiki-editor]");
    const wikiSourceToggle = async (key: "editor.sourceMode" | "editor.visualMode") => { await page.getByRole("button", { name: translate("wiki.exports", locale), exact: true }).click(); await page.getByRole("menuitem", { name: translate(key, locale), exact: true }).click(); };
    await wikiSourceToggle("editor.sourceMode");
    await wikiEditor.getByText(translate("editor.sourceReferenceHelp", locale), { exact: true }).waitFor();
    await wikiEditor.getByTestId("editor-source-text").fill(["Wiki page edited in source mode.", "", `[[Reference page|wiki:${target.id}]]`, "", "```diff", "-old", "+new", "```", "", "```mermaid", "flowchart LR", "  A[Write] --> B[Review]", "```"].join("\n"));
    await wikiSourceToggle("editor.visualMode");
    await wikiEditor.getByText("Wiki page edited in source mode.").waitFor();
    for (const width of [1280, 390] as const) await capture("wiki-visual", locale, width);
    await wikiSourceToggle("editor.sourceMode");
    for (const width of [1280, 390] as const) await capture("wiki-source", locale, width);
    await wikiEditor.getByTestId("editor-source-text").fill(["Wiki page edited in source mode.", "", `[[Reference page|wiki:${target.id}]]`, "", "```diff", "-old", "+new", "```", "", "```mermaid", "flowchart LR", "  A[Write] --> B[Review]", "```", "", "<custom-widget>unsupported formatting</custom-widget>"].join("\n"));
    await wikiSourceToggle("editor.visualMode");
    const sourceWarning = translate("editor.warning.unsupportedHtml", locale);
    const warningCallout = wikiEditor.getByRole("alert");
    await warningCallout.getByText(sourceWarning, { exact: true }).waitFor();
    const warningClasses = await warningCallout.getAttribute("class");
    check(warningClasses?.includes("text-warning-text") && warningClasses.includes("border-warning-strong") && await warningCallout.locator("svg").count() === 1, "source conversion warning should use warning contrast, a left border, and a warning icon");
    check(await wikiEditor.locator(".ProseMirror").evaluate((element) => element.textContent?.includes("unsupported formatting") ?? false), "unsupported HTML text should remain visible as plain text with a warning");
    for (const width of [1280, 390] as const) await capture("source-retained", locale, width);

    // Create a Comment through the visible composer, exercising the source and visual modes.
    await page.goto(detail);
    const emptyCommentComposer = page.getByTestId("comment-editor").last();
    await emptyCommentComposer.locator(".ProseMirror").waitFor();
    await capture("empty-comment", locale, 390);
    if (locale === "en") {
      const commentEditor = page.getByTestId("comment-editor").first();
      await commentEditor.getByRole("button", { name: translate("editor.sourceMode", locale) }).click();
      await commentEditor.getByTestId("editor-source-text").fill("A comment from the whole feature review.");
      for (const width of [1280, 390] as const) await capture("comment-source", locale, width);
      const codeButton = commentEditor.getByTestId("comment-toolbar").getByRole("button", { name: translate("wiki.tool.codeBlock", locale), exact: true });
      const tableButton = commentEditor.getByTestId("comment-toolbar").getByRole("button", { name: translate("wiki.insert.table", locale), exact: true });
      await commentEditor.getByRole("button", { name: translate("editor.visualMode", locale) }).click();
      check(Boolean(await codeButton.getAttribute("title")) && Boolean(await tableButton.getAttribute("title")), "comment code and table tools need names and tooltips");
      await page.setViewportSize({ width: 390, height: 844 });
      const toolSizes = await commentEditor.getByTestId("comment-toolbar").locator(".editor-tool").evaluateAll((buttons) => buttons.map((button) => { const rect = button.getBoundingClientRect(); return { label: button.getAttribute("aria-label"), title: button.getAttribute("title"), width: rect.width, height: rect.height }; }));
      check(toolSizes.every(({ width, height, label, title }) => width >= 40 && height >= 40 && !!label && !!title), `comment toolbar controls must be named and at least 40 px on a phone: ${JSON.stringify(toolSizes)}`);
      await page.setViewportSize({ width: 1280, height: 900 });
      const desktopTools = await commentEditor.getByTestId("comment-toolbar").locator(".editor-tool").evaluateAll((buttons) => buttons.map((button) => { const rect = button.getBoundingClientRect(); return { label: button.getAttribute("aria-label"), title: button.getAttribute("title"), width: rect.width, height: rect.height }; }));
      check(desktopTools.every(({ width, height, label, title }) => width >= 28 && height >= 28 && !!label && !!title), `comment desktop tools must be named, have tooltips, and be at least 28 px: ${JSON.stringify(desktopTools)}`);
      await commentEditor.locator(".ProseMirror").getByText("A comment from the whole feature review.").waitFor();
      await page.getByRole("button", { name: translate("comments.add", locale) }).click();
      const existingComment = page.locator("li[id^='comment-']").last();
      await existingComment.getByRole("button", { name: translate("comments.edit", locale), exact: true }).click();
      const edit = existingComment.getByTestId("comment-editor");
      await edit.waitFor();
      for (const width of [1280, 390] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const positions = await existingComment.evaluate((element) => Object.fromEntries([...element.querySelectorAll("button")].map((button) => [button.textContent?.trim(), button.getBoundingClientRect().y])));
        const saveY = positions[translate("comments.save", locale)]; const cancelY = positions[translate("comments.cancel", locale)];
        check(typeof saveY === "number" && typeof cancelY === "number" && Math.abs(saveY - cancelY) < 2, "Save and Cancel should share a row in the Comment edit form");
        check(!(await existingComment.getByRole("button", { name: translate("comments.reply", locale), exact: true }).count()) && !(await existingComment.getByRole("button", { name: translate("comments.copyLink", locale), exact: true }).count()), "Reply and Copy link must be hidden while editing a Comment");
        await capture("comment-edit-actions", locale, width);
      }
      await existingComment.getByRole("button", { name: translate("comments.cancel", locale), exact: true }).click();
    } else {
      const existingComment = page.locator("li[id^='comment-']").last();
      await existingComment.getByRole("button", { name: translate("comments.edit", locale), exact: true }).click();
      const commentEditor = existingComment.getByTestId("comment-editor");
      for (const width of [1280, 390] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const positions = await existingComment.evaluate((element) => Object.fromEntries([...element.querySelectorAll("button")].map((button) => [button.textContent?.trim(), button.getBoundingClientRect().y])));
        const saveY = positions[translate("comments.save", locale)]; const cancelY = positions[translate("comments.cancel", locale)];
        check(typeof saveY === "number" && typeof cancelY === "number" && Math.abs(saveY - cancelY) < 2, "Thai Save and Cancel should share a row in the Comment edit form");
        check(!(await existingComment.getByRole("button", { name: translate("comments.reply", locale), exact: true }).count()) && !(await existingComment.getByRole("button", { name: translate("comments.copyLink", locale), exact: true }).count()), "Thai Reply and Copy link must be hidden while editing a Comment");
        await capture("comment-edit-actions", locale, width);
      }
      await commentEditor.getByRole("button", { name: translate("editor.sourceMode", locale) }).click();
      for (const width of [1280, 390] as const) await capture("comment-source", locale, width);
      await commentEditor.getByRole("button", { name: translate("editor.visualMode", locale) }).click();
      const codeButton = commentEditor.getByTestId("comment-toolbar").getByRole("button", { name: translate("wiki.tool.codeBlock", locale), exact: true });
      const tableButton = commentEditor.getByTestId("comment-toolbar").getByRole("button", { name: translate("wiki.insert.table", locale), exact: true });
      check(Boolean(await codeButton.getAttribute("title")) && Boolean(await tableButton.getAttribute("title")), "Thai comment code and table tools need names and tooltips");
      await page.setViewportSize({ width: 390, height: 844 });
      const thaiToolSizes = await commentEditor.getByTestId("comment-toolbar").locator(".editor-tool").evaluateAll((buttons) => buttons.map((button) => { const rect = button.getBoundingClientRect(); return { label: button.getAttribute("aria-label"), width: rect.width, height: rect.height, minWidth: getComputedStyle(button).minWidth, minHeight: getComputedStyle(button).minHeight }; }));
      check(thaiToolSizes.every(({ width, height, label }) => width >= 40 && height >= 40 && !!label), `Thai comment toolbar controls must be named and at least 40 px on a phone: ${JSON.stringify(thaiToolSizes)}`);
      await page.setViewportSize({ width: 1280, height: 900 });
      const thaiDesktopTools = await commentEditor.getByTestId("comment-toolbar").locator(".editor-tool").evaluateAll((buttons) => buttons.map((button) => { const rect = button.getBoundingClientRect(); return { label: button.getAttribute("aria-label"), title: button.getAttribute("title"), width: rect.width, height: rect.height }; }));
      check(thaiDesktopTools.every(({ width, height, label, title }) => width >= 28 && height >= 28 && !!label && !!title), `Thai comment desktop tools must be named, have tooltips, and be at least 28 px: ${JSON.stringify(thaiDesktopTools)}`);
      await existingComment.getByRole("button", { name: translate("comments.cancel", locale), exact: true }).click();
    }
    await page.locator(".comment-body").getByText("A comment from the whole feature review.", { exact: true }).waitFor();
    await page.locator(".comment-body").last().scrollIntoViewIfNeeded();
    for (const width of [1280, 390] as const) await capture("comment", locale, width);

    await page.goto(targetUrl);
    // A Wiki page's Backlinks live in the Details panel's Links tab; the panel starts hidden (a drawer below 1024px).
    const openBacklinks = async () => {
      const detailsToggle = page.getByTestId("wiki-details-toggle");
      await detailsToggle.waitFor();
      if (await detailsToggle.getAttribute("aria-pressed") !== "true") await detailsToggle.click();
      await page.getByRole("complementary", { name: translate("wiki.details", locale), exact: true }).getByRole("tab", { name: translate("outlinks.title", locale), exact: true }).click();
    };
    await openBacklinks();
    const backlink = page.getByRole("region", { name: translate("outlinks.title", locale), exact: true }).getByRole("link", { name: /Feature notes/ });
    await backlink.waitFor();
    const backlinkPanel = page.getByRole("region", { name: translate("outlinks.title", locale), exact: true });
    await backlinkPanel.getByText(translate("outlinks.explanation", locale), { exact: true }).waitFor();
    check(!(await backlinkPanel.innerText()).includes(locale === "en" ? "Backlinks" : "ลิงก์ย้อนกลับ"), "the explanatory sentence replaces the extra Backlinks tag");
    for (const width of [1280, 390] as const) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await openBacklinks(); await capture("backlink", locale, width); }
    await backlink.click();
    await page.waitForURL(wikiUrl);
    await page.getByText("Wiki page edited in source mode.").waitFor();
    await page.locator(".ProseMirror .hljs-deletion").waitFor();
    await page.getByText(translate("editor.diffLegend", locale), { exact: true }).waitFor();
    await page.locator(".ProseMirror .mermaid-diagram img").waitFor();
    await page.locator(".ProseMirror .diff-caption").getByText(translate("editor.diffCaption", locale), { exact: true }).waitFor();
    const diagramSrc = await page.locator(".ProseMirror .mermaid-diagram img").getAttribute("src");
    const diagramSvg = diagramSrc ? decodeURIComponent(diagramSrc.slice(diagramSrc.indexOf(",") + 1)) : "";
    check(/(?:dy|dominant-baseline)=/.test(diagramSvg), "Mermaid text baseline data must survive SVG isolation so labels stay centered");
    const mermaidSource = page.locator(".ProseMirror .mermaid-source").first();
    check(!(await mermaidSource.evaluate((element) => (element as HTMLDetailsElement).open)), "valid Mermaid source should start collapsed");
    await mermaidSource.locator("summary").click();
    await mermaidSource.locator("pre code").getByText("flowchart LR", { exact: false }).waitFor();
    for (const width of [1280, 390] as const) await capture("diagram-source", locale, width);
    await mermaidSource.locator("summary").click();
    for (const theme of ["light", "dark"] as const) for (const width of [1280, 390] as const) await capture("diff-diagram", locale, width, theme);
    for (const width of [1280, 390] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const diffBounds = await page.locator(".ProseMirror .hljs-deletion").first().evaluate((removed) => {
        const code = removed.closest<HTMLElement>("code");
        const added = removed.parentElement?.querySelector<HTMLElement>(".hljs-addition");
        const copy = removed.closest("pre")?.querySelector<HTMLElement>(".code-block-copy");
        const a = removed.getBoundingClientRect(), b = added?.getBoundingClientRect(), c = copy?.getBoundingClientRect();
        return { gap: b ? b.top - a.bottom : Infinity, copyTop: c?.top ?? -Infinity, additionBottom: b?.bottom ?? Infinity, copyHeight: c?.height ?? 0, codeClass: code?.className, codeStyle: code ? { fontSize: getComputedStyle(code).fontSize, lineHeight: getComputedStyle(code).lineHeight } : null, codeHtml: code?.innerHTML };
      });
      check(diffBounds.gap <= 3, `diff lines have an unexplained blank gap: ${JSON.stringify(diffBounds)}`);
      check(diffBounds.copyTop >= diffBounds.additionBottom, `copy button overlaps diff text: ${JSON.stringify(diffBounds)}`);
      if (width === 390) check(diffBounds.copyHeight >= 32, `phone copy button must be at least 32 px high: ${JSON.stringify(diffBounds)}`);
    }
    const exportButton = page.getByRole("button", { name: translate("wiki.exports", locale) });
    await exportButton.click();
    const exportItem = page.getByRole("menuitem", { name: translate("wiki.exportMarkdown", locale), exact: true });
    await exportItem.waitFor();
    check(await exportItem.getAttribute("title") === translate("wiki.markdownHint", locale), "Markdown export should explain how .md differs from PDF");
    await page.getByText(translate("wiki.markdownHint", locale), { exact: true }).waitFor();
    for (const width of [1280, 390] as const) await capture("export-menu", locale, width);
    const [download] = await Promise.all([page.waitForEvent("download"), exportItem.click()]);
    check(download.suggestedFilename() === "Feature notes.md", "Markdown export should use the page title");
    await page.getByRole("status").getByText(translate("wiki.downloadStarted", locale).replace("{filename}", "Feature notes.md"), { exact: true }).waitFor();
    await page.getByRole("button", { name: translate("wiki.dismissDownload", locale) }).waitFor();
    const assertDownloadToastClear = async (width: 1280 | 390) => {
      const toast = page.getByTestId("wiki-download-toast");
      const toastBox = await toast.boundingBox();
      check(Boolean(toastBox), "download feedback should be visible");
      for (const label of [translate("wiki.exports", locale)]) {
        const actions = page.getByRole("button", { name: label, exact: true });
        for (let i = 0; i < await actions.count(); i++) {
          const box = await actions.nth(i).boundingBox();
          if (!box || box.y >= (width === 390 ? 844 : 900) || box.y + box.height <= 0) continue;
          check(toastBox!.x + toastBox!.width <= box.x || box.x + box.width <= toastBox!.x || toastBox!.y + toastBox!.height <= box.y || box.y + box.height <= toastBox!.y, `download feedback overlaps ${label} at ${width}px`);
        }
      }
    };
    for (const width of [1280, 390] as const) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await assertDownloadToastClear(width); }
    for (const width of [1280, 390] as const) await capture("download-started", locale, width);

    await page.route("**/actions/get_wiki_page", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "simulated failure" }) }));
    await exportButton.click();
    await page.getByRole("menuitem", { name: translate("wiki.exportMarkdown", locale), exact: true }).click();
    await page.getByRole("alert").getByText(translate("wiki.downloadFailed", locale).replace("{filename}", "Feature notes.md"), { exact: true }).waitFor();
    for (const width of [1280, 390] as const) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await assertDownloadToastClear(width); }
    await page.getByRole("button", { name: translate("wiki.retryDownload", locale) }).waitFor();
    check((await page.getByRole("alert").getAttribute("class"))?.includes("text-danger-text"), "download failures should use error styling");
    const retryResponse = page.waitForResponse((response) => response.url().endsWith("/actions/get_wiki_page") && response.status() === 500);
    await page.getByRole("button", { name: translate("wiki.retryDownload", locale) }).click();
    await retryResponse;
    await page.getByRole("alert").getByText(translate("wiki.downloadFailed", locale).replace("{filename}", "Feature notes.md"), { exact: true }).waitFor();
    for (const width of [1280, 390] as const) await capture("download-failed", locale, width);
    await page.getByRole("button", { name: translate("wiki.dismissDownload", locale) }).click();
    await page.getByRole("alert").waitFor({ state: "detached" });
    await page.unroute("**/actions/get_wiki_page");

    if (locale === "en") {
      await exportButton.click();
      const importResponse = page.waitForResponse((response) => response.url().endsWith("/actions/create_wiki_page") && response.request().method() === "POST");
      const importSource = "Imported from a Markdown file.\n\nA helpful next step.\n\n<custom-widget>kept as text</custom-widget>\n\n![missing image](missing.png)\n\n[unsafe link](javascript:alert(1))";
      await page.locator("#wiki-markdown-import").setInputFiles({ name: "Imported notes.md", mimeType: "text/markdown", buffer: Buffer.from(importSource) });
      const importBody = await (await importResponse).json() as { contentMarkdownWarningDetails?: { code: string; message: string }[] };
      importedWarnings = importBody.contentMarkdownWarningDetails ?? [];
      check(importedWarnings.length >= 3, "the import should report all unsupported elements");
      await page.waitForURL((url) => url.href !== wikiUrl && /\/wiki\/[0-9a-f-]+$/.test(url.pathname));
      await page.getByRole("heading", { name: "Imported notes", exact: true }).waitFor();
      importedUrl = page.url();
    } else {
      check(importedUrl !== null, "English import should create one page for the bilingual capture");
      const importedId = importedUrl.match(/\/wiki\/([0-9a-f-]+)$/)?.[1];
      check(Boolean(importedId), "imported page URL should contain its id");
      await page.evaluate(({ id, warnings }) => sessionStorage.setItem(`wiki-import-feedback:${id}`, JSON.stringify({ warnings, source: "Imported from a Markdown file.\n\nA helpful next step.\n\n<custom-widget>kept as text</custom-widget>\n\n![missing image](missing.png)\n\n[unsafe link](javascript:alert(1))" })), { id: importedId!, warnings: importedWarnings });
      await page.goto(importedUrl!);
    }
    const importResult = page.getByRole("alert", { name: translate("wiki.importResult", locale) });
    await importResult.getByText(translate("wiki.importSuccess", locale), { exact: true }).waitFor();
    await importResult.getByText(translate("wiki.importWarningsTitle", locale), { exact: true }).waitFor();
    await importResult.getByText(/custom-widget/).waitFor();
    await importResult.getByText(/missing image/).waitFor();
    await importResult.getByText(/unsafe link/).waitFor();
    for (const width of [1280, 390] as const) await capture("import-result", locale, width);
    await importResult.getByRole("button", { name: translate("wiki.dismissImportResult", locale) }).click();
    await importResult.waitFor({ state: "detached" });
    await page.goto(`${web}/${slug}/wiki/${errorWiki.id}`);
    await page.locator(".mermaid-error").getByText(translate("editor.mermaidError", locale), { exact: true }).waitFor();
    check(await page.locator(".mermaid-source").evaluate((element) => (element as HTMLDetailsElement).open), "a failed diagram should show its source automatically");
    for (const width of [1280, 390] as const) await capture("diagram-error", locale, width);
  }
  await browser.close();
} catch (error) { failed = true; console.error(error); }
finally { servers.forEach((server) => server.kill()); await client.end(); }
process.exit(failed ? 1 : 0);
