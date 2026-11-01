// Browser end-to-end flow: the AI page (recents, search, rename, delete, one Confirm for the proposed set, expiry, re-validation, convert to page).
// No model is needed: chats and Confirmation cards are seeded through the chat and confirmation stores.
// Run with `bun e2e/ai.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database). Screenshots go to .local/visual/review/17-ai-page.
import { chromium } from "playwright";
import { eq, like } from "drizzle-orm";
import { createDatabase, confirmations, users, workspaces } from "../packages/db/src";
import { createChatStore, createConfirmationStore, proposalResult } from "../packages/actions/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31177);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52177);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("17-ai-page");
const modeShots = reviewShots("18-ai-chat-modes");
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
const { client, db } = createDatabase();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByLabel(translate("auth.name")).fill("AI Tester");
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  const item = await call<{ id: string; title: string }>("create_work_item", { projectId: project.id, title: "Original title" });
  const [user] = await db.select().from(users).where(eq(users.email, email));
  const userId = user!.id;

  const chats = createChatStore(db);
  const proposals = createConfirmationStore(db);
  const seed = async (title: string, question: string, answer: string, proposed: Array<{ action: string; input: Record<string, unknown> }>) => {
    const chat = (await chats.upsertChat({ id: crypto.randomUUID(), workspaceId, userId, title }))!;
    await chats.saveMessage(chat.id, { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: question }] });
    const cards = [];
    for (const proposal of proposed) cards.push(await proposals.propose({ userId, workspaceId, chatId: chat.id, ...proposal }));
    await chats.saveMessage(chat.id, { id: crypto.randomUUID(), role: "assistant", parts: [
      { type: "tool-list_work_items", toolCallId: "t0", state: "output-available", input: {}, output: "[]" },
      ...cards.map((card, index) => ({ type: `tool-${card.action}`, toolCallId: `t${index + 1}`, state: "output-available", input: card.input, output: proposalResult(card) })),
      { type: "text", text: answer },
    ] });
    return { chat, cards };
  };
  const batch = await seed("Sprint summary", "Create two work items for the launch", "Planned two work items.\nReview them before they are created.", [
    { action: "create_work_item", input: { projectId: project.id, title: "Launch checklist" } },
    { action: "create_work_item", input: { projectId: project.id, title: "Launch announcement" } },
  ]);
  await seed("Release notes", "Draft release notes", "Release notes are ready.", []);
  const stale = await seed("Rename candidate", "Rename the original item", "Proposed a rename.", [{ action: "update_work_item", input: { workItemId: item.id, title: "Renamed by AI" } }]);
  const expiring = await seed("Old proposal", "Do something old", "That was a while ago.", [{ action: "create_work_item", input: { projectId: project.id, title: "Should never exist" } }]);
  await db.update(confirmations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(confirmations.id, expiring.cards[0]!.id));

  // Sidebar: New chat, search, Recents.
  await page.goto(`${web}/${slug}/ai`);
  const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });
  await sidebar.getByRole("link", { name: translate("ai.new") }).waitFor();
  const recents = sidebar.getByRole("navigation", { name: translate("ai.recents") });
  for (const title of ["Sprint summary", "Release notes", "Rename candidate", "Old proposal"]) await recents.getByRole("link", { name: title }).waitFor();
  await page.getByText(translate("ai.disclaimer")).waitFor();
  await page.getByRole("textbox", { name: translate("ai.message") }).waitFor();
  await page.screenshot({ path: `${shots}/ai-new-1440.png` });
  await sidebar.getByRole("button", { name: translate("ai.search") }).click();
  await sidebar.getByRole("searchbox", { name: translate("ai.search") }).fill("release");
  check(await recents.getByRole("link").count() === 1, "search did not filter recents");
  await sidebar.getByRole("searchbox", { name: translate("ai.search") }).fill("zzz");
  await recents.getByText(translate("ai.noMatches")).waitFor();
  await sidebar.getByRole("searchbox", { name: translate("ai.search") }).fill("");
  console.log("ai ok: sidebar list and search");

  // Rename and delete work against stored chats (and survive a reload).
  await recents.getByRole("button", { name: `${translate("ai.rename")}: Release notes` }).click();
  await recents.getByRole("textbox", { name: translate("ai.rename") }).fill("Release notes v2");
  await recents.getByRole("button", { name: translate("ai.renameSave") }).click();
  await recents.getByRole("link", { name: "Release notes v2" }).waitFor();
  await page.reload();
  await page.getByRole("navigation", { name: translate("ai.recents") }).getByRole("link", { name: "Release notes v2" }).waitFor();
  check((await chats.listChats(userId, workspaceId)).some((chat) => chat.title === "Release notes v2"), "rename not stored");
  await recents.getByRole("button", { name: `${translate("ai.delete")}: Release notes v2` }).click();
  await recents.getByRole("button", { name: translate("ai.deleteYes"), exact: true }).click();
  await recents.getByText(translate("ai.deleteConfirm")).waitFor({ state: "detached" });
  await recents.getByRole("link", { name: "Release notes v2" }).waitFor({ state: "detached" });
  check(!(await chats.listChats(userId, workspaceId)).some((chat) => chat.title === "Release notes v2"), "delete not stored");
  console.log("ai ok: rename and delete");

  // One Confirm applies the whole proposed set.
  await recents.getByRole("link", { name: "Sprint summary" }).click();
  await page.getByText("Create two work items for the launch").waitFor();
  await page.getByText(translate("ai.thoughts")).waitFor();
  await page.getByText("Launch checklist").first().waitFor();
  await page.getByText("Launch announcement").first().waitFor();
  await page.getByText(translate("ai.awaiting")).waitFor();
  check(await page.getByRole("button", { name: translate("ai.confirmAll"), exact: true }).count() === 1, "expected exactly one Confirm");
  for (const label of [translate("ai.copy"), translate("ai.thumbUp"), translate("ai.thumbDown"), translate("ai.regenerate"), translate("ai.convert")]) await page.getByRole("button", { name: label }).waitFor();
  await page.screenshot({ path: `${shots}/ai-confirm-1440.png` });
  await page.getByRole("button", { name: translate("ai.confirmAll"), exact: true }).click();
  await page.getByRole("status").filter({ hasText: translate("ai.confirm.confirmed") }).first().waitFor();
  const listed = await call<Array<{ title: string }>>("list_work_items", { projectId: project.id });
  check(listed.some((row) => row.title === "Launch checklist") && listed.some((row) => row.title === "Launch announcement"), "confirm did not create both work items");
  check(await page.getByRole("button", { name: translate("ai.confirmAll"), exact: true }).count() === 0, "Confirm still visible after applying");
  console.log("ai ok: one Confirm applied the set");

  // Re-validation: the target changed after the proposal, so Confirm reports the diff first.
  await call("update_work_item", { workItemId: item.id, title: "Changed by a person" });
  await page.goto(`${web}/${slug}/ai/${stale.chat.id}`);
  await page.getByRole("button", { name: translate("ai.confirmAll"), exact: true }).click();
  await page.getByRole("alert").filter({ hasText: translate("ai.confirm.changed") }).waitFor();
  check((await call<Array<{ title: string }>>("list_work_items", { projectId: project.id })).some((row) => row.title === "Changed by a person"), "changed target was overwritten without acknowledgement");
  await page.getByRole("button", { name: translate("ai.confirm.anyway") }).click();
  await page.getByRole("status").filter({ hasText: translate("ai.confirm.confirmed") }).first().waitFor();
  check((await call<Array<{ title: string }>>("list_work_items", { projectId: project.id })).some((row) => row.title === "Renamed by AI"), "acknowledged confirm did not apply");
  console.log("ai ok: re-validation diff");

  // Expiry: an expired card has no Confirm and nothing ran.
  await page.goto(`${web}/${slug}/ai/${expiring.chat.id}`);
  await page.getByText(translate("ai.confirm.expired")).waitFor();
  check(await page.getByRole("button", { name: translate("ai.confirmAll"), exact: true }).count() === 0, "expired card offers Confirm");
  check(!(await call<Array<{ title: string }>>("list_work_items", { projectId: project.id })).some((row) => row.title === "Should never exist"), "expired proposal ran");
  console.log("ai ok: expiry");

  // Convert to page creates a wiki page through the create_wiki_page Action.
  await page.goto(`${web}/${slug}/ai/${batch.chat.id}`);
  await page.getByRole("button", { name: translate("ai.convert") }).click();
  await page.waitForURL(new RegExp(`/${slug}/wiki/[0-9a-f-]{36}`));
  const pages = await call<Array<{ title: string; contentText: string }>>("list_wiki_pages", { workspaceId });
  check(pages.some((row) => row.title === "Planned two work items."), `wiki page missing: ${JSON.stringify(pages.map((row) => row.title))}`);
  console.log("ai ok: convert to page");

  // Chat mode: dropdown with Ask and Build (default Build), stored on the chat, shown again when reopened.
  await page.goto(`${web}/${slug}/ai`);
  const modeSelect = page.getByRole("combobox", { name: translate("ai.mode") });
  await modeSelect.waitFor();
  check(JSON.stringify(await modeSelect.locator("option").allTextContents()) === JSON.stringify([translate("ai.mode.ask"), translate("ai.mode.build")]), "mode dropdown options are not Ask and Build");
  check(await modeSelect.inputValue() === "build", "default mode is not Build");
  await page.screenshot({ path: `${modeShots}/mode-build-1440.png` });
  await modeSelect.selectOption("ask");
  await page.getByRole("textbox", { name: translate("ai.message") }).fill("Create a work item called Nope");
  await page.getByRole("button", { name: translate("ai.send") }).click();
  let askChatId = "";
  for (let attempt = 0; attempt < 50 && !askChatId; attempt += 1) {
    askChatId = (await chats.listChats(userId, workspaceId)).find((chat) => chat.title === "Create a work item called Nope")?.id ?? "";
    if (!askChatId) await Bun.sleep(200);
  }
  check(askChatId !== "", "chat was not created on send");
  check((await chats.getChat(userId, askChatId))!.mode === "ask", "mode was not stored on the chat");
  await page.goto(`${web}/${slug}/ai/${askChatId}`);
  await page.getByRole("combobox", { name: translate("ai.mode") }).waitFor();
  check(await page.getByRole("combobox", { name: translate("ai.mode") }).inputValue() === "ask", "reopened chat does not show Ask");
  await page.screenshot({ path: `${modeShots}/mode-ask-reopened-1440.png` });
  await page.goto(`${web}/${slug}/ai/${batch.chat.id}`);
  await page.getByRole("combobox", { name: translate("ai.mode") }).waitFor();
  check(await page.getByRole("combobox", { name: translate("ai.mode") }).inputValue() === "build", "Build chat does not show Build");
  console.log("ai ok: chat mode");

  // Phone width: no horizontal scroll, composer reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/ai/${batch.chat.id}`);
  await page.getByRole("textbox", { name: translate("ai.message") }).waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal page scroll at 390px");
  await page.screenshot({ path: `${shots}/ai-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}/${slug}/ai/${batch.chat.id}`);
  await page.getByRole("textbox", { name: translate("ai.message") }).waitFor();
  await page.screenshot({ path: `${shots}/ai-chat-1440.png` });

  console.log("e2e ai: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
