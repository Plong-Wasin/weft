// Browser end-to-end check for shared ProseMirror styling and slash commands.
import { chromium, type Browser } from "playwright";
import { mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { comments, createDatabase, users, workspaces, workItemDescriptionVersions } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31158);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52158);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31178);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const liveHttp = `http://localhost:${livePort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}`, CHOKIDAR_USEPOLLING: "true" }, stdout: "ignore", stderr: "inherit" }),
];
let slug = "";
let browser: Browser | null = null;

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(liveHttp)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: web });
  const page = await context.newPage();
  slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const captureTicketScreen = async (name: string, scrollTo?: string) => {
    const directory = Bun.env.E2E_RTM_CAPTURE_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (scrollTo) await page.locator(scrollTo).last().scrollIntoViewIfNeeded();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({ path: `${directory}/01-${name}-${width}-en.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  const captureSourceTicket = async (name: string, root: string, mode: "visual" | "source", lang: "en" | "th") => {
    const directory = Bun.env.E2E_RTM_CAPTURE_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    await page.locator(root).first().scrollIntoViewIfNeeded();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({ path: `${directory}/02-${name}-${mode}-${width}-${lang}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  // The Wiki and Page editors keep Show text with symbols in the page menu; the description and Comment editors keep their own button.
  const clickSourceToggle = async (root: string, key: "editor.sourceMode" | "editor.visualMode", lang?: "en" | "th") => {
    if (root !== "[data-testid='wiki-editor']") { const toolbar = root === "[data-testid='description-editor']" ? page.getByTestId("description-toolbar") : page.getByTestId("comment-toolbar").first(); await toolbar.getByRole("button", { name: translate("editor.sourceMode", lang), exact: true }).click(); return; }
    await page.getByRole("button", { name: translate("wiki.exports", lang), exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: translate("editor.sourceMode", lang), exact: true }).click(); // one switch: Markdown source, its state in aria-checked
  };
  const roundTripSource = async (name: string, root: string, sample: string) => {
    const area = page.locator(root).first();
    await clickSourceToggle(root, "editor.sourceMode");
    const source = area.getByTestId("editor-source-text");
    await source.waitFor();
    const before = await source.inputValue();
    check(before.includes(sample), `${name} source mode omitted its written text`);
    await captureSourceTicket(name, root, "source", "en");
    await clickSourceToggle(root, "editor.visualMode");
    await clickSourceToggle(root, "editor.sourceMode");
    const after = await area.getByTestId("editor-source-text").inputValue();
    check(after === before, `${name} changed when switching between visual and source modes: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    await clickSourceToggle(root, "editor.visualMode");
    await captureSourceTicket(name, root, "visual", "en");
  };
  const captureThaiModes = async (name: string, root: string) => {
    const area = page.locator(root).first();
    await clickSourceToggle(root, "editor.sourceMode", "th");
    await captureSourceTicket(name, root, "source", "th");
    await clickSourceToggle(root, "editor.visualMode", "th");
    await captureSourceTicket(name, root, "visual", "th");
  };
  const captureDiffThemes = async (name: string, root: string) => {
    const directory = Bun.env.E2E_RTM_CAPTURE_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const block = page.locator(root).last();
        await block.scrollIntoViewIfNeeded();
        await page.evaluate(() => {
          window.scrollTo({ left: 0, top: window.scrollY });
          document.querySelectorAll<HTMLElement>("*").forEach((element) => { if (element.scrollLeft) element.scrollLeft = 0; });
        });
        if (width === 390) {
          const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
          check(pageWidth <= width, `${name} long diff widened the page on a phone: page width ${pageWidth}px`);
          const dimensions = await block.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, codeScroll: el.querySelector("code")?.scrollWidth, codeClient: el.querySelector("code")?.clientWidth, overflow: getComputedStyle(el).overflowX, whiteSpace: getComputedStyle(el.querySelector("code")!).whiteSpace }));
          check(dimensions.scroll > dimensions.client, `${name} long diff did not scroll inside its code block on a phone: ${JSON.stringify(dimensions)}`);
        }
        await page.screenshot({ path: `${directory}/07-diff-${name}-${width}-${theme}.png`, fullPage: true });
      }
    }
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  const setCaptureLocale = async (language: "en" | "th") => {
    await call("set_my_locale", { locale: language });
    await page.evaluate((value) => localStorage.setItem("weft.locale", value), language);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  };
  const captureWorkItemPhone = async (name: string, language: "en" | "th", diff: boolean) => {
    const directory = Bun.env.E2E_RTM_CAPTURE_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    await setCaptureLocale(language);
    await page.getByTestId("description-editor").locator(".ProseMirror").waitFor();
    if (name === "comment") await page.locator("li[id^='comment-'] .ProseMirror pre code").filter({ hasText: "removed example" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    if (name === "comment") await page.locator("li[id^='comment-'] .ProseMirror pre").last().scrollIntoViewIfNeeded();
    const beforeCapture = await page.evaluate(() => ({ windowX: window.scrollX, documentWidth: document.documentElement.scrollWidth, scrollers: [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => element.scrollLeft !== 0).map((element) => ({ tag: element.tagName, className: element.className, scrollLeft: element.scrollLeft, width: element.clientWidth, scrollWidth: element.scrollWidth })).slice(0, 12) }));
    if (name === "comment" && language === "en") console.log(`phone scroll before reset ${JSON.stringify(beforeCapture)}`);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll<HTMLElement>("*").forEach((element) => { if (element.scrollLeft) element.scrollLeft = 0; }); });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      const viewport = await page.evaluate(() => ({ scrollX: window.scrollX, innerWidth: window.innerWidth }));
      if (diff && language === "en" && theme === "light") {
        const dimensions = await page.locator("li[id^='comment-'] .ProseMirror pre").last().evaluate((pre) => {
          const rect = pre.getBoundingClientRect(); const style = getComputedStyle(pre);
          const lines = [...pre.querySelectorAll<HTMLElement>(".hljs-deletion, .hljs-addition")].map((line) => ({ kind: line.className, width: Math.round(line.getBoundingClientRect().width) }));
          return { preWidth: Math.round(rect.width), preRight: Math.round(rect.right), preClientWidth: pre.clientWidth, preScrollWidth: pre.scrollWidth, overflowX: style.overflowX, lines };
        });
        console.log(`phone width audit ${name} ${language} ${theme}: document=${width}px scrollX=${viewport.scrollX} ${JSON.stringify(dimensions)}`);
        check(dimensions.preRight <= 390 && dimensions.overflowX === "auto" && dimensions.preScrollWidth > dimensions.preClientWidth, "long diff is not contained by its horizontally scrollable code block");
      }
      check(width <= 390 && viewport.scrollX === 0 && viewport.innerWidth === 390, `${name} work item has horizontal page scrolling at 390px in ${language}/${theme}: document=${width}px scrollX=${viewport.scrollX} viewport=${viewport.innerWidth}px`);
      await page.screenshot({ path: `${directory}/07-work-item-${name}-390-${language}-${theme}.png`, fullPage: true });
    }
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  const exitList = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inList = await page.evaluate(() => { const node = window.getSelection()?.anchorNode; return (node instanceof Element ? node : node?.parentElement)?.closest("li") != null; });
      if (!inList) return;
      await page.keyboard.press("Enter");
    }
    const stillInList = await page.evaluate(() => { const node = window.getSelection()?.anchorNode; return (node instanceof Element ? node : node?.parentElement)?.closest("li") != null; });
    check(!stillInList, "could not leave the active list item");
  };
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name} failed: ${response.status()}: ${await response.text()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Editor Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const seededLinkDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Read only link", marks: [{ type: "link", attrs: { href: "https://example.edu" } }] }] }] };
  const descriptionFixture = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Description alignment is not supported" }] },
    { type: "paragraph", content: [{ type: "text", text: "Description colour", marks: [{ type: "textStyle", attrs: { color: "#3b82f6" } }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Description task" }] }] }] },
    { type: "callout", attrs: { color: "#f97316" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Description callout" }] }] },
    { type: "paragraph", content: [{ type: "mention", attrs: { id: "person-e2e", label: "Mention proof" } }] },
    { type: "paragraph", content: [{ type: "text", text: "Converter formatting" }, { type: "text", text: " highlight", marks: [{ type: "highlight" }] }, { type: "text", text: " underline", marks: [{ type: "underline" }] }, { type: "text", text: " sub", marks: [{ type: "subscript" }] }, { type: "text", text: " super", marks: [{ type: "superscript" }] }, { type: "text", text: " purple", marks: [{ type: "textStyle", attrs: { color: "purple" } }] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Description table" }] }] }] }] },
  ] };
  const workItem = await call<{ id: string }>("create_work_item", { projectId: project!.id, title: "Editor parity", description: descriptionFixture });
  await call("update_work_item", { workItemId: workItem.id, description: descriptionFixture });
  const seededTable = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Read only table" }] }] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }] }] }] }] };
  const richComment = { type: "doc", content: [
    ...(seededLinkDoc.content as object[]),
    { type: "paragraph", content: [{ type: "text", text: "Converter formatting" }, { type: "text", text: " highlight", marks: [{ type: "highlight" }] }, { type: "text", text: " underline", marks: [{ type: "underline" }] }, { type: "text", text: " sub", marks: [{ type: "subscript" }] }, { type: "text", text: " super", marks: [{ type: "superscript" }] }, { type: "text", text: " purple", marks: [{ type: "textStyle", attrs: { color: "purple" } }] }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Comment heading" }] },
    ...seededTable.content,
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Read only list" }] }] }] },
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Read only quote" }] }] },
    { type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: "const readOnly = true" }] },
    { type: "codeBlock", attrs: { language: "diff" }, content: [{ type: "text", text: `-removed example ${"x".repeat(240)}\n+added example ${"y".repeat(240)}` }] },
  ] };
  await call("create_comment", { workItemId: workItem.id, body: richComment });
  {
    const { db: seedDb, client: seedClient } = createDatabase();
    await seedDb.insert(comments).values({
      workspaceId: me.workspaces[0]!.id, projectId: project!.id, workItemId: workItem.id, authorId: me.user.id,
      body: { type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Legacy alignment" }] }] },
      bodyMarkdown: "Legacy alignment", bodyText: "Legacy alignment",
    });
    await seedClient.end();
  }
  await call("create_comment", { workItemId: workItem.id, bodyMarkdown: "| Agent | Result |\n| --- | --- |\n| Markdown | rendered |" });
  await call("create_wiki_page", { workspaceId: me.workspaces[0]!.id, title: "Editor page", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Wiki alignment written as plain text" }] }, ...(seededLinkDoc.content as object[]), { type: "paragraph", content: [{ type: "text", text: "Converter formatting" }, { type: "text", text: " highlight", marks: [{ type: "highlight" }] }, { type: "text", text: " underline", marks: [{ type: "underline" }] }, { type: "text", text: " sub", marks: [{ type: "subscript" }] }, { type: "text", text: " super", marks: [{ type: "superscript" }] }, { type: "text", text: " purple", marks: [{ type: "textStyle", attrs: { color: "purple" } }] }] }, { type: "codeBlock", attrs: { language: "diff" }, content: [{ type: "text", text: `-removed from Wiki ${"x".repeat(240)}\n+added to Wiki ${"y".repeat(240)}` }] }, { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Wiki table" }] }] }] }] }] } });
  const projectPageCreated = await call<{ id: string }>("create_wiki_page", { workspaceId: me.workspaces[0]!.id, projectId: project!.id, title: "Editor project page", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Project page colour", marks: [{ type: "textStyle", attrs: { color: "purple" } }] }] }, { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Project page table" }] }] }] }] }] } });
  const wikiPages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId: me.workspaces[0]!.id });
  const wiki = wikiPages.find((candidate) => candidate.title === "Editor page")!;

  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const description = page.getByTestId("description-editor").locator(".ProseMirror");
  const comment = page.getByTestId("comment-editor").locator(".ProseMirror");
  await description.waitFor();
  await comment.waitFor();
  await page.locator("li[id^='comment-'] .ProseMirror pre code").filter({ hasText: "removed example" }).waitFor();
  if (Bun.env.E2E_RTM_CAPTURE_DIR) {
    await captureWorkItemPhone("comment", "en", true);
    await captureWorkItemPhone("comment", "th", true);
    const plainItem = await call<{ displayId: string }>("create_work_item", { projectId: project!.id, title: "Plain phone width proof" });
    await page.goto(`${web}/${slug}/browse/${plainItem.displayId}`);
    await page.getByTestId("description-editor").waitFor();
    await captureWorkItemPhone("plain", "en", false);
    await captureWorkItemPhone("plain", "th", false);
    await page.goto(`${web}/${slug}/browse/MOB-1`);
    await page.getByTestId("comment-editor").waitFor();
    if (Bun.env.E2E_WORK_ITEM_CAPTURE_ONLY === "true") throw "WORK_ITEM_CAPTURE_COMPLETE";
  }
  const markdownComment = page.locator("li[id^='comment-']").filter({ hasText: "Markdown" }).last();
  await markdownComment.locator(".comment-body table").waitFor();
  check(await markdownComment.locator(".comment-body th").count() === 2 && await markdownComment.locator(".comment-body td").count() === 2, "Markdown API comment did not render as a two-column table in the browser");
  console.log("case passed: API Markdown comment table renders in the browser");
  const formattedCommentRow = page.locator("li[id^='comment-']").filter({ hasText: "Converter formatting" }).first();
  const formattedComment = formattedCommentRow.locator(".comment-body");
  await formattedComment.locator("u").waitFor();
  check(await formattedComment.locator("mark").count() === 1 && await formattedComment.locator("sub").count() === 1 && await formattedComment.locator("sup").count() === 1 && await formattedComment.locator('span[style*="purple"]').count() === 1, "Comment did not render the converter's inline marks");
  const descriptionText = await description.innerText();
  check(await description.locator("table").count() === 1 && await description.locator("li").count() === 1 && descriptionText.includes("Description table") && descriptionText.includes("Description task"), `Description did not load table and task list nodes: ${descriptionText}; tables=${await description.locator("table").count()}, lis=${await description.locator("li").count()}`);
  check(await description.locator("aside[data-callout]").count() === 1 && descriptionText.includes("@Mention proof") && await description.locator("span[style*='color']").count() >= 2 && descriptionText.includes("Description callout"), `Description did not load colour, callout and mention nodes: ${await description.locator("aside[data-callout]").count()} ${await description.locator(".mention").count()} ${await description.locator("span[style*='color']").count()} ${await description.innerHTML()}`);
  check(await description.locator("u").filter({ hasText: "underline" }).count() === 1 && await description.locator("sub").filter({ hasText: "sub" }).count() === 1 && await description.locator("sup").filter({ hasText: "super" }).count() === 1 && await description.locator('span[style*="purple"]').count() === 1, "Description did not render the converter's underline, subscript, superscript, or named color");
  check(await page.getByTestId("description-editor").getByText("Description alignment is not supported").count() === 1, "Description did not preserve the plain-text explanation for unsupported formatting");
  const descriptionTableStyles = await description.evaluate((root) => {
    const header = root.querySelector("table th, table td");
    const taskList = root.querySelector('ul[data-type="taskList"]');
    const callout = root.querySelector("aside[data-callout]");
    return { border: header ? getComputedStyle(header).borderTopWidth : "missing", header: header ? getComputedStyle(header).backgroundColor : "missing", taskMarker: taskList ? getComputedStyle(taskList).listStyleType : "missing", calloutBorder: callout ? getComputedStyle(callout).borderTopWidth : "missing", calloutHeight: callout?.getBoundingClientRect().height ?? 0 };
  });
  check(descriptionTableStyles.border !== "0px" && descriptionTableStyles.header !== "rgba(0, 0, 0, 0)" && descriptionTableStyles.taskMarker === "none" && descriptionTableStyles.calloutBorder !== "0px" && descriptionTableStyles.calloutHeight <= 100, `Description callout, task-list or table styling is not visible: ${JSON.stringify(descriptionTableStyles)}`);
  check(await page.getByTestId("description-toolbar").getByRole("button", { name: translate("wiki.insert.image"), exact: true }).evaluate((button) => button.closest('[role="toolbar"]') !== null), "Description Add image action is not labelled in its toolbar");
  check(await page.getByTestId("description-editor").locator(".asset-image-resize, .column-resize-handle").count() === 0, "Description editor offers a drag handle for a Written form attribute that it cannot persist");
  console.log("case passed: Description renders table, task list, colour, callout and mention");
  await roundTripSource("description", "[data-testid='description-editor']", "Description colour");
  await captureTicketScreen("description-comments");
  await captureTicketScreen("comments", "li[id^='comment-']");
  const descriptionEditor = page.getByTestId("description-editor");
  await page.getByTestId("description-toolbar").getByRole("button", { name: translate("editor.sourceMode"), exact: true }).click();
  await descriptionEditor.getByTestId("editor-source-text").fill("<script>keep this text</script>");
  await page.getByTestId("description-toolbar").getByRole("button", { name: translate("editor.sourceMode"), exact: true }).click();
  const unsupportedHtmlWarning = descriptionEditor.getByRole("alert").filter({ hasText: translate("editor.warning.unsupportedHtml") });
  await unsupportedHtmlWarning.waitFor();
  check(await descriptionEditor.locator(".ProseMirror").evaluate((element) => element.textContent?.includes("keep this text") ?? false), "unsupported HTML text should remain visible as plain text");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  const reloadedDescription = page.getByTestId("description-editor").locator(".ProseMirror");
  await reloadedDescription.getByText("Description task", { exact: true }).waitFor({ timeout: 15000 });
  check(await reloadedDescription.locator("table").count() === 1 && await reloadedDescription.locator("li").count() === 1 && await reloadedDescription.locator("aside[data-callout]").count() === 1 && await reloadedDescription.locator("span[style*='color']").count() >= 2 && (await reloadedDescription.innerText()).includes("Mention proof"), "Description rich nodes did not save and reload");
  console.log("case passed: Description table, task list, colour, callout and mention save and reload");
  await comment.waitFor();
  const calloutOptions = page.getByRole("button", { name: translate("callout.options"), exact: true });
  const codeLanguage = page.getByLabel(translate("editor.codeLanguage"), { exact: true });
  check(await calloutOptions.count() === 0 && await codeLanguage.count() === 0, "fresh Description editor shows node-specific controls");
  check(await page.getByTestId("comment-editor").getByRole("button", { name: translate("callout.options"), exact: true }).count() === 0 && await page.getByTestId("comment-editor").getByLabel(translate("editor.codeLanguage"), { exact: true }).count() === 0, "fresh Comment editor shows node-specific controls");
  check(await page.getByTestId("comment-toolbar").locator("button").evaluateAll((buttons) => buttons.every((button) => button.classList.contains("editor-tool")))
    && await page.getByRole("button", { name: translate("wiki.insert.image"), exact: true }).last().evaluate((button) => button.classList.contains("editor-tool"))
    && await page.getByRole("button", { name: translate("comments.add"), exact: true }).evaluate((button) => button.classList.contains("primary")), "Comment toolbar, image, or Comment button is missing its design-system style");
  const commentToolbar = page.getByTestId("comment-toolbar");
  for (const key of ["wiki.tool.bold", "wiki.tool.italic", "wiki.tool.strike", "wiki.tool.bulletList", "wiki.tool.orderedList", "wiki.tool.quote", "wiki.tool.code", "wiki.tool.link"]) {
    const label = translate(key as never), button = commentToolbar.getByRole("button", { name: label, exact: true });
    check(await button.getAttribute("aria-label") === label && (await button.getAttribute("title"))?.startsWith(label) === true, `Comment ${label} control needs a visible tooltip and accessible name`);
    await button.hover();
  }
  check(await commentToolbar.getByRole("button", { name: translate("wiki.tool.link"), exact: true }).locator("svg").count() === 1, "Comment link control does not use a link icon");
  console.log("case passed: Comment toolbar, image and Comment actions use design-system button variants");

  // Comment slash menu and table actions follow the description editor, while mentions and AI assist remain available.
  const commentEditorRoot = page.getByTestId("comment-editor");
  await comment.click(); await page.keyboard.type("@Editor");
  const mentionMenu = page.getByRole("listbox").filter({ has: page.getByRole("option", { name: "Editor Tester", exact: true }) });
  await mentionMenu.getByRole("option", { name: "Editor Tester", exact: true }).click();
  check(await comment.locator(".mention").count() === 1, "Comment mention selection no longer inserts a mention");
  await comment.click(); await page.keyboard.press("End"); await page.keyboard.press("Space"); await page.keyboard.type("Assist retained"); await page.keyboard.press("Shift+Home");
  const commentAssistToolbar = commentEditorRoot.getByRole("toolbar", { name: translate("assist.menu") });
  await commentAssistToolbar.waitFor();
  check(await commentAssistToolbar.getByRole("button", { name: translate("assist.task.rephrase"), exact: true }).count() === 1 || await commentAssistToolbar.getByRole("status").count() === 1, "Comment AI assist options or configured-state message are missing after selecting text");
  await comment.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  const commentSlashMenu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await commentSlashMenu.waitFor();
  await commentSlashMenu.getByRole("option", { name: translate("wiki.insert.image"), exact: true }).waitFor();
  await commentSlashMenu.getByRole("option", { name: translate("wiki.insert.table"), exact: true }).waitFor();
  await page.keyboard.type("table");
  await commentSlashMenu.getByRole("option", { name: translate("wiki.insert.table"), exact: true }).waitFor();
  check(await commentSlashMenu.getByRole("option").count() === 1, "Comment slash menu did not filter to the table command");
  await page.keyboard.press("Enter");
  await commentSlashMenu.waitFor({ state: "detached" });
  check(await comment.locator("table").count() === 1, "keyboard selection from the Comment slash menu did not insert a table");
  const insertedCommentTable = comment.locator("table").last();
  check(await insertedCommentTable.locator("th, td").first().evaluate((cell) => getComputedStyle(cell).borderTopWidth) !== "0px", "inserted Comment table has no visible cell borders");
  await insertedCommentTable.locator("td, th").first().click();
  const commentGrip = (id: string) => commentEditorRoot.locator(`[data-table-grip="${id}"]`);
  check(await page.locator(`[aria-label="${translate("table.controls")}"]`).count() === 0, "Comment table still shows the text-button bar");
  check(await commentGrip("row-0").count() === 1 && await commentGrip("column-0").count() === 1, "Comment table grips did not appear for the caret");
  check(await commentGrip("column-0").getAttribute("aria-label") === translate("table.columnMenu"), "Comment column grip has no accessible name");
  await commentGrip("row-0").click();
  await page.getByRole("menuitem", { name: translate("table.insertRowBelow"), exact: true }).click();
  await insertedCommentTable.locator("td, th").first().click();
  await commentGrip("column-0").click();
  await page.getByRole("menuitem", { name: translate("table.insertColumnRight"), exact: true }).click();
  check(await insertedCommentTable.locator("tr").count() === 4 && await insertedCommentTable.locator("tr").first().locator("th, td").count() === 4, "Comment table controls did not insert a row and column");
  const firstCommentCell = insertedCommentTable.locator("th, td").first();
  await firstCommentCell.click(); await page.keyboard.type("Inserted Comment table");
  await page.keyboard.press("Control+Home");
  await commentGrip("row-0").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  const savedTableComment = page.locator("li[id^='comment-']").filter({ hasText: "Inserted Comment table" }).last();
  await savedTableComment.waitFor();
  check(await savedTableComment.locator("table").count() === 1, "submitting a table Comment did not preserve its table");
  await savedTableComment.getByRole("button", { name: translate("comments.more"), exact: true }).first().click(); await savedTableComment.getByRole("button", { name: translate("comments.edit"), exact: true }).click();
  const editComment = savedTableComment.getByTestId("comment-editor").locator(".ProseMirror");
  await editComment.locator("table").waitFor();
  check(await editComment.locator("table").count() === 1, "editing an existing Comment lost its table");
  await savedTableComment.getByRole("button", { name: translate("comments.save"), exact: true }).click();
  await savedTableComment.locator(".comment-body table").waitFor();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  const reloadedTableComment = page.locator("li[id^='comment-']").filter({ hasText: "Inserted Comment table" }).last();
  await reloadedTableComment.locator(".comment-body table").waitFor();
  console.log("case passed: Comment slash menu, keyboard table insert, table controls, submit, edit and reload");

  // Mouse selection in the Comment slash menu remains available too.
  await comment.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  const mouseCommentMenu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await mouseCommentMenu.getByRole("option", { name: translate("wiki.insert.table"), exact: true }).click();
  check(await comment.locator("table").count() === 1, "mouse selection from the Comment slash menu did not insert a table");
  await comment.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  console.log("case passed: Comment slash menu supports mouse selection");
  await description.getByText("Description callout", { exact: true }).click();
  await calloutOptions.waitFor();
  await page.keyboard.press("Shift+Tab");
  check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === translate("callout.options"), "Callout options is not reachable by keyboard or labelled");
  await description.getByText("Description colour", { exact: true }).click();
  await calloutOptions.waitFor({ state: "detached" });
  console.log("case passed: Callout options stay hidden outside an active callout");
  if (Bun.env.E2E_SCREENSHOT_DIR) {
    mkdirSync(Bun.env.E2E_SCREENSHOT_DIR, { recursive: true });
    for (const [theme, width, height] of [["light", 1440, 900], ["dark", 1440, 900], ["light", 768, 900], ["dark", 768, 900], ["light", 390, 844], ["dark", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: `${Bun.env.E2E_SCREENSHOT_DIR}/03-editor-${theme}-${width}.png`, fullPage: true });
    }
    console.log("case passed: editor chrome screenshots captured in light and dark themes at desktop and phone widths");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  }
  await description.getByText("Description colour").click(); await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
  await page.getByTestId("wiki-bubble-menu").waitFor();
  await description.locator("p").first().hover(); await page.getByLabel(translate("wiki.blockHandle")).waitFor();
  console.log("case passed: editable Description shows the formatting bubble and drag handle");
  check(await page.getByTestId("comment-toolbar").count() === 1, "Comment toolbar is missing");
  for (const key of ["wiki.tool.bold", "wiki.tool.italic", "wiki.tool.strike", "wiki.tool.bulletList", "wiki.tool.orderedList", "wiki.tool.quote", "wiki.tool.code", "wiki.tool.link"]) await page.getByTestId("comment-toolbar").getByRole("button", { name: translate(key), exact: true }).waitFor();
  check(await page.getByTestId("comment-editor").getByRole("listbox").count() === 0 && await page.getByTestId("comment-editor").getByTestId("wiki-bubble-menu").count() === 0 && await page.getByTestId("comment-editor").getByLabel(translate("wiki.blockHandle")).count() === 0, "Comment has Wiki-only editor controls");
  console.log("case passed: Comment toolbar exposes basic format, list, quote, code, link and image controls without Wiki menus");

  const exercisePlaceholder = async (name: string, editor: typeof description) => {
    const emptyParagraph = editor.locator(":scope > p.is-empty");
    await emptyParagraph.waitFor({ state: "attached" });
    check(await emptyParagraph.getAttribute("data-placeholder") === translate("editor.placeholder"), `${name} placeholder translation is missing`);
    await emptyParagraph.click();
    await page.keyboard.type("placeholder check");
    await emptyParagraph.waitFor({ state: "detached" });
    await editor.press("Control+A");
    await editor.press("Backspace");
    await emptyParagraph.waitFor({ state: "attached" });
    check(await emptyParagraph.getAttribute("data-placeholder") === translate("editor.placeholder"), `${name} placeholder did not return after clearing`);
  };
  await exercisePlaceholder("description", description);
  await exercisePlaceholder("Comment", comment);

  for (const [name, editor] of [["description", description], ["comment", comment]] as const) {
    await editor.click();
    await page.keyboard.type("# Heading ");
    await editor.locator("h1").waitFor();
    const headingSize = await editor.locator("h1").evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    check(headingSize > 15, `${name} heading is not visibly larger than body text (${headingSize}px)`);
    await page.keyboard.press("Enter");
    await page.keyboard.type("- bullet ");
    await editor.locator("ul li").waitFor();
    check(await editor.locator("ul").evaluate((element) => getComputedStyle(element).listStyleType) === "disc", `${name} bullet list has no visible marker`);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("> quoted ");
    await editor.locator("blockquote").waitFor();
    check(await editor.locator("blockquote").evaluate((element) => parseFloat(getComputedStyle(element).borderLeftWidth)) > 0, `${name} quote has no visible rule`);
  }
  await comment.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.keyboard.type("/"); await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.tool.codeBlock"), exact: true }).click(); await page.keyboard.type("Comment code proof");
  check((await comment.locator("pre code").allInnerTexts()).some((value) => value.includes("Comment code proof")), "Comment code button did not format a code block");
  const commentImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aKQAAAAASUVORK5CYII=", "base64");
  const commentImagePicker = page.waitForEvent("filechooser");
  await page.getByTestId("comment-toolbar").last().getByRole("button", { name: translate("wiki.insert.image"), exact: true }).click();
  await (await commentImagePicker).setFiles({ name: "comment.png", mimeType: "image/png", buffer: commentImage });
  await page.getByTestId("comment-editor").locator("img[data-asset-id]").waitFor();
  const commentImageCount = () => page.getByTestId("comment-editor").locator("img[data-asset-id]").count();
  const imageCountBeforeDrop = await commentImageCount();
  const commentImageBase64 = commentImage.toString("base64");
  const dispatchImage = async (kind: "paste" | "drop", filename: string) => page.evaluate(({ kind, filename, encoded }) => {
    const target = document.querySelector<HTMLElement>('[data-testid="comment-editor"] .ProseMirror');
    if (!target) throw new Error("Comment editor is missing");
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], filename, { type: "image/png" }));
    const bounds = target.getBoundingClientRect();
    const event = kind === "paste"
      ? new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer })
      : new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.left + 8, clientY: bounds.top + 8 });
    target.dispatchEvent(event);
  }, { kind, filename, encoded: commentImageBase64 });
  await dispatchImage("paste", "pasted-comment.png");
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="comment-editor"] img[data-asset-id]').length >= count, imageCountBeforeDrop + 1);
  await dispatchImage("drop", "dropped-comment.png");
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="comment-editor"] img[data-asset-id]').length >= count, imageCountBeforeDrop + 2);
  console.log("case passed: Comment toolbar and slash menu offer Add image, and button, paste and drop upload inline images");
  await comment.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");

  for (const [name, editor] of [["description", description], ["Comment", comment]] as const) {
    await editor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter");
    await page.keyboard.type("undo-proof");
    check((await editor.innerText()).includes("undo-proof"), `${name} did not take the typed text`);
    await page.keyboard.press("Control+z");
    check(!(await editor.innerText()).includes("undo-proof"), `Ctrl+Z did not undo typing in the ${name} editor`);
    await page.keyboard.press("Control+y");
    check((await editor.innerText()).includes("undo-proof"), `Ctrl+Y did not redo typing in the ${name} editor`);
    await page.keyboard.press("Control+z");
  }
  console.log("case passed: Ctrl+Z undoes and Ctrl+Y redoes typing in the description and Comment editors");

  const exerciseSlashMenu = async (editor: typeof description) => {
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const menu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
    await menu.waitFor();
    const menuLabels = ["wiki.tool.text", "wiki.tool.h1", "wiki.tool.h2", "wiki.tool.h3", "wiki.tool.bulletList", "wiki.tool.orderedList", "wiki.tool.quote", "wiki.tool.codeBlock", "wiki.tool.divider", "wiki.insert.table", "wiki.insert.callout", "wiki.insert.emoji", "wiki.insert.todo", "wiki.insert.color", "wiki.insert.image"];
    check(await menu.getByRole("option").count() === menuLabels.length, "slash menu is missing a block command");
    for (const label of menuLabels) await menu.getByRole("option", { name: translate(label), exact: true }).waitFor();
    await page.keyboard.type("hea");
    await menu.getByRole("option", { name: translate("wiki.tool.h1"), exact: true }).waitFor();
    check(await menu.getByRole("option").count() === 3, "slash menu did not filter to headings");
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "detached" });
    check(await editor.locator("h1").count() > 0, "slash menu did not insert Heading 1");
    await page.keyboard.type("/");
    await menu.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    check((await editor.innerText()).includes("/"), "Escape should close the slash menu and keep the typed slash");
  };
  await exerciseSlashMenu(description);

  const checkLink = async (root: typeof description, text: string, href: string, open = false) => {
    const link = root.getByRole("link", { name: text, exact: true });
    await link.waitFor();
    check(new URL(await link.getAttribute("href") ?? "", web).href === new URL(href, web).href, `link ${text} has the wrong href`);
    check(await link.getAttribute("target") === "_blank", `link ${text} does not target a new tab`);
    check((await link.getAttribute("rel") ?? "").split(/\s+/).includes("noopener") && (await link.getAttribute("rel") ?? "").split(/\s+/).includes("noreferrer"), `link ${text} is missing noopener noreferrer`);
    const style = await link.evaluate((element) => {
      const reference = document.createElement("span"); reference.style.color = "var(--txt-link-primary)"; document.body.append(reference);
      const expectedColor = getComputedStyle(reference).color; reference.remove();
      return { color: getComputedStyle(element).color, expectedColor, decoration: getComputedStyle(element).textDecorationLine };
    });
    check(style.color === style.expectedColor && style.decoration.includes("underline"), `link ${text} is not visibly styled (${style.color} vs ${style.expectedColor}, ${style.decoration})`);
    if (open) {
      const popup = page.waitForEvent("popup");
      await link.click();
      const opened = await popup;
      await opened.waitForURL(new URL(href, web).href);
      check(opened.url() === new URL(href, web).href, `click on ${text} opened ${opened.url()} instead of ${href}`);
      check(await opened.evaluate(() => window.opener) === null, `click on ${text} opened a tab with an opener`);
      await opened.close();
    }
  };

  await comment.click();
  await page.keyboard.type("[Comment Markdown](https://comment.example)");
  await checkLink(comment, "Comment Markdown", "https://comment.example/");
  await description.click();
  await page.keyboard.press("Control+End");
  await page.evaluate(() => navigator.clipboard.writeText("https://example.com"));
  await page.keyboard.press("Control+V");
  await checkLink(description, "https://example.com", "https://example.com/", true);
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("https://example.org ");
  await checkLink(description, "https://example.org", "https://example.org/");
  await page.keyboard.type("[Markdown](https://example.net)");
  await checkLink(description, "Markdown", "https://example.net/");
  await page.keyboard.press("Enter");
  await page.evaluate(() => navigator.clipboard.writeText("[Pasted Markdown](https://example.dev)"));
  await page.keyboard.press("Control+V");
  await checkLink(description, "Pasted Markdown", "https://example.dev/");
  await page.keyboard.press("Enter");
  await page.keyboard.type("https://example.info");
  await page.keyboard.press("Enter");
  await checkLink(description, "https://example.info", "https://example.info/");
  await page.keyboard.press("Enter");
  await page.keyboard.type("named text");
  await page.keyboard.press("Shift+Home");
  await page.evaluate(() => navigator.clipboard.writeText("https://example.co"));
  await page.keyboard.press("Control+V");
  await checkLink(description, "named text", "https://example.co/");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[unsafe](javascript:alert(1)) ");
  check(await description.locator('a[href^="javascript:"]').count() === 0, "javascript URL became a clickable link");
  const readOnlyComment = page.locator("li[id^='comment-'] .ProseMirror").first();
  await checkLink(readOnlyComment, "Read only link", "https://example.edu/", true);
  check(await readOnlyComment.locator("[aria-label='Table controls']").count() === 0, "read-only Comment shows table controls");
  const readonlyText = await readOnlyComment.innerText();
  check(await readOnlyComment.locator("ul").count() > 0 && await readOnlyComment.locator("blockquote").count() > 0 && await readOnlyComment.locator("pre code").count() === 2 && readonlyText.includes("Read only list") && readonlyText.includes("Read only quote"), "read-only Comment did not render all rich supported nodes");
  const commentDiff = readOnlyComment.locator("pre code").filter({ hasText: "removed example" });
  check(await commentDiff.locator(".hljs-deletion").count() === 1 && await commentDiff.locator(".hljs-addition").count() === 1, "Comment diff lines were not distinguished by addition and deletion styles");
  await captureDiffThemes("comment", "li[id^='comment-'] .ProseMirror pre");
  const commentTable = readOnlyComment.locator("table");
  const commentTableStyle = await commentTable.locator("th").first().evaluate((el) => getComputedStyle(el).borderTopWidth);
  const commentTableMargin = await commentTable.evaluate((el) => Number.parseFloat(getComputedStyle(el).marginBlockEnd));
  const commentOverflow = await readOnlyComment.evaluate((el) => getComputedStyle(el.closest(".comment-body")!).overflowX);
  const headingSize = await readOnlyComment.locator("h2").evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  const listMarker = await readOnlyComment.locator("ul").evaluate((el) => getComputedStyle(el).listStyleType);
  check(await commentTable.count() === 1 && commentTableStyle !== "0px" && commentTableMargin >= 10 && commentOverflow === "auto" && headingSize > 16 && listMarker === "disc", `read-only Comment table margin, heading, or list styles are missing (count=${await commentTable.count()}, border=${commentTableStyle}, margin=${commentTableMargin}px, overflow=${commentOverflow}, heading=${headingSize}px, list=${listMarker})`);
  if (Bun.env.E2E_SCREENSHOT_PATH) await page.screenshot({ path: Bun.env.E2E_SCREENSHOT_PATH, fullPage: true });
  console.log("case passed: read-only Comment renders and styles every rich supported node, including tables");

  // Work item descriptions gain table insertion and the same contextual actions.
  await description.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const descriptionMenu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await descriptionMenu.getByRole("option", { name: translate("wiki.insert.table"), exact: true }).click();
  const descriptionTable = description.locator("table").last();
  await descriptionTable.waitFor();
  await descriptionTable.locator("td, th").first().click();
  check(await page.locator(`[aria-label="${translate("table.controls")}"]`).count() === 0, "description table still shows the text-button bar");
  await page.locator('[data-table-grip="row-0"]').click();
  await page.getByRole("menuitem", { name: translate("table.insertRowBelow"), exact: true }).click();
  check(await descriptionTable.locator("tr").count() === 4, "description table controls did not insert a row");


  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  const wikiDiff = wikiEditor.locator("pre code").filter({ hasText: "removed from Wiki" });
  await wikiDiff.waitFor();
  check(await wikiDiff.locator(".hljs-deletion").count() === 1 && await wikiDiff.locator(".hljs-addition").count() === 1, "Wiki diff lines were not distinguished by addition and deletion styles");
  await captureDiffThemes("wiki", "[data-testid='wiki-editor'] pre");
  if (Bun.env.E2E_DIFF_CAPTURE_ONLY === "true") throw "DIFF_CAPTURE_COMPLETE";
  await wikiEditor.waitFor();
  await wikiEditor.getByText("Converter formatting", { exact: false }).waitFor({ timeout: 15000 });
  check(await wikiEditor.locator("u").filter({ hasText: "underline" }).count() === 1 && await wikiEditor.locator("sub").filter({ hasText: "sub" }).count() === 1 && await wikiEditor.locator("sup").filter({ hasText: "super" }).count() === 1 && await wikiEditor.locator('span[style*="purple"]').count() === 1, `Wiki page did not render the converter's inline marks: ${await wikiEditor.innerHTML()}`);
  await captureTicketScreen("wiki-page");
  await roundTripSource("wiki-page", "[data-testid='wiki-editor']", "Wiki table");
  await page.goto(`${web}/${slug}/wiki/${projectPageCreated.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Project page colour").waitFor({ timeout: 15000 });
  await roundTripSource("page", "[data-testid='wiki-editor']", "Project page table");
  const capturePublication = await call<{ token: string }>("publish_wiki_page", { pageId: wiki.id });
  await page.goto(`${web}/p/${capturePublication.token}`);
  const capturePublishedPage = page.getByTestId("published-wiki-page").locator(".ProseMirror");
  await capturePublishedPage.getByText("Converter formatting", { exact: false }).waitFor({ timeout: 15000 });
  await captureTicketScreen("published-wiki");
  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Converter formatting", { exact: false }).waitFor({ timeout: 15000 });
  // No fixed toolbar: the selection bubble carries the marks, and its controls keep names and tooltips.
  check(await page.getByRole("toolbar", { name: translate("wiki.toolbar") }).count() === 0, "Wiki page must not show the fixed formatting toolbar");
  const wikiBubble = page.getByTestId("wiki-bubble-menu");
  await wikiEditor.getByText("Converter formatting", { exact: false }).click();
  await page.keyboard.press("Control+a");
  await wikiBubble.waitFor();
  for (const key of ["wiki.tool.bold", "wiki.tool.italic", "wiki.tool.strike", "wiki.tool.code"]) {
    const label = translate(key as never), button = wikiBubble.getByRole("button", { name: label, exact: true });
    check(await button.getAttribute("aria-label") === label && (await button.getAttribute("title"))?.startsWith(label) === true, `Page/Wiki ${label} bubble control needs a tooltip and accessible name`);
    await button.hover();
  }
  check(await wikiBubble.getByRole("combobox", { name: translate("wiki.tool.blockType"), exact: true }).count() === 1, "Selection bubble has no block type select for lists and quote");
  await wikiEditor.click();
  await page.keyboard.press("Control+End");
  if (Bun.env.E2E_SCREENSHOT_DIR) {
    mkdirSync(Bun.env.E2E_SCREENSHOT_DIR, { recursive: true });
    for (const [theme, width, height] of [["light", 1440, 900], ["dark", 1440, 900], ["light", 768, 900], ["dark", 768, 900], ["light", 390, 844], ["dark", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: `${Bun.env.E2E_SCREENSHOT_DIR}/wiki-editor-${theme}-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  }
  await wikiEditor.getByText("Read only link").waitFor();
  await wikiEditor.getByText("Read only link").click();
  await page.getByTestId("wiki-bubble-menu").waitFor({ state: "hidden" });
  await exercisePlaceholder("Wiki", wikiEditor);
  await wikiEditor.click(); await page.keyboard.press("Control+End");
  await page.evaluate(() => navigator.clipboard.writeText("[Read only link](https://example.edu)")); await page.keyboard.press("Control+V");
  await checkLink(wikiEditor, "Read only link", "https://example.edu/");
  // The Wiki editor uses the shared SlashMenu with a longer command list (covered by wiki-pages.e2e.ts).
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter");
  await page.keyboard.type("# Heading ");
  await wikiEditor.locator("h1").waitFor();
  check(await wikiEditor.locator("h1").evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) > 15, "Wiki heading styling is missing");
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  const wikiSlashMenu = page.getByRole("listbox", { name: translate("editor.slashMenu") });
  await wikiSlashMenu.getByRole("option", { name: translate("wiki.insert.color"), exact: true }).click();
  await page.keyboard.type("Slash palette colour");
  check(await wikiEditor.locator('span[style*="color: rgb(59, 130, 246)"]').filter({ hasText: "Slash palette colour" }).count() === 1, "slash colour command did not use the shared palette");
  await wikiEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[Wiki Markdown](https://wiki.example)");
  await checkLink(wikiEditor, "Wiki Markdown", "https://wiki.example/");

  // Emoji slash picker and typed emoji suggestion each insert a chosen emoji.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.emoji"), exact: true }).click();
  const emojiPicker = page.getByRole("dialog", { name: translate("wiki.insert.emoji") }); await emojiPicker.waitFor();
  await emojiPicker.getByRole("button", { name: `${translate("wiki.insert.emoji")} 🚀` }).click();
  check(await wikiEditor.getByText("🚀", { exact: true }).count() > 0, "slash emoji picker did not insert the chosen emoji");
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type(":rocket");
  const emojiSuggestions = page.getByRole("listbox").filter({ has: page.getByRole("option", { name: "🚀" }) });
  await emojiSuggestions.waitFor(); await page.keyboard.press("Enter");
  check(await wikiEditor.getByText("🚀", { exact: true }).count() === 2, "typed emoji suggestion did not insert the matching emoji");
  console.log("case passed: emoji picker and typed emoji suggestion insert selected emoji");

  // Typography input rules preserve an undo step, and list keys nest/lift the active item.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("ratio 1/2 ");
  check(await wikiEditor.getByText("ratio ½", { exact: true }).count() === 1, "typography input rule did not convert 1/2 to ½");
  await page.keyboard.press("Control+z");
  check(await wikiEditor.getByText("ratio 1/2", { exact: true }).count() === 1, "typography conversion could not be undone");
  for (const [input, output] of [["->", "→"], ["...", "…"], ["(c)", "©"], ["(tm)", "™"], ["(r)", "®"]] as const) {
    await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type(`rule ${input} `);
    check(await wikiEditor.getByText(`rule ${output}`, { exact: true }).count() === 1, `typography input rule did not convert ${input}`);
    await page.keyboard.press("Control+z");
    check(await wikiEditor.getByText(`rule ${input}`, { exact: true }).count() === 1, `typography conversion ${input} could not be undone`);
  }
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.tool.bulletList"), exact: true }).click();
  await page.keyboard.type("parent"); await page.keyboard.press("Enter"); await page.keyboard.type("child");
  await page.keyboard.press("Tab");
  const nestedList = wikiEditor.locator("ul ul").last(); await nestedList.waitFor();
  check(await nestedList.getByText("child", { exact: true }).count() === 1, "Tab did not indent the list item");
  await page.keyboard.press("Shift+Tab");
  check(await wikiEditor.locator("ul ul").count() === 0, "Shift-Tab did not outdent the list item");
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  console.log("case passed: typography conversion is undoable and Tab/Shift-Tab indent/outdent lists");

  // Markdown pasted as plain text is parsed into real block nodes.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.evaluate(() => navigator.clipboard.writeText("## Pasted markdown\n\n- first item\n- second item"));
  await page.keyboard.press("Control+V");
  await wikiEditor.locator("h2").filter({ hasText: "Pasted markdown" }).waitFor();
  await wikiEditor.getByText("second item", { exact: true }).waitFor();
  await exitList();
  console.log("case passed: Markdown paste creates formatted heading and list blocks");

  // Code blocks are highlighted and expose a copy control; callout attributes can be selected from the palette.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await exitList(); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.tool.codeBlock"), exact: true }).click();
  const codeBlock = wikiEditor.locator("pre").last(); await codeBlock.waitFor();
  await codeBlock.click({ position: { x: 20, y: 18 } });
  await codeLanguage.waitFor();
  await page.keyboard.press("Shift+Tab");
  check(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === translate("editor.codeLanguage"), "Code language control is not reachable by keyboard or labelled");
  await wikiEditor.locator("p").first().click();
  await codeLanguage.waitFor({ state: "detached" });
  console.log("case passed: Code language appears only in an active code block");
  await codeBlock.click({ position: { x: 20, y: 18 } });
  await page.keyboard.type("const answer = 42");
  check((await codeBlock.locator("code").innerText()).includes("const answer = 42"), "typing did not preserve code text in the code block");
  await codeBlock.locator("code .hljs-keyword").first().waitFor({ timeout: 5_000 }).catch(() => undefined); // the highlight arrives after the typed text; the check below reports if it never does
  check(await codeBlock.locator("code .hljs-keyword").count() > 0, "code block did not syntax-highlight its JavaScript keyword");
  const copyCode = codeBlock.getByRole("button", { name: translate("editor.copyCode") }); await copyCode.click();
  check(await page.evaluate(() => navigator.clipboard.readText()) === "const answer = 42", "code copy button did not copy the block text");
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.tool.codeBlock"), exact: true }).click();
  const pythonBlock = wikiEditor.locator("pre").last(); await pythonBlock.waitFor();
  await page.getByRole("combobox", { name: translate("editor.codeLanguage") }).selectOption("python");
  await pythonBlock.click({ position: { x: 20, y: 18 } }); await page.keyboard.type("def answer():");
  await pythonBlock.locator("code .hljs-keyword").waitFor();
  console.log("case passed: code block highlights a common language and its copy button copies text");

  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.callout"), exact: true }).click();
  const callout = wikiEditor.locator("aside[data-callout]").last(); await callout.locator("p").click(); await page.keyboard.type("Callout proof");
  await page.getByRole("button", { name: translate("callout.options") }).click();
  await page.getByRole("button", { name: `${translate("callout.color")} #f97316` }).click();
  await page.getByRole("button", { name: `${translate("callout.icon")} 🚀` }).click();
  await page.getByRole("button", { name: translate("callout.done"), exact: true }).click();
  check(await callout.getAttribute("data-color") === "#f97316" && await callout.getAttribute("data-icon") === "🚀", "callout colour and icon controls did not update attributes");
  console.log("case passed: callout colour and icon controls update attributes");

  // Bubble menu formatting is visible on a non-empty Wiki selection and keeps the selection while its controls are used.
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("Palette proof"); await page.keyboard.press("Shift+Home");
  const bubble = page.getByTestId("wiki-bubble-menu"); await bubble.waitFor();
  const assistToolbar = page.getByRole("toolbar", { name: translate("assist.menu") }); await assistToolbar.waitFor();
  const boxes = await Promise.all([bubble.boundingBox(), assistToolbar.boundingBox()]);
  check(!!boxes[0] && !!boxes[1] && (boxes[0]!.x + boxes[0]!.width <= boxes[1]!.x || boxes[1]!.x + boxes[1]!.width <= boxes[0]!.x || boxes[0]!.y + boxes[0]!.height <= boxes[1]!.y || boxes[1]!.y + boxes[1]!.height <= boxes[0]!.y), "AI assist menu overlaps the formatting bubble menu");
  await bubble.getByRole("button", { name: translate("wiki.tool.underline") }).click();
  await bubble.getByRole("button", { name: translate("wiki.tool.colors"), exact: true }).click();
  await page.getByRole("group", { name: translate("wiki.tool.colors"), exact: true }).getByRole("button", { name: `${translate("wiki.insert.color")} ${translate("wiki.color.blue")}`, exact: true }).click();
  await page.getByRole("group", { name: translate("wiki.tool.colors"), exact: true }).getByRole("button", { name: `${translate("wiki.highlight")} ${translate("wiki.color.yellow")}`, exact: true }).click();
  await bubble.getByRole("button", { name: translate("wiki.tool.link"), exact: true }).click();
  await page.getByRole("group", { name: translate("wiki.tool.link"), exact: true }).getByLabel(translate("wiki.linkUrl")).fill("https://palette.example");
  await page.getByRole("group", { name: translate("wiki.tool.link"), exact: true }).getByRole("button", { name: translate("wiki.linkSave") }).click();
  check(await wikiEditor.locator('a[href="https://palette.example"]').count() === 1, "bubble link did not apply to the selected text");
  check(await bubble.getByRole("button", { name: translate("wiki.align.right") }).count() === 0, "Wiki editor still exposes text alignment controls");
  await wikiEditor.getByText("Palette proof", { exact: true }).click({ clickCount: 3 });
  await bubble.waitFor();
  await bubble.getByRole("combobox", { name: translate("wiki.tool.blockType") }).selectOption("h2");
  await page.keyboard.press("ArrowRight");
  const paletteText = wikiEditor.getByText("Palette proof"); await paletteText.waitFor();
  check(await wikiEditor.locator("h2").filter({ hasText: "Palette proof" }).count() === 1, "bubble node selector did not convert the selected block");
  check(await wikiEditor.locator('a[href="https://palette.example"]').count() === 1 && await wikiEditor.locator("u").filter({ hasText: "Palette proof" }).count() === 1, "bubble link or underline did not apply");
  check(await wikiEditor.locator('span[style*="color: rgb(59, 130, 246)"]').filter({ hasText: "Palette proof" }).count() === 1, "bubble text colour did not apply");
  check(await wikiEditor.locator('mark[style*="background-color: rgb(234, 179, 8)"]').filter({ hasText: "Palette proof" }).count() === 1, "bubble highlight did not apply");
  await wikiEditor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("Source mode proof paragraph");
  // Every table control is exercised through the grips, their menus and the `+` buttons, and checked against the resulting document.
  await wikiEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.table"), exact: true }).click();
  const table = wikiEditor.locator("table").last();
  await table.waitFor();
  check(await page.locator(`[aria-label="${translate("table.controls")}"]`).count() === 0, "the text-button bar above the table is still shown");
  const cellAt = (row: number, column: number) => table.locator("tr").nth(row).locator("td, th").nth(column);
  const grip = (id: string) => page.locator(`[data-table-grip="${id}"]`);
  const menuItem = (key: string) => page.getByRole("menuitem", { name: translate(key as never), exact: true });
  /** Puts the caret in the cell that holds the axis, so its grip shows, then runs one menu item. */
  const pick = async (axis: "row" | "column" | "table", index: number, key: string) => {
    await cellAt(axis === "column" ? 0 : index, axis === "row" ? 0 : index).click();
    const id = axis === "table" ? "table" : `${axis}-${index}`;
    await grip(id).click();
    await menuItem(key).click();
  };
  // Optional evidence: a dark-theme screenshot of the table with its grips and `+` buttons, saved when TABLE_CONTROLS_SHOT names a file.
  if (Bun.env.TABLE_CONTROLS_SHOT) {
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await cellAt(1, 1).click();
    const shotBox = await table.boundingBox();
    if (shotBox) await page.screenshot({ path: Bun.env.TABLE_CONTROLS_SHOT, clip: { x: Math.max(0, shotBox.x - 60), y: Math.max(0, shotBox.y - 60), width: shotBox.width + 120, height: shotBox.height + 120 } });
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    await cellAt(0, 0).click();
  }
  await cellAt(0, 0).click();
  check(await page.getByLabel(translate("table.cellColor"), { exact: true }).count() === 0, "Wiki table still exposes cell background colour controls");
  check(await grip("column-0").count() === 1 && await grip("row-0").count() === 1 && await grip("table").count() === 1, "grips did not appear for the caret's row, column and table");
  check(await page.locator('[data-table-add="column"]').getAttribute("title") === translate("table.addColumn"), "right-edge + has the wrong tooltip");
  check(await page.locator('[data-table-add="row"]').getAttribute("title") === translate("table.addRow"), "bottom-edge + has the wrong tooltip");
  const columnGrip = await grip("column-0").boundingBox(), columnCell = await cellAt(0, 0).boundingBox();
  check(!!columnGrip && !!columnCell && Math.abs(columnGrip.x + columnGrip.width / 2 - (columnCell.x + columnCell.width / 2)) < 2, "column grip is not centred over its column");
  await pick("row", 0, "table.insertRowAbove"); check(await table.locator("tr").count() === 4, "insert row above failed");
  await pick("row", 1, "table.insertRowBelow"); check(await table.locator("tr").count() === 5, "insert row below failed");
  await cellAt(1, 0).click();
  await page.keyboard.type("duplicate-me");
  await pick("row", 1, "table.duplicateRow");
  check((await table.innerText()).includes("duplicate-me"), "duplicate row lost source content");
  check(await table.locator("tr").count() === 6, "duplicate row failed");
  await pick("row", 1, "table.clearRow");
  check((await table.locator("tr").allInnerTexts()).filter((text) => text.includes("duplicate-me")).length === 1, `clear row should leave only the duplicated row: ${JSON.stringify(await table.locator("tr").allInnerTexts())}`);
  await pick("row", 1, "table.deleteRow"); check(await table.locator("tr").count() === 5, "delete row failed");
  await pick("column", 0, "table.insertColumnLeft"); check(await table.locator("tr").first().locator("th, td").count() === 4, "insert column left failed");
  await pick("column", 0, "table.insertColumnRight"); check(await table.locator("tr").first().locator("th, td").count() === 5, "insert column right failed");
  await cellAt(0, 1).click();
  await page.keyboard.type("column-copy");
  await pick("column", 1, "table.duplicateColumn");
  check((await table.innerText()).includes("column-copy"), `duplicate column lost source content: ${JSON.stringify(await table.locator("tr").allInnerTexts())}`);
  check(await table.locator("tr").first().locator("th, td").count() === 6, "duplicate column failed");
  await pick("column", 1, "table.clearColumn");
  check((await table.locator("tr").allInnerTexts()).filter((text) => text.includes("column-copy")).length === 1, "clear column should leave only the duplicated column");
  await pick("column", 1, "table.deleteColumn"); check(await table.locator("tr").first().locator("th, td").count() === 5, "delete column failed");
  const headerCellsBefore = await table.locator("tr").first().locator("th").count();
  await pick("row", 0, "table.toggleHeaderRow");
  const headerCellsAfter = await table.locator("tr").first().locator("th").count();
  check(headerCellsAfter !== headerCellsBefore, "header row toggle did not change its state");
  await pick("row", 0, "table.toggleHeaderRow"); check(await table.locator("tr").first().locator("th").count() === headerCellsBefore, "header row toggle did not restore its state");
  const headerColumnBefore = await table.locator("th").count();
  await pick("column", 0, "table.toggleHeaderColumn"); check(await table.locator("th").count() !== headerColumnBefore, "header column toggle did not change its state");
  await pick("column", 0, "table.toggleHeaderColumn");
  const headerColumnRestored = await table.locator("th").count();
  check(headerColumnRestored === headerColumnBefore, `header column toggle did not restore its state (${headerColumnBefore} -> ${headerColumnRestored})`);
  // The `+` buttons add a column at the right edge and a row at the bottom edge.
  await cellAt(0, 0).click();
  const columnsBeforeAdd = await table.locator("tr").first().locator("th, td").count();
  await page.locator('[data-table-add="column"]').click();
  check(await table.locator("tr").first().locator("th, td").count() === columnsBeforeAdd + 1, "right-edge + did not add a column at the end");
  const rowsBeforeAdd = await table.locator("tr").count();
  await page.locator('[data-table-add="row"]').click();
  check(await table.locator("tr").count() === rowsBeforeAdd + 1, "bottom-edge + did not add a row at the end");
  const rowCountBeforeTab = await table.locator("tr").count();
  const lastCell = table.locator("tr").last().locator("td, th").last().locator("p");
  await lastCell.click();
  check(await wikiEditor.evaluate((element) => document.activeElement === element), "Tab test did not focus the Wiki editor");
  check(await page.evaluate(() => !!window.getSelection()?.anchorNode?.parentElement?.closest("td, th")), "Tab test caret is not inside a table cell");
  await page.keyboard.press("Tab"); check(await table.locator("tr").count() === rowCountBeforeTab + 1, "Tab in last cell did not append a row");
  const activeCellIndex = () => page.evaluate(() => {
    const cell = window.getSelection()?.anchorNode?.parentElement?.closest("td, th");
    if (!cell) return -1;
    return Array.from(cell.closest("table")!.querySelectorAll("td, th")).indexOf(cell);
  });
  const cellBeforeShiftTab = await activeCellIndex();
  await page.keyboard.press("Shift+Tab");
  check(await table.locator("tr").count() === rowCountBeforeTab + 1, "Shift-Tab changed the table structure");
  check(await activeCellIndex() === cellBeforeShiftTab - 1, "Shift-Tab did not move to the previous cell");
  // Escape from a cell moves focus to the table grip; Tab then reaches the `+` buttons and Escape returns to the cell.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-table-grip") === "table", undefined, { timeout: 5_000 }).catch(() => { throw new Error("Escape from a cell did not focus the table grip"); });
  await page.keyboard.press("Escape");
  await pick("table", 0, "table.deleteTable"); check(await wikiEditor.locator("table").count() === 0, "delete table left the table in the document");

  // Keep a table in the document for the read-only and published rendering checks.
  await wikiEditor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.table"), exact: true }).click();
  await wikiEditor.locator("table").waitFor();
  const savedTable = wikiEditor.locator("table").last();
  await savedTable.locator("th, td").first().click();

  // A collaborator in a second tab deletes the row that this tab's row menu is open on: the menu closes and nothing breaks.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const collaborator = await context.newPage();
  await collaborator.goto(`${web}/${slug}/wiki/${wiki.id}`);
  await collaborator.bringToFront();
  const remoteTable = collaborator.getByTestId("wiki-editor").locator(".ProseMirror table").last();
  await remoteTable.waitFor();
  // Marker text makes the row the collaborator deletes unique: identical empty rows could be removed at another index.
  await savedTable.locator("tr").nth(1).locator("td, th").first().click();
  await page.keyboard.type("row-unique");
  await remoteTable.locator("tr").nth(1).locator("td, th").first().filter({ hasText: "row-unique" }).waitFor();
  await page.locator('[data-table-grip="row-1"]').click();
  const rowMenu = page.getByRole("menu", { name: translate("table.rowMenu") });
  await rowMenu.waitFor();
  await remoteTable.locator("tr").nth(1).locator("td, th").first().click();
  await collaborator.locator('[data-table-grip="row-1"]').click();
  await collaborator.getByRole("menuitem", { name: translate("table.deleteRow"), exact: true }).click();
  await rowMenu.waitFor({ state: "detached", timeout: 10_000 });
  check(await savedTable.locator("tr").count() === 2, "a collaborator's row delete did not reach this tab");
  // Column variant: this tab opens a column menu, and a second collaborator deletes that column through its own grip menu.
  await savedTable.locator("tr").first().locator("td, th").nth(1).click();
  await page.keyboard.type("col-unique");
  await remoteTable.locator("tr").first().locator("td, th").nth(1).filter({ hasText: "col-unique" }).waitFor();
  await page.locator('[data-table-grip="column-1"]').click();
  const columnMenu = page.getByRole("menu", { name: translate("table.columnMenu") });
  await columnMenu.waitFor();
  await remoteTable.locator("tr").first().locator("td, th").nth(1).click();
  await collaborator.locator('[data-table-grip="column-1"]').click();
  await collaborator.getByRole("menuitem", { name: translate("table.deleteColumn"), exact: true }).click();
  await columnMenu.waitFor({ state: "detached", timeout: 10_000 });
  check(await savedTable.locator("tr").first().locator("td, th").count() === 2, "a collaborator's column delete did not reach this tab");
  check(pageErrors.length === 0, `collaborator column delete raised page errors: ${pageErrors.join("; ")}`);
  await collaborator.close();
  await savedTable.locator("tr").nth(1).locator("td, th").first().click();

  await savedTable.locator("tr").nth(1).locator("td, th").first().click();

  await page.waitForTimeout(2_000); // kept: the body reaches the server over the live socket (Y.js, debounced), with no response to wait on
  await page.getByText(translate("wiki.saved")).waitFor({ timeout: 10_000 });
  await page.reload();
  await page.getByTestId("wiki-editor").locator('h2:has-text("Palette proof")').waitFor();
  const persistedWiki = page.getByTestId("wiki-editor").locator(".ProseMirror");
  check(await persistedWiki.locator('a[href="https://palette.example"] u').count() === 1, "bubble formatting did not persist after reload");
  check(await persistedWiki.locator('mark[style*="background-color: rgb(234, 179, 8)"]').filter({ hasText: "Palette proof" }).count() === 1, "highlight did not persist after reload");
  check(await persistedWiki.locator("p").filter({ hasText: "Source mode proof paragraph" }).count() === 1, "plain paragraphs did not persist after reload");
  check(await persistedWiki.locator("table th, table td").first().getAttribute("data-background-color") === null, "table cell background colour persisted in the editor");
  check(await persistedWiki.locator("pre code span[class]").count() > 0, "highlighted code did not persist in the Wiki editor");
  check(await persistedWiki.locator("aside[data-callout]").last().getAttribute("data-color") === "#f97316" && await persistedWiki.locator("aside[data-callout]").last().getAttribute("data-icon") === "🚀", "callout colour and icon did not persist after reload");
  console.log("case passed: highlighted code and callout colour/icon persist after reload");
  await persistedWiki.locator("table th, table td").first().click();

  await call("lock_wiki_page", { pageId: wiki.id });
  await page.getByTestId("wiki-page-locked").waitFor();
  await page.getByTestId("wiki-editor").locator(".ProseMirror[contenteditable=false]").waitFor();
  check(await page.getByTestId("wiki-editor").locator("table").count() === 1, "read-only Wiki did not render its table");
  // A real selection and real typing on the locked page: no bubble menu, and the typed text never lands in the editor or the stored page.
  await page.getByTestId("wiki-editor").locator("p").filter({ hasText: "Source mode proof paragraph" }).first().click({ clickCount: 3 });
  await page.waitForTimeout(300); // kept: a negative check; the bubble menu that must not appear has no element to wait on
  check(await page.getByTestId("wiki-bubble-menu").count() === 0, "read-only Wiki shows the formatting bubble menu for a real selection");
  await page.keyboard.type("typed-after-lock");
  await page.waitForTimeout(1_500); // kept: a negative check; the stored text must stay absent, so there is no element to wait for
  check(!(await page.getByTestId("wiki-editor").innerText()).includes("typed-after-lock"), "text typed after the lock appeared in the editor");
  check(!JSON.stringify(await call("get_wiki_page", { pageId: wiki.id })).includes("typed-after-lock"), "text typed after the lock was stored");
  check(await page.getByTestId("wiki-editor").locator(`[aria-label="${translate("table.controls")}" ]`).count() === 0, "read-only Wiki shows table controls");
  const published = await call<{ token: string }>("publish_wiki_page", { pageId: wiki.id });
  await page.goto(`${web}/p/${published.token}`);
  const publishedPage = page.getByTestId("published-wiki-page").locator(".ProseMirror");
  await publishedPage.locator("table").waitFor({ timeout: 15000 });
  await checkLink(publishedPage, "Read only link", "https://example.edu/", true);
  check(await publishedPage.locator("table").count() === 1, "published Wiki did not render its table");
  check(await publishedPage.locator('a[href="https://palette.example"] u').count() === 1, "published Wiki did not render the formatted inline link and underline");
  check(await publishedPage.locator('mark[style*="background-color: rgb(234, 179, 8)"]').filter({ hasText: "Palette proof" }).count() === 1, "published Wiki did not render highlight colour");
  check((await publishedPage.locator("h2").filter({ hasText: "Palette proof" }).getAttribute("style"))?.includes("text-align:") !== true, "published Wiki rendered unsupported text alignment");
  check(await publishedPage.locator("table th, table td").first().getAttribute("data-background-color") === null, "published Wiki rendered unsupported table cell background colour");
  check(await publishedPage.locator("pre code span[class]").count() > 0, "published Wiki did not render highlighted code");
  check(await publishedPage.locator("aside[data-callout]").last().getAttribute("data-color") === "#f97316", "published Wiki did not render coloured callouts");
  check(await publishedPage.locator("aside[data-callout] [data-callout-icon]").last().innerText() === "🚀", "published Wiki did not render the callout icon");
  check(await publishedPage.locator("[aria-label='Table controls']").count() === 0, "published Wiki shows table controls");
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  await page.getByTestId("description-editor").waitFor();
  await call("update_work_item", { workItemId: workItem.id, descriptionMarkdown: "Current description for history and restore proof" });
  await page.reload();
  await page.getByTestId("description-editor").waitFor();
  {
    const { db: seedDb, client: seedClient } = createDatabase();
    await seedDb.insert(workItemDescriptionVersions).values({ workItemId: workItem.id, contentMarkdown: "Earlier saved description", contentText: "Earlier saved description", createdBy: me.user.id });
    await seedClient.end();
  }
  const captureDescriptionHistory = async (lang: "en" | "th") => {
    const directory = Bun.env.E2E_RTM_CAPTURE_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({ path: `${directory}/04-description-history-restore-${width}-${lang}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  await page.getByTestId("description-last-edited").click();
  await page.getByRole("dialog", { name: translate("workItems.descriptionVersions") }).waitFor();
  await captureDescriptionHistory("en");
  await page.getByRole("dialog").getByRole("button", { name: translate("workItems.close") }).click();
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: "ไทย" }).click();
  await page.getByTestId("description-last-edited").click();
  await page.getByRole("dialog", { name: "ประวัติรายละเอียด" }).waitFor();
  check(!/\b(?:seconds?|minutes?|hours?|days?) ago\b/i.test(await page.getByRole("dialog").innerText()), "Thai description history still shows English relative-time text");
  await captureDescriptionHistory("th");
  await page.getByRole("dialog").getByRole("button", { name: "กู้คืน", exact: true }).first().click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const restoredDescription = await call<{ descriptionMarkdown: string }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: "MOB-1" });
  check(restoredDescription.descriptionMarkdown === "Earlier saved description", "restoring the saved description did not update the Written form");
  // A long history shows 20 versions; "Show older versions" follows the cursor and the control is a real, named button.
  const history = await call<{ id: string }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: "MOB-1" });
  // Versions are only written every few minutes, so a long history is seeded directly.
  const { SQL } = await import("bun");
  const database = new SQL(process.env.DATABASE_URL!);
  await database.unsafe(`insert into work_item_description_versions (work_item_id, content_markdown, content_text, created_by, created_at)
    select '${history.id}', 'History entry ' || n, 'History entry ' || n, (select created_by from work_items where id = '${history.id}'), now() - (n || ' hours')::interval from generate_series(1, 24) as n`);
  await database.close();
  await page.getByTestId("description-last-edited").click();
  const historyDialog = page.getByRole("dialog", { name: "ประวัติรายละเอียด" });
  await historyDialog.waitFor();
  const firstPage = await historyDialog.locator("li").count();
  check(firstPage === 20, `the description history showed ${firstPage} versions first, not 20`);
  const older = historyDialog.getByRole("button", { name: "แสดงเวอร์ชันที่เก่ากว่า" });
  check(await older.count() === 1, "the description history has no accessible Show older versions button");
  // A failed request keeps the button, says so, and Try again works.
  await page.route("**/actions/list_work_item_description_versions", (route) => route.request().postData()?.includes('"after"') ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "forced failure" }) }) : route.continue(), { times: 1 });
  await older.click();
  await historyDialog.getByTestId("older-versions-error").waitFor();
  check((await historyDialog.getByTestId("older-versions-error").innerText()).includes("โหลดเวอร์ชันที่เก่ากว่าไม่ได้"), "a failed Show older versions shows no Thai error message");
  check(await historyDialog.locator("li").count() === 20, "a failed Show older versions changed the list");
  const retry = historyDialog.getByRole("button", { name: "ลองอีกครั้ง" });
  check(await retry.count() === 1, "a failed Show older versions has no Try again button");
  await retry.click();
  await historyDialog.locator("li").nth(20).waitFor();
  check(await historyDialog.locator("li").count() > 20, "Show older versions did not add older versions");
  check(await historyDialog.getByTestId("show-older-versions").count() === 0, "Show older versions stays after the last page");
  await historyDialog.getByRole("button", { name: "ปิด" }).click();
  await historyDialog.waitFor({ state: "detached" });
  // A first page that fails to load is an error with a retry, not "no versions".
  await page.route("**/actions/list_work_item_description_versions", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "forced failure" }) }), { times: 1 });
  await page.getByTestId("description-last-edited").click();
  await historyDialog.getByTestId("older-versions-error").waitFor();
  check(await historyDialog.getByText("ไม่มีเวอร์ชันก่อนหน้า").count() === 0 && await historyDialog.getByTestId("retry-versions").count() === 1, "a failed first page of the description history shows no error with a retry");
  await historyDialog.getByTestId("retry-versions").click();
  await historyDialog.locator("li").nth(19).waitFor();
  check(await historyDialog.locator("li").count() === 20, "retrying the first page of the description history did not load it");
  await historyDialog.getByRole("button", { name: "ปิด" }).click();
  await historyDialog.waitFor({ state: "detached" });
  await captureThaiModes("description", "[data-testid='description-editor']");
  const thaiComment = page.locator("li[id^='comment-']").filter({ hasText: "Converter formatting" }).first();
  // The comment history pages too: 25 seeded versions show 20, and Show older versions adds the rest.
  {
    const commentId = (await thaiComment.getAttribute("id"))!.replace("comment-", "");
    const { SQL: Sql } = await import("bun");
    const seed = new Sql(process.env.DATABASE_URL!);
    await seed.unsafe(`update comments set edited_at = now() where id = '${commentId}'`);
    await seed.unsafe(`insert into comment_versions (comment_id, body, body_markdown, body_text, written_at, created_at)
      select '${commentId}', '{"type":"doc","content":[]}'::jsonb, 'Old comment ' || n, 'Old comment ' || n, now() - (n || ' hours')::interval, now() - (n || ' hours')::interval from generate_series(1, 25) as n`);
    await seed.close();
    await page.reload();
    const reloaded = page.locator("li[id^='comment-']").filter({ hasText: "Converter formatting" }).first();
    await reloaded.getByRole("button", { name: "ประวัติ", exact: true }).click();
    const list = reloaded.getByRole("list", { name: "ประวัติ" });
    await list.waitFor();
    check(await list.locator("li").count() === 21, `the comment history showed ${await list.locator("li").count() - 1} versions first, not 20`);
    await list.getByTestId("show-older-comment-versions").click();
    await list.locator("li").nth(24).waitFor();
    check(await list.getByTestId("show-older-comment-versions").count() === 0, "Show older versions stays on the comment history after the last page");
    await reloaded.getByRole("button", { name: "ประวัติ", exact: true }).click();
  }
  await thaiComment.getByRole("button", { name: "แก้ไข", exact: true }).click();
  await captureThaiModes("comment", "[data-testid='comment-editor']");
  await thaiComment.getByRole("button", { name: "ยกเลิก" }).click();
  await page.goto(`${web}/${slug}/wiki/${projectPageCreated.id}`);
  await page.getByTestId("wiki-editor").waitFor();
  await captureThaiModes("page", "[data-testid='wiki-editor']");
  await call("unlock_wiki_page", { pageId: wiki.id });
  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  await page.getByTestId("wiki-editor").waitFor();
  await captureThaiModes("wiki-page", "[data-testid='wiki-editor']");
  console.log("case passed: published Wiki renders highlighted code and coloured callouts");
  console.log("editor parity ok: placeholders, visible markdown blocks, shared slash menu, and safe links in description, Comment, Wiki, and published Wiki");
  await browser.close();
  browser = null;
} catch (error) {
  if (error !== "DIFF_CAPTURE_COMPLETE" && error !== "WORK_ITEM_CAPTURE_COMPLETE") throw error;
  console.log(error === "DIFF_CAPTURE_COMPLETE" ? "diff browser assertions and captures complete" : "work-item phone assertions and captures complete");
} finally {
  await browser?.close();
  if (slug) {
    const { client, db } = createDatabase();
    await db.delete(workspaces).where(eq(workspaces.slug, slug));
    await db.delete(users).where(eq(users.email, `${slug}@example.test`));
    await client.end();
  }
  for (const server of servers) server.kill();
}
