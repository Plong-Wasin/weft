// Browser end-to-end flow: AI chat shows the work items an Autopilot answer or an approved proposal made, as linked rows that survive a reload.
// The model is a scripted fake (apps/api/test/fixtures/fake-ai-server.ts): no provider key, no network.
// Run with `bun e2e/run-all.ts ai-result-rows`. Screenshots go to .local/shots/shadcn-finish-11/.
import { chromium, type Browser, type Page } from "playwright";
import { eq, like } from "drizzle-orm";
import { confirmations, createDatabase, users, workspaces } from "../packages/db/src";
import { createChatStore } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31207);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = `${import.meta.dir}/../.local/shots/shadcn-finish-11`;
const env: Record<string, string | undefined> = { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api };
delete env.OPENAI_API_KEY;
delete env.ANTHROPIC_API_KEY;
const servers = [
  Bun.spawn(["bun", "apps/api/test/fixtures/fake-ai-server.ts"], { env, stdout: "inherit", stderr: "inherit" }),
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
let browser: Browser | undefined;
const { client, db } = createDatabase();

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(error));
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed with HTTP ${response.status()}`);
    return await response.json() as T;
  };
  const signup = await page.request.post(`${api}/api/auth/sign-up/email`, { data: { name: "AI Tester", email, password: "a-secure-password" } });
  check(signup.ok(), `sign-up failed with HTTP ${signup.status()}`);
  const { id: workspaceId } = await call<{ id: string }>("create_workspace", { name: "E2E team", slug });
  const project = await call<{ id: string }>("create_project", { workspaceId, name: "Mobile", key: "MOB", visibility: "private" });
  await call("set_autopilot_setting", { workspaceId, allowAutopilot: true });

  const ask = async (mode: "autopilot" | "build", text: string) => {
    await page.goto(`${web}/${slug}/ai`, { waitUntil: "commit" });
    const select = page.getByRole("combobox", { name: translate("ai.mode") });
    await select.locator(`option[value="${mode}"]`).waitFor({ state: "attached" });
    await select.selectOption(mode);
    await page.getByRole("textbox", { name: translate("ai.message") }).fill(text);
    await page.getByRole("button", { name: translate("ai.send") }).click();
  };
  const rows = (target: Page = page) => target.locator("[data-results] li");
  const chatUrl = async () => {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const [newest] = await createChatStore(db).listChats(user!.id, workspaceId);
    return { url: `${web}/${slug}/ai/${newest!.id}`, id: newest!.id };
  };
  /** The row is one link with display id and title; it opens the work item, and is there again after a reload. */
  const checkLinked = async (url: string, title: string) => {
    const link = () => page.locator("[data-results]").getByRole("link", { name: new RegExp(`MOB-\\d+ ?${title}`) });
    await link().waitFor();
    // Parallel creates take their numbers in any order, so read the one this row shows.
    const displayId = /MOB-\d+/.exec((await link().textContent())!)![0];
    check((await link().boundingBox())!.height >= 44, "row is under 44px");
    await link().click();
    await page.waitForURL(`${web}/${slug}/browse/${displayId}`);
    await page.getByText(title).first().waitFor();
    await page.goto(url, { waitUntil: "commit" });
    await link().waitFor();
    await page.reload({ waitUntil: "commit" });
    await link().waitFor();
    // The display id written in the answer text links too.
    await page.locator('[data-role="assistant"]').getByRole("link", { name: displayId, exact: true }).first().waitFor();
  };

  const longTitle = "ตรวจสอบขั้นตอนชำระเงินและการจัดส่งสำหรับคำสั่งซื้อที่มีสินค้าหลายรายการจากหน้าร้านออนไลน์";
  await ask("autopilot", `create ${project.id} SIT login | SIT register | ${longTitle}`);
  await page.getByText("Done:").waitFor();
  await page.getByRole("status").filter({ hasText: translate("ai.autopilot.done") }).waitFor();
  await rows().nth(2).waitFor();
  check(await page.locator("[data-results]").count() === 1, "three creates are not one list");
  check(await page.getByText("create_work_item").count() === 0, "a raw tool name is shown");
  const autopilot = await chatUrl();
  await checkLinked(autopilot.url, "SIT login");
  console.log("ai-result-rows ok: Autopilot rows link, open and survive reload");

  await ask("build", `create ${project.id} Approved task`);
  await page.getByRole("button", { name: translate("ai.confirmAll"), exact: true }).click();
  await page.getByRole("status").filter({ hasText: translate("ai.confirm.confirmed") }).waitFor();
  await page.getByText("Done:").waitFor();
  const approved = await chatUrl();
  await checkLinked(approved.url, "Approved task");
  console.log("ai-result-rows ok: approved proposal links, opens and survives reload");

  // A deleted item is marked and is not a link; an action with no target and an old result keep a readable label.
  const [second] = await call<Array<{ id: string; title: string }>>("list_work_items", { projectId: project.id, query: 'title ~ "register"' });
  await call("delete_work_item", { workItemId: second!.id });
  await createChatStore(db).saveMessage(autopilot.id, { id: crypto.randomUUID(), role: "assistant", parts: [
    { type: "tool-create_view", toolCallId: "v", state: "output-available", input: {}, output: JSON.stringify({ status: "done", action: "create_view", result: { id: crypto.randomUUID() } }) },
    { type: "tool-create_work_item", toolCallId: "old", state: "output-available", input: {}, output: JSON.stringify({ status: "done", action: "create_work_item" }) },
  ] });
  await page.goto(autopilot.url, { waitUntil: "commit" });
  const deleted = rows().filter({ hasText: "SIT register" });
  await deleted.getByText(translate("ai.result.status.deleted")).waitFor();
  check(await deleted.getByRole("link").count() === 0, "a deleted work item is still a link");
  await rows().filter({ hasText: translate("ai.action.create_view") }).waitFor();
  await rows().filter({ hasText: translate("ai.action.create_work_item") }).waitFor();
  console.log("ai-result-rows ok: deleted and target-less rows");

  const state = await context.storageState();
  for (const locale of ["en", "th"] as const) {
    await call("set_my_locale", { locale });
    for (const colorScheme of ["light", "dark"] as const) {
      for (const [width, height] of [[1440, 900], [390, 844]] as const) {
        const view = await browser.newContext({ viewport: { width, height }, colorScheme, storageState: state, hasTouch: width < 500, isMobile: width < 500 });
        view.setDefaultTimeout(60_000);
        const shot = await view.newPage();
        for (const [name, url] of [["autopilot", autopilot.url], ["approved", approved.url]] as const) {
          await shot.goto(url, { waitUntil: "commit" });
          await shot.locator("[data-results]").first().getByRole("link").first().waitFor();
          await shot.locator('[data-role="assistant"]').getByRole("link", { name: /^MOB-\d+$/ }).first().waitFor();
          await shot.locator(`html[lang="${locale}"][data-theme="${colorScheme}"]`).waitFor({ state: "attached" });
          check(await shot.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal scroll at ${width}px`);
          const heights = await rows(shot).evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
          check(heights.every((value) => value >= 44 && value < 48), `uneven or small rows at ${width}px: ${heights.join(",")}`);
          if (name === "autopilot" && width === 390) {
            const title = shot.locator("[data-results]").getByText(longTitle, { exact: true });
            check(await title.evaluate((element) => element.scrollWidth > element.clientWidth && element.getAttribute("title") === element.textContent), "the long Thai title is not truncated with its full text available");
          }
          await shot.screenshot({ path: `${shots}/${name}-${width}-${colorScheme}-${locale}.png` });
        }
        await view.close();
      }
    }
  }

  // Old confirmed proposals may have kept the decision without an action result: the card stays, in plain words, with no link.
  await call("set_my_locale", { locale: "en" });
  await db.update(confirmations).set({ result: null }).where(eq(confirmations.chatId, approved.id));
  await page.goto(approved.url, { waitUntil: "commit" });
  const legacy = page.locator('[data-status="confirmed"][data-action="create_work_item"]');
  await legacy.waitFor();
  await legacy.getByText(translate("ai.confirm.confirmed")).waitFor();
  check(await legacy.getByRole("link").count() === 0, "an old confirmed proposal without a result has a link");
  check(await page.locator("[data-results]").count() === 0, "an old confirmed proposal without a result became a result list");
  check(!await legacy.getByText("create_work_item", { exact: true }).isVisible(), "an old confirmed proposal shows a raw tool name");

  console.log("e2e ai-result-rows: ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
