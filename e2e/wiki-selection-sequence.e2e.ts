// Browser case for ticket 22: triple-click a Wiki paragraph, ArrowRight, Ctrl+End, Enter must not drop the paragraph; the text is still there after a reload.
import { chromium, type Browser } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31163);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52163);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31183);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const liveHttp = `http://localhost:${livePort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];
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
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Sequence Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Sequence team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL((url) => url.pathname.includes(slug));

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  // Keys go out back to back (no pause), the fast input that broke this sequence before the fix; the paragraph must stay in the editor and after a reload.
  const variants = [
    { name: "first", content: [paragraph("Target paragraph text"), paragraph("After line")] },
    { name: "middle", content: [paragraph("Before line"), paragraph("Target paragraph text"), paragraph("After line")] },
    { name: "last", content: [paragraph("Before line"), paragraph("Target paragraph text")] },
  ];
  for (const variant of variants) {
    const title = `Sequence ${variant.name}`;
    await call("create_wiki_page", { workspaceId, title, content: { type: "doc", content: variant.content } });
    const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId });
    const wiki = pages.find((row) => row.title === title)!;

    await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
    const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
    const target = wikiEditor.getByText("Target paragraph text", { exact: true });
    await target.waitFor();
    const paragraphs = () => wikiEditor.locator("p").allInnerTexts();

    await target.click({ clickCount: 3 });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await Bun.sleep(500);
    const afterKeys = await paragraphs();
    check(afterKeys.includes("Target paragraph text"), `${variant.name}: paragraph disappeared from the editor: ${JSON.stringify(afterKeys)}`);

    // The save reaches the server: reload and read the paragraph back.
    await page.waitForTimeout(2_000);
    await page.reload();
    await wikiEditor.getByText("Target paragraph text", { exact: true }).waitFor();
    const reloaded = await paragraphs();
    check(reloaded.includes("Target paragraph text"), `${variant.name}: paragraph is gone after reload: ${JSON.stringify(reloaded)}`);
    console.log(`PASS ${variant.name}: paragraph kept after triple-click, ArrowRight, Ctrl+End, Enter, and after reload`);
  }

  // The same fast key sequence in a Work item description: the shared selection sync must keep the paragraph there too.
  const project = await call<{ id: string }>("create_project", { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  const item = await call<{ displayId: string }>("create_work_item", { projectId: project.id, title: "Sequence item", description: { type: "doc", content: [paragraph("Before line"), paragraph("Target paragraph text"), paragraph("After line")] } });
  await page.goto(`${web}/${slug}/browse/${item.displayId}`);
  const descriptionEditor = page.getByTestId("description-editor").locator(".ProseMirror");
  const descriptionTarget = descriptionEditor.getByText("Target paragraph text", { exact: true });
  await descriptionTarget.waitFor();
  await descriptionTarget.click({ clickCount: 3 });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await Bun.sleep(500);
  const descriptionAfter = await descriptionEditor.locator("p").allInnerTexts();
  check(descriptionAfter.includes("Target paragraph text"), `description: paragraph disappeared from the editor: ${JSON.stringify(descriptionAfter)}`);
  console.log("PASS description: paragraph kept after triple-click, ArrowRight, Ctrl+End, Enter");

  console.log("e2e wiki-selection-sequence: ok");
  await browser.close();
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
