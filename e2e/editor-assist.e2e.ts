// Browser end-to-end flow: AI assist menu and Assist preview in the work item description, a comment, and the wiki page editor.
// The model is mocked: the browser's POST /api/ai/assist is answered by the test, so no provider is ever called.
// Run with `bun e2e/editor-assist.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Locator } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31187);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52187);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
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

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  const requests: Array<Record<string, unknown>> = [];
  // The real API reports the key as missing in CI, which would replace the task buttons with the not-configured message.
  await context.route("**/api/ai/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ provider: "openai", model: "mock", key: "present", configured: true, canAssist: true }) }));
  await context.route("**/api/ai/assist", async (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "Mocked rewrite" }) });
  });

  await page.goto(web);
  await page.getByLabel(translate("auth.name")).fill("Assist Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
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
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  await call("create_work_item", { projectId: project.id, title: "Assist target" });
  const wikiPage = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Assist notes" });

  /** Type text, select it all, and run Rephrase; the preview shows the mocked answer and the document is untouched. */
  async function preview(editor: Locator, host: Locator, text: string) {
    await editor.click();
    await page.keyboard.type(text);
    await page.keyboard.press("Control+a");
    await host.getByRole("toolbar", { name: translate("assist.menu") }).getByRole("button", { name: translate("assist.task.rephrase") }).click();
    const result = host.getByRole("region", { name: translate("assist.preview") });
    await result.getByTestId("assist-result").getByText("Mocked rewrite").waitFor();
    check((await editor.innerText()).includes(text), "document changed before the Assist preview was accepted");
    return result;
  }
  /** Discard leaves the text; Replace swaps it for the answer; Insert below keeps the original and adds the answer. */
  async function exercise(editor: Locator, host: Locator, label: string) {
    let result = await preview(editor, host, `${label} original`);
    await result.getByRole("button", { name: translate("assist.discard") }).click();
    await result.waitFor({ state: "detached" });
    check((await editor.innerText()).trim() === `${label} original`, `${label}: discard changed the text`);

    await page.keyboard.press("Control+a");
    await host.getByRole("toolbar", { name: translate("assist.menu") }).getByRole("button", { name: translate("assist.task.rephrase") }).click();
    result = host.getByRole("region", { name: translate("assist.preview") });
    await result.getByTestId("assist-result").waitFor();
    await result.getByRole("button", { name: translate("assist.insertBelow") }).click();
    await result.waitFor({ state: "detached" });
    check((await editor.innerText()).replace(/\s+/g, " ").trim() === `${label} original Mocked rewrite`, `${label}: insert below result was ${await editor.innerText()}`);

    await page.keyboard.press("Control+a");
    await host.getByRole("toolbar", { name: translate("assist.menu") }).getByRole("button", { name: translate("assist.task.rephrase") }).click();
    await host.getByRole("region", { name: translate("assist.preview") }).getByRole("button", { name: translate("assist.replace") }).click();
    await host.getByRole("region", { name: translate("assist.preview") }).waitFor({ state: "detached" });
    check((await editor.innerText()).trim() === "Mocked rewrite", `${label}: replace result was ${await editor.innerText()}`);
  }

  // Work item description.
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const description = page.getByTestId("description-editor");
  await description.locator(".ProseMirror").waitFor();
  await exercise(description.locator(".ProseMirror"), description, "Description");
  console.log("editor-assist ok: description");

  // Comment editor: same menu, same preview; the replaced text posts as the comment.
  const commentHost = page.getByTestId("comment-editor").last();
  await exercise(commentHost.locator(".ProseMirror"), commentHost, "Comment");
  await page.keyboard.press("End"); // collapse the selection so the bubble menu does not cover the submit button
  await page.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  await page.locator("li[id^=comment-]").getByText("Mocked rewrite").waitFor();
  console.log("editor-assist ok: comment");

  // Wiki editor: Replace is an ordinary edit, so it autosaves and a second open editor loads it.
  await page.goto(`${web}/${slug}/wiki/${wikiPage.id}`);
  const wiki = page.getByTestId("wiki-editor");
  await wiki.locator(".ProseMirror").waitFor();
  await exercise(wiki.locator(".ProseMirror"), wiki, "Wiki");
  await page.getByText(translate("wiki.saved")).waitFor({ timeout: 10_000 });
  const other = await context.newPage();
  await other.goto(`${web}/${slug}/wiki/${wikiPage.id}`);
  await other.getByTestId("wiki-editor").locator(".ProseMirror", { hasText: "Mocked rewrite" }).waitFor();
  console.log("editor-assist ok: wiki, replace reaches a second editor");

  check(requests.length >= 9 && requests.every((body) => body.workspaceId === workspaceId && body.task === "rephrase"), "unexpected assist requests");
  console.log("e2e editor-assist: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
