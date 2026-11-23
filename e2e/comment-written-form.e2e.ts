import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { createAgentActions, createCommentActions, createProjectActions } from "../packages/actions/src";
import { comments, createDatabase, users } from "../packages/db/src";
import { backfillCommentWrittenForms } from "../packages/actions/src/migrations/comment-written-form";
import { createMemberFactory } from "../packages/db/src/test-helpers";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31227);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52227);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const captureDir = Bun.env.COMMENT_SCREENSHOT_DIR ?? `${process.cwd()}/.scratch-captures`;
const servers: ReturnType<typeof Bun.spawn>[] = [];
async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}
const { client, db } = createDatabase();
let failed = false;
try {
  servers.push(Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }));
  // The dev server, not a build served by `vite preview`: a build writes apps/web/dist, which flows running side by side would overwrite under each other.
  servers.push(Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }));
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const slug = `written-${crypto.randomUUID().slice(0, 7)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Workspace Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword", "en")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Written comments");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded", timeout: 8000 });

  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const adminId = me.user.id;
  const reviewer = await createMemberFactory(db, workspaceId, "Member");
  await db.update(users).set({ name: "Reviewer" }).where((await import("drizzle-orm")).eq(users.id, reviewer.id));
  const projects = createProjectActions(db);
  const project = await projects.createProject.handler({ userId: adminId }, { workspaceId, name: "Reviews", key: "REV", visibility: "public" });
  await projects.addProjectMember.handler({ userId: adminId }, { projectId: project.id, userId: reviewer.id, role: "Member" });
  const agentActions = createAgentActions(db);
  const agent = await agentActions.createAgent.handler({ userId: adminId }, { workspaceId, name: "Review Bot", model: "default" });
  await agentActions.setAgentProjectAccess.handler({ userId: adminId }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const item = await page.request.post(`${api}/actions/create_work_item`, { data: { projectId: project.id, title: "Written comment review" } }).then((response) => response.json() as Promise<{ id: string }>);
  const commentsActions = createCommentActions(db);
  const legacy = await commentsActions.createComment.handler({ userId: adminId, source: "ui" }, {
    workItemId: item.id,
    bodyMarkdown: `| Check | Result |\n| --- | --- |\n| Access | ready |\n\nReviewer: @{${reviewer.id}}`,
  });
  await db.execute((await import("drizzle-orm")).sql`alter table comments alter column body_markdown drop not null`);
  await db.update(comments).set({ bodyMarkdown: null }).where((await import("drizzle-orm")).eq(comments.id, legacy.id));
  await commentsActions.createComment.handler({ userId: agent.userId, source: "agent" }, {
    workItemId: item.id, parentId: legacy.id, bodyMarkdown: "Reviewed the access check. **Ready to proceed.**",
  });
  const compactMarkdown = `##\n\n-\n\n<!-- empty paragraph -->\n\nBefore\n\n<!-- empty paragraph -->\n\n\`\`\`ts\nconst value = 1;\n\nreturn value;\n\`\`\`\n\nAfter\n\n---\n\n- Keep this checklist item\n\nReviewer: @{${reviewer.id}}\n\n<!-- empty paragraph -->\n\n### `;
  const compactComment = await commentsActions.createComment.handler({ userId: adminId, source: "ui" }, { workItemId: item.id, bodyMarkdown: compactMarkdown });
  const compactReplyMarkdown = "##\n\n<!-- empty paragraph -->\n\nReply text\n\n<!-- empty paragraph -->\n\n### ";
  const compactReply = await commentsActions.createComment.handler({ userId: adminId, source: "ui" }, { workItemId: item.id, parentId: compactComment.id, bodyMarkdown: compactReplyMarkdown });
  const timeline = await page.request.post(`${api}/actions/list_timeline`, { data: { workItemId: item.id, filter: "comments", sort: "oldest" } }).then((response) => response.json() as Promise<Array<{ comment: { id: string; markdown: string; replies: Array<{ id: string; markdown: string }> } | null }>>);
  const compactEntry = timeline.find((entry) => entry.comment?.id === compactComment.id)?.comment;
  const compactMarkdownApi = compactEntry?.markdown;
  const compactReplyMarkdownApi = compactEntry?.replies.find((reply) => reply.id === compactReply.id)?.markdown;
  if (!compactMarkdownApi?.includes("##") || !compactMarkdownApi.includes("###") || !compactMarkdownApi.includes("Keep this checklist item") || !compactMarkdownApi.includes("---") || !compactMarkdownApi.includes("const value = 1;\n\nreturn value;") || !compactReplyMarkdownApi?.includes("##") || !compactReplyMarkdownApi.includes("###") || !compactReplyMarkdownApi.includes("<!-- empty paragraph -->")) throw new Error(`Comment API output did not retain the original Markdown, internal code whitespace, or reply content: ${JSON.stringify(compactMarkdownApi)}`);

  const detailUrl = `${web}/${slug}/browse/REV-1`;
  mkdirSync(captureDir, { recursive: true });
  const switchLocale = async (locale: "en" | "th") => {
    const result = await page.request.post(`${api}/actions/set_my_locale`, { data: { locale } });
    if (!result.ok()) throw new Error(`Could not set capture locale ${locale}: ${result.status()}`);
    await page.goto(detailUrl);
    await page.getByText("Reviewed the access check.").waitFor();
  };
  const capture = async (stage: "before" | "after" | "source", width: 1280 | 390, locale: "en" | "th") => {
    await page.setViewportSize({ width, height: width === 390 ? 1000 : 900 });
    await page.locator(`#comment-${legacy.id}`).evaluate((element) => element.scrollIntoView({ block: "center" }));
    const path = `${captureDir}/03-comments-${stage}-${width}-${locale}.png`;
    await page.screenshot({ path });
    console.log(path);
  };

  const root = page.locator(`#comment-${legacy.id}`);
  await page.goto(detailUrl);
  await page.getByText("Reviewed the access check.").waitFor();
  await root.waitFor();
  const compactRow = page.locator(`#comment-${compactComment.id}`);
  await compactRow.locator(".comment-body .ProseMirror").first().waitFor();
  const compactRendering = await compactRow.locator(".comment-body .ProseMirror").first().evaluate((element) => {
    const blocks = Array.from(element.children);
    const isEmptyBlock = (block: Element) => !block.textContent && !block.querySelector("img, [data-type='mention'], br:not(.ProseMirror-trailingBreak)");
    return {
      firstIsEmpty: blocks[0] ? isEmptyBlock(blocks[0]) : false,
      lastIsEmpty: blocks.at(-1) ? isEmptyBlock(blocks.at(-1)!) : false,
      emptyEdgeHeadings: blocks.filter((block) => /^H[1-6]$/.test(block.tagName) && isEmptyBlock(block)).length,
      emptyEdgeLists: blocks.filter((block) => ["UL", "OL"].includes(block.tagName) && isEmptyBlock(block)).length,
      emptyParagraphs: blocks.filter((block) => block.tagName === "P" && isEmptyBlock(block)).length,
      code: element.querySelector("pre code")?.textContent ?? "",
      listItem: Array.from(element.querySelectorAll("ul li")).find((item) => item.textContent)?.textContent ?? "",
      mention: element.querySelector("[data-type='mention']")?.textContent ?? "",
      hasHorizontalRule: !!element.querySelector("hr"),
      firstMargin: getComputedStyle(blocks[0]!).marginBlockStart,
      lastMargin: getComputedStyle(blocks.at(-1)!).marginBlockEnd,
    };
  });
  if (compactRendering.firstIsEmpty || compactRendering.lastIsEmpty || compactRendering.emptyEdgeHeadings || compactRendering.emptyEdgeLists || compactRendering.emptyParagraphs !== 1) throw new Error(`Comment edge blocks were not compacted while preserving the internal blank paragraph: ${JSON.stringify(compactRendering)}`);
  if (!compactRendering.code.includes("const value = 1;\n\nreturn value;")) throw new Error(`Comment code whitespace changed: ${JSON.stringify(compactRendering.code)}`);
  if (compactRendering.listItem !== "Keep this checklist item" || !compactRendering.mention.includes("Reviewer") || !compactRendering.hasHorizontalRule) throw new Error(`Comment list, mention, or horizontal-rule content was not preserved: ${JSON.stringify(compactRendering)}`);
  if (compactRendering.firstMargin !== "0px" || compactRendering.lastMargin !== "0px") throw new Error(`Comment edge layout retained outer block margins: ${JSON.stringify(compactRendering)}`);
  const compactReplyRow = page.locator(`#comment-${compactReply.id}`);
  const replyRendering = await compactReplyRow.locator(".comment-body .ProseMirror").evaluate((element) => {
    const blocks = Array.from(element.children);
    const isEmptyBlock = (block: Element) => !block.textContent && !block.querySelector("img, [data-type='mention'], br:not(.ProseMirror-trailingBreak)");
    return { firstIsEmpty: isEmptyBlock(blocks[0]!), lastIsEmpty: isEmptyBlock(blocks.at(-1)!) };
  });
  if (replyRendering.firstIsEmpty || replyRendering.lastIsEmpty) throw new Error(`Reply edge blocks were not compacted: ${JSON.stringify(replyRendering)}`);
  if (await root.locator("table").count() !== 1) throw new Error("Legacy comment table did not render before conversion");
  if (!(await root.getByText("Reviewer").count())) throw new Error("Legacy comment mention did not render before conversion");
  for (const locale of ["en", "th"] as const) {
    await switchLocale(locale);
    for (const width of [1280, 390] as const) await capture("before", width, locale);
  }

  await backfillCommentWrittenForms(db);
  for (const locale of ["en", "th"] as const) {
    await switchLocale(locale);
    const converted = page.locator(`#comment-${legacy.id}`);
    await converted.locator("table").waitFor();
    if ((await converted.locator("table").count()) !== 1) throw new Error("Converted comment table did not render");
    if (!(await converted.getByText("Reviewer").count())) throw new Error("Converted comment mention did not render");
    for (const width of [1280, 390] as const) await capture("after", width, locale);
    await converted.getByRole("button", { name: translate("comments.edit", locale) }).click();
    const editor = converted.getByTestId("comment-editor");
    await converted.getByRole("button", { name: translate("editor.sourceMode", locale), exact: true }).click();
    await editor.getByTestId("editor-source-text").waitFor();
    const sourceText = await editor.getByTestId("editor-source-text").inputValue();
    if (!sourceText.includes("Access") || !sourceText.includes("Reviewer")) throw new Error(`Source mode did not show the stored comment: ${sourceText}`);
    for (const width of [1280, 390] as const) await capture("source", width, locale);
    await converted.getByRole("button", { name: translate("editor.sourceMode", locale), exact: true }).click();
    await page.getByRole("button", { name: translate("comments.cancel", locale) }).last().click();
  }

  await page.goto(detailUrl);
  const compactForEditing = page.locator(`#comment-${compactComment.id}`);
  await compactForEditing.getByRole("button", { name: translate("comments.edit", "th"), exact: true }).first().click();
  await compactForEditing.getByRole("button", { name: translate("editor.sourceMode", "th"), exact: true }).click();
  const compactSource = await compactForEditing.getByTestId("editor-source-text").inputValue();
  if (!compactSource.includes("## ") || !compactSource.includes("### ") || !compactSource.includes("Keep this checklist item") || !compactSource.includes("Reviewer: @{Reviewer|") || !compactSource.includes("---") || !compactSource.includes("const value = 1;\n\nreturn value;")) throw new Error(`Editing did not preserve the original headings, list, mention, atom, or code in source mode: ${JSON.stringify(compactSource)}`);
  await compactForEditing.getByRole("button", { name: translate("editor.sourceMode", "th"), exact: true }).click();
  await compactForEditing.getByRole("button", { name: translate("comments.cancel", "th") }).click();
  const timelineAfterEdit = await page.request.post(`${api}/actions/list_timeline`, { data: { workItemId: item.id, filter: "comments", sort: "oldest" } }).then((response) => response.json() as Promise<Array<{ comment: { id: string; markdown: string; replies: Array<{ id: string; markdown: string }> } | null }>>);
  const compactEntryAfterEdit = timelineAfterEdit.find((entry) => entry.comment?.id === compactComment.id)?.comment;
  if (compactEntryAfterEdit?.markdown !== compactMarkdownApi || compactEntryAfterEdit.replies.find((reply) => reply.id === compactReply.id)?.markdown !== compactReplyMarkdownApi) throw new Error("Opening and cancelling edit changed Comment or reply API output");

  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  servers.forEach((server) => server.kill());
  await client.end();
}
process.exit(failed ? 1 : 0);
