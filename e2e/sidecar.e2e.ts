// Browser end-to-end flow: the AI Sidecar panel (open/close keeps the chat, entity context sent to the AI, width persisted per user, full screen at 390px).
// No model is needed: the chat endpoint is intercepted and answered with a canned UI message stream.
// Run with `bun e2e/ai.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database). Screenshots go to .local/visual/review/19-ai-sidecar-panel.
import { chromium } from "playwright";
import { eq, like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { createChatStore } from "../packages/actions/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31197);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52197);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("19-ai-sidecar-panel");
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
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("AI Tester");
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  if (await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).count()) await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  const item = await call<{ id: string; title: string }>("create_work_item", { projectId: project.id, title: "Original title" });

  const wikiPage = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Handbook" });
  const [user] = await db.select().from(users).where(eq(users.email, email));
  const userId = user!.id;

  // A chat from the AI page, to prove the panel shares its history.
  const chats = createChatStore(db);
  const old = (await chats.upsertChat({ id: crypto.randomUUID(), workspaceId, userId, title: "Earlier AI page chat" }))!;
  await chats.saveMessage(old.id, { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Question from the AI page" }] });
  await chats.saveMessage(old.id, { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: "Answer from the AI page" }] });

  // Canned answer; records every request body the web app sends.
  const sent: Array<{ mode?: string; context?: { type: string; id: string; title: string }; messages: Array<{ parts: Array<{ text?: string }> }> }> = [];
  await page.route(`${api}/api/ai/chat`, async (route) => {
    const cors = { "access-control-allow-origin": web, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type" };
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
    sent.push(JSON.parse(route.request().postData() ?? "{}"));
    const chunks = [{ type: "start" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Canned answer." }, { type: "text-end", id: "t" }, { type: "finish" }];
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1", ...cors }, body: `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n` });
  });

  // Client-side navigation (a full page load would end the in-memory chat, as on the AI page).
  const nav = async (path: string) => { await page.evaluate((to) => { history.pushState({}, "", to); dispatchEvent(new PopStateEvent("popstate")); }, path); };
  const panel = page.getByRole("complementary", { name: translate("sidecar.title") });
  const composer = panel.getByRole("textbox", { name: translate("ai.message") });
  const ask = async (text: string) => { await composer.fill(text); await panel.getByRole("button", { name: translate("ai.send") }).click(); };

  // Top bar opens the panel from a screen with no entity: the pill names the workspace.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("button", { name: translate("sidecar.open") }).click();
  await composer.waitFor();
  check(await panel.getByText("E2E team").count() > 0, "pill does not show the workspace without an entity");
  await ask("Hello there");
  await panel.getByText("Canned answer.").waitFor();
  check(sent.length === 1 && sent[0]!.context === undefined, "context sent without an entity");
  console.log("sidecar ok: top bar opens, chat answers");

  // Close and reopen keep the conversation.
  await panel.getByRole("button", { name: translate("sidecar.close") }).click();
  await panel.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: translate("sidecar.open") }).click();
  await panel.getByText("Hello there").waitFor();
  await panel.getByText("Canned answer.").waitFor();
  console.log("sidecar ok: close and reopen keep the chat");

  // Work item page: header button opens it with that item as context.
  await panel.getByRole("button", { name: translate("sidecar.close") }).click();
  await nav(`/${slug}/browse/${(item as unknown as { displayId: string }).displayId}`);
  await page.getByRole("button", { name: translate("sidecar.open"), exact: true }).first().waitFor();
  await page.locator("header button.secondary", { hasText: translate("sidecar.open") }).click();
  await panel.getByText("Original title").waitFor();
  await panel.getByText("Hello there").waitFor();
  await ask("What is this?");
  await panel.getByText("What is this?").waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-role=assistant]").length >= 2);
  const workItemRequest = sent[sent.length - 1]!;
  check(workItemRequest.context?.type === "work_item" && workItemRequest.context.title === "Original title" && /^MOB-\d+$/.test(workItemRequest.context.id), `work item context wrong: ${JSON.stringify(workItemRequest.context)}`);
  console.log("sidecar ok: work item context sent");

  // Wiki page: context switches to the page, same chat.
  await panel.getByRole("button", { name: translate("sidecar.close") }).click();
  await page.getByRole("link", { name: translate("app.title") }).first().waitFor();
  await nav(`/${slug}/wiki/${wikiPage.id}`);
  await page.locator("nav button.secondary", { hasText: translate("sidecar.open") }).click();
  await panel.getByText("Handbook").first().waitFor();
  const before = sent.length;
  await ask("Summarize it");
  await page.waitForFunction((count) => document.querySelectorAll("[data-role=assistant]").length >= count, 3);
  const wikiRequest = sent[before]!;
  check(wikiRequest.context?.type === "wiki_page" && wikiRequest.context.id === wikiPage.id && wikiRequest.context.title === "Handbook", `wiki context wrong: ${JSON.stringify(wikiRequest.context)}`);
  console.log("sidecar ok: wiki page context sent");

  // Same chat and history as the AI page: the chat shows up in Recents there.
  await panel.getByRole("button", { name: translate("sidecar.history") }).click();
  await panel.getByRole("menuitem", { name: "Earlier AI page chat" }).click();
  await panel.getByText("Answer from the AI page").waitFor();
  await page.screenshot({ path: `${shots}/sidecar-wiki-1440.png` });

  // Width: drag the left edge, reload, still there; another user keeps the default.
  const box = (await panel.boundingBox())!;
  const startWidth = Math.round(box.width);
  await page.mouse.move(box.x, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, box.y + 300, { steps: 6 });
  await page.mouse.up();
  const widened = Math.round((await panel.boundingBox())!.width);
  check(widened > startWidth + 100, `drag did not widen the panel: ${startWidth} -> ${widened}`);
  await page.screenshot({ path: `${shots}/sidecar-resized-1440.png` });
  await page.reload();
  await page.getByRole("button", { name: translate("sidecar.open"), exact: true }).first().click();
  await panel.waitFor();
  const afterReload = Math.round((await panel.boundingBox())!.width);
  check(Math.abs(afterReload - widened) <= 1, `width not persisted: ${widened} -> ${afterReload}`);
  const stored = await page.evaluate((id) => localStorage.getItem(`weft.sidecar.width.${id}`), userId);
  check(stored !== null, "width not stored under the user id");
  await page.evaluate((id) => { localStorage.removeItem(`weft.sidecar.width.${id}`); }, userId);
  console.log("sidecar ok: width resizes and persists per user");

  // Phone width: full screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("button", { name: translate("sidecar.open") }).click();
  await composer.waitFor();
  const phone = (await panel.boundingBox())!;
  check(Math.round(phone.width) === 390 && Math.round(phone.height) === 844, `panel not full screen at 390px: ${phone.width}x${phone.height}`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal page scroll at 390px");
  await page.screenshot({ path: `${shots}/sidecar-390.png` });

  console.log("e2e sidecar: ok");
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
