// Browser end-to-end flow: opening a work item must not save its description. Only a real edit does.
// Run with `bun e2e/run-all.ts description-no-save-on-load` (needs CHROMIUM_PATH and a database as in docs/agents/testing.md).
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3167);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5267);
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

const text = (value: string, marks?: object[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });
const doc = (...content: object[]) => ({ type: "doc", content });
const fixtures = (userId: string): Record<string, object> => ({
  plain: doc(paragraph(text("Just some plain text"))),
  marks: doc(paragraph(text("bold", [{ type: "bold" }]), text(" and "), text("italic", [{ type: "italic" }]), text(" and "), text("link", [{ type: "link", attrs: { href: "https://example.edu" } }]))),
  mention: doc(paragraph(text("Ping "), { type: "mention", attrs: { id: userId, label: "Load Tester" } }, text(" please"))),
  lists: doc(
    { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("one")), { type: "orderedList", content: [{ type: "listItem", content: [paragraph(text("nested"))] }] }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph(text("done"))] }] },
  ),
  blocks: doc(
    { type: "heading", attrs: { level: 2 }, content: [text("Heading")] },
    { type: "blockquote", content: [paragraph(text("quote"))] },
    { type: "codeBlock", attrs: { language: "javascript" }, content: [text("const a = 1")] },
    { type: "callout", attrs: { color: "#f97316" }, content: [paragraph(text("callout"))] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [paragraph(text("H"))] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("C"))] }] }] },
    { type: "horizontalRule" },
    { type: "paragraph" },
  ),
});

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Load Tester");
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

  const saves: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/actions/update_work_item")) saves.push(request.postData() ?? ""); });
  const editor = page.getByTestId("description-editor").locator(".ProseMirror");
  const status = page.getByTestId("description-save-status");
  const lastEdited = page.getByTestId("description-last-edited");

  for (const [name, description] of Object.entries(fixtures(me.user.id))) {
    const item = await call<{ displayId: string }>("create_work_item", { projectId: project!.id, title: `Load ${name}`, description });
    saves.length = 0;
    await page.goto(`${web}/${slug}/browse/${item.displayId}`);
    await editor.waitFor();
    await page.waitForTimeout(2500);
    // A returning window also reloads the item; that must not save either.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(1500);
    check(saves.length === 0, `${name}: opening the item saved its description (${saves.length} update_work_item requests)`);
    check(await lastEdited.count() === 0, `${name}: opening the item showed a Last edited row`);
    check((await status.textContent())?.trim() === translate("workItems.descriptionSave.saved"), `${name}: save status after load was "${await status.textContent()}"`);
  }

  // A real edit still saves.
  const item = await call<{ displayId: string }>("create_work_item", { projectId: project!.id, title: "Load then type", description: fixtures(me.user.id).lists });
  saves.length = 0;
  await page.goto(`${web}/${slug}/browse/${item.displayId}`);
  await editor.waitFor();
  await page.waitForTimeout(1500);
  check(saves.length === 0, "typing item: saved before any edit");
  await editor.click();
  await page.keyboard.press("Control+End");
  const saved = page.waitForRequest((request) => request.url().endsWith("/actions/update_work_item"));
  await page.keyboard.type("x");
  await saved;
  await page.waitForTimeout(1500);
  check(saves.length === 1, `typing a character sent ${saves.length} saves, expected 1`);
  check(saves[0]!.includes("x"), "the saved description lacks the typed character");
  console.log("e2e description no save on load: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
