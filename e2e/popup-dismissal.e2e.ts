// Browser check for popup dismissal: every popup closes on an outside pointer-down and on Escape, a chosen result closes its list,
// the AI preview survives an outside click until Escape, and an open table menu closes on a click in the page content and on Escape.
// Run with `bun e2e/popup-dismissal.e2e.ts`; needs CHROMIUM_PATH as for the other flows.
import { check, launchBrowser, newContext, startApi, startLive, startWeb, waitFor } from "./harness";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31490);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52490);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31491);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  // A placeholder provider key makes the AI menu configured; the provider call fails offline, which leaves the preview in its error state.
  startApi(apiPort, web, { env: { ...Bun.env, OPENAI_API_KEY: "sk-popup-dismissal-e2e" } }),
  startLive(livePort, web),
  startWeb(webPort, { api, live: `ws://localhost:${livePort}`, env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true" } }),
];

const t = (key: string) => translate(key as never);

let failed = false;
let step = "setup";
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`page error: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") console.log(`page console: ${message.text()}`); });
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByRole("button", { name: t("auth.signUp"), exact: true }).click();
  await page.getByLabel(t("auth.name")).fill("Popup Tester");
  await page.getByLabel(t("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(t("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(t("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: t("auth.signUp") }).click();
  await page.getByLabel(t("workspace.name")).fill("Popup team");
  await page.getByLabel(t("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: t("workspace.create") }).click();
  await page.getByRole("button", { name: t("projects.new"), exact: true }).click();
  await page.getByLabel(t("projects.name")).fill("Popups");
  await page.getByLabel(t("projects.key"), { exact: true }).fill("POP");
  await page.getByText(t("projects.shapeFull"), { exact: true }).click();
  await page.getByRole("button", { name: t("projects.create") }).click();
  await page.getByRole("link", { name: /POP · Popups/ }).waitFor();

  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "POP" });
  await call("create_work_item", { projectId: project.id, title: "Search target" });
  await call("create_skill", { workspaceId, scope: "workspace", name: "summarize-page", description: "Summarize a page", instructions: "Summarize the page in three sentences." });
  const cell = (text: string) => ({ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const editorPage = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Popup words", content: { type: "doc", content: [paragraph("Popup words here")] } });
  const tablePage = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Popup table", content: { type: "doc", content: [
    { type: "table", content: [{ type: "tableRow", content: [cell("A"), cell("B")] }, { type: "tableRow", content: [cell("C"), cell("D")] }] },
    paragraph("After table"),
  ] } });

  // A click on blank page chrome, away from every popup, the editor and the chat composer.
  const outside = () => page.mouse.click(1420, 890);

  step = '1';
  // 1. Global work item search: outside click, Escape and choosing a result each close the results.
  await page.goto(`${web}/${slug}/wiki/${editorPage.id}`);
  const search = page.getByRole("searchbox", { name: t("search.label") });
  const results = page.getByRole("list", { name: t("search.results") });
  await search.fill("Search target");
  await results.waitFor();
  await outside();
  await results.waitFor({ state: "detached" });
  await search.click();
  await page.keyboard.type("!");
  await results.waitFor();
  await page.keyboard.press("Escape");
  await results.waitFor({ state: "detached" });
  await search.fill("Search target");
  await results.waitFor();
  await page.getByRole("link", { name: /Search target/ }).click();
  await page.waitForURL(/\/browse\/POP-1/);
  await results.waitFor({ state: "detached" });
  console.log("popup search: outside click, Escape and choosing a result close the results");

  step = '2';
  // 2. AI chat skill picker: outside click and Escape hide it; typing again reopens it; choosing a skill closes it.
  await page.goto(`${web}/${slug}/ai`);
  const composer = page.getByRole("textbox", { name: t("ai.message") });
  const skillPicker = page.getByRole("listbox", { name: t("skills.picker") });
  await composer.click();
  await page.keyboard.type("/");
  await skillPicker.waitFor();
  await page.getByText(t("ai.disclaimer")).click();
  await skillPicker.waitFor({ state: "detached" });
  await composer.click();
  await page.keyboard.press("End");
  await page.keyboard.type("s");
  await skillPicker.waitFor();
  await page.keyboard.press("Escape");
  await skillPicker.waitFor({ state: "detached" });
  check(await composer.inputValue() === "/s", "Escape must leave the typed slash text in the composer");
  await composer.fill("");
  await page.keyboard.type("/su");
  await skillPicker.waitFor();
  await page.getByRole("option", { name: /summarize-page/ }).click();
  await skillPicker.waitFor({ state: "detached" });
  check(await page.getByRole("button", { name: /summarize-page/ }).count() > 0, "a chosen skill should show as the selected Skill chip");
  console.log("popup skill picker: outside click, Escape and choosing a skill close it");

  step = '3';
  // 3. Editor suggestion boxes in the Wiki editor: "@", ":", "/" and "[[".
  await page.goto(`${web}/${slug}/wiki/${editorPage.id}`);
  const editor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  const suggestion = (name: string) => page.getByRole("listbox", { name: t(name), exact: true });
  const openAt = async (text: string) => { await editor.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type(text); };
  const popupCases: Array<{ label: string; name: string; trigger: string; choose: () => Promise<void> }> = [
    { label: "mention", name: "wiki.mentionMembers", trigger: " @", choose: () => page.keyboard.press("Enter") },
    { label: "emoji", name: "wiki.insert.emoji", trigger: " :smi", choose: () => page.keyboard.press("Enter") },
    { label: "slash", name: "editor.slashMenu", trigger: "/", choose: () => page.keyboard.press("Enter") },
    { label: "reference", name: "reference.picker", trigger: "[[Search", choose: async () => { await page.getByRole("option", { name: /Search target/ }).first().click(); } },
  ];
  for (const popup of popupCases) {
    await openAt(popup.trigger);
    await suggestion(popup.name).waitFor();
    await outside();
    await suggestion(popup.name).waitFor({ state: "detached" });
    await openAt(popup.trigger);
    await suggestion(popup.name).waitFor();
    await page.keyboard.press("Escape");
    await suggestion(popup.name).waitFor({ state: "detached" });
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(popup.trigger);
    await suggestion(popup.name).waitFor();
    await popup.choose();
    await suggestion(popup.name).waitFor({ state: "detached" });
    console.log(`popup ${popup.label}: outside click, Escape and choosing close it`);
  }

  step = '4';
  // 4. AI assist: the task picker hides on an outside click; the preview survives it until Escape.
  await page.goto(`${web}/${slug}/wiki/${editorPage.id}`);
  const toolbar = page.getByRole("toolbar", { name: t("assist.menu") });
  const preview = page.getByRole("region", { name: t("assist.preview") });
  await editor.click();
  await page.keyboard.press("Control+a");
  await toolbar.waitFor();
  await page.keyboard.press("Escape");
  await toolbar.waitFor({ state: "detached" });
  await editor.click();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+a");
  await toolbar.waitFor();
  await outside();
  await toolbar.waitFor({ state: "detached" });
  await editor.click();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+a");
  await toolbar.waitFor();
  await toolbar.getByRole("button", { name: t("assist.task.summarize") }).click();
  await preview.waitFor();
  await toolbar.waitFor({ state: "detached" });
  await outside();
  await page.waitForTimeout(300);
  check(await preview.isVisible(), "an outside click must leave the AI preview open");
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "detached" });
  console.log("popup AI assist: outside click hides the task picker; the preview stays until Escape");

  step = '5';
  // 5. Table menu: a click in the page content closes it; Escape closes it before focus moves to the table corner.
  await page.goto(`${web}/${slug}/wiki/${tablePage.id}`);
  const tableEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  const menu = page.getByTestId("table-menu");
  const openRowMenu = async () => {
    await tableEditor.locator("p", { hasText: /^C$/ }).click({ position: { x: 1, y: 4 } });
    await page.locator('[data-table-grip="row-1"]').click();
    await menu.waitFor();
  };
  await openRowMenu();
  await tableEditor.locator("p", { hasText: "After table" }).click({ position: { x: 1, y: 4 } });
  await menu.waitFor({ state: "detached" });
  await openRowMenu();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  const focusedAfterMenuEscape = await page.evaluate(() => document.activeElement?.getAttribute("data-table-grip") ?? document.activeElement?.className ?? "");
  check(focusedAfterMenuEscape !== "table", "Escape with an open table menu must not move focus to the table corner");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-table-grip") === "table");
  console.log("popup table menu: content click closes it; Escape closes the menu before focus moves to the corner");

  await browser.close();
  console.log("e2e popup dismissal: all checks ok");
} catch (error) {
  failed = true;
  console.error(`failed at step ${step}`);
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
