// Input that arrives before an editor's data does: the Wiki editor takes none before its first sync,
// and an "@" typed before the member list arrives still opens the mention list once it does.
import { translate } from "../packages/shared/src";
import { check, createSignedInContext, launchBrowser, startApi, startLive, startWeb, waitFor } from "./harness";
import type { Page } from "playwright";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31490);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52490);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31491);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startLive(livePort, web),
  startWeb(webPort, { api, live: `ws://localhost:${livePort}`, env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true" } }),
];

/** Holds the answers of one action until the returned function is called. */
async function holdAction(page: Page, action: string) {
  const gate = Promise.withResolvers<void>();
  await page.route(`**/actions/${action}`, async (route) => { await gate.promise; await route.continue(); });
  return () => gate.resolve();
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 } }, api, web, {
    account: { name: "Early Typist", email: `${slug}@example.test` },
    workspace: { name: "Early team", slug },
    project: { name: "Mobile", key: "MOB", visibility: "public", shape: "simple" },
  });
  const setup = await context.newPage();
  const call = async <T>(name: string, body: unknown) => await (await setup.request.post(`${api}/actions/${name}`, { data: body, headers: { origin: web } })).json() as T;
  const me = await (await setup.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const projects = await call<Array<{ id: string; key: string }>>("list_projects", { workspaceId });
  await call("create_work_item", { projectId: projects.find((row) => row.key === "MOB")!.id, title: "Mention target" });
  const line = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const { id: pageId } = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "Early input", content: { type: "doc", content: [line("First stored line"), line("Last stored line")] } });

  // The first sync is held back: the live server's messages wait until released.
  {
    const page = await context.newPage();
    const held: Array<string | Buffer> = [];
    let release: (() => void) | null = null;
    let open = false;
    await page.routeWebSocket(new RegExp(`localhost:${livePort}`), (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => { if (open) socket.send(message); else held.push(message); });
      release = () => { open = true; for (const message of held.splice(0)) socket.send(message); };
    });
    await page.goto(`${web}/${slug}/wiki/${pageId}`);
    const editor = page.getByTestId("wiki-editor").locator(".ProseMirror");
    await editor.waitFor();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("Early words");
    const before = await editor.innerText();
    const editable = await editor.getAttribute("contenteditable");
    release!();
    await editor.getByText("Last stored line").waitFor();
    if (Bun.env.PROBE) console.log("probe", JSON.stringify({ editable, before, after: await editor.locator("p").allTextContents() }));
    check(editable === "false", "wiki: the editor must not be editable before its first sync");
    check(!before.includes("Early words"), "wiki: the editor took text before its first sync");
    await editor.and(page.locator('[contenteditable="true"]')).waitFor();
    await editor.getByText("Last stored line").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and more");
    check(JSON.stringify(await editor.locator("p").allTextContents()) === JSON.stringify(["First stored line", "Last stored line and more"]), "wiki: typing after the sync must land at the caret");
    await page.close();
    console.log("case passed: the Wiki editor takes no input before its first sync");
  }

  // "@" typed before the member list arrives.
  for (const target of [
    { label: "wiki", action: "list_wiki_page_mentionable_members", path: `wiki/${pageId}`, testId: "wiki-editor", ready: "Last stored line" },
    { label: "comment", action: "list_mentionable_members", path: "browse/MOB-1", testId: "comment-editor", ready: null },
  ]) {
    const page = await context.newPage();
    const release = await holdAction(page, target.action);
    await page.goto(`${web}/${slug}/${target.path}`);
    const editor = page.getByTestId(target.testId).locator(".ProseMirror");
    if (target.ready) await editor.getByText(target.ready).click();
    else await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" @");
    release();
    const list = page.getByRole("listbox", { name: translate("wiki.mentionMembers"), exact: true });
    await list.getByRole("option", { name: "Early Typist" }).waitFor({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    await editor.locator(".mention", { hasText: "Early Typist" }).waitFor();
    await page.close();
    console.log(`case passed: ${target.label} "@" before the member list`);
  }
  console.log("editor-before-ready: all cases passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  process.exit(failed ? 1 : 0);
}
