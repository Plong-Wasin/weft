// Browser end-to-end flow for the work item timeline: the Comments / Activity / All filter (default Comments, remembered per viewer
// across work items and reloads) and the comment composer pinned at the bottom of the feed.
// Run with `CHROMIUM_PATH=... bun e2e/run-all.ts timeline-filter`, or `bun e2e/timeline-filter.e2e.ts` against a database made with --keep.
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3117);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5217);
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

type Item = { id: string; displayId: string; title: string };
let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `tl-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };

  // Sign up, create a workspace and a project through the UI, as a person would.
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Timeline Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Timeline team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Timeline");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("TLN");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /TLN · Timeline/ }).waitFor();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  const projectId = project!.id;
  const alpha = await call<Item>("create_work_item", { projectId, title: "Alpha" });
  const bravo = await call<Item>("create_work_item", { projectId, title: "Bravo" });
  // Activity: a priority change. Comments: one on Alpha, then enough to make its feed taller than the window.
  await call("update_work_item", { workItemId: alpha.id, priority: "high" });
  await call("create_comment", { workItemId: alpha.id, bodyMarkdown: "First comment on Alpha" });
  for (let index = 1; index <= 14; index += 1) await call("create_comment", { workItemId: alpha.id, bodyMarkdown: `Filler comment ${index}` });

  const filterName = translate("timeline.filter", "en");
  const filter = () => page.getByRole("combobox", { name: filterName, exact: true });
  const commentsOption = translate("timeline.comments", "en");
  const activityOption = translate("timeline.activity", "en");
  const allOption = translate("timeline.all", "en");
  const createdText = translate("workItems.activity.created", "en");
  const timeline = () => page.locator("section").filter({ has: page.getByRole("heading", { name: translate("timeline.title", "en"), exact: true }) });
  const openItem = async (displayId: string) => { await page.goto(`${web}/${slug}/browse/${displayId}`); await timeline().waitFor(); await filter().waitFor(); };
  // The feed as the person sees it: an activity line names "created", a comment shows its body text.
  const feedHas = async (text: string) => await timeline().getByText(text, { exact: false }).count() > 0;
  // The feed reloads after a filter change: wait for the expected rows instead of reading the feed mid-load.
  const feedShows = async (text: string, shown: boolean) => { for (let attempt = 0; attempt < 50; attempt += 1) { if (await feedHas(text) === shown) return true; await Bun.sleep(100); } return false; };
  const selected = async () => await filter().inputValue();

  // Default view: a fresh viewer sees only Comments.
  await page.evaluate(() => localStorage.clear());
  await openItem(alpha.displayId);
  check(await selected() === "comments", "the timeline filter must default to Comments");
  check(await feedShows("First comment on Alpha", true), "Comments view must show the comment");
  check(await feedShows(createdText, false), "Comments view must hide the Activity entries");

  // Activity shows the change log and no comments; All shows both.
  await filter().selectOption("updates");
  check(await feedShows(createdText, true), "Activity view must show the Activity entries");
  check(await feedShows("First comment on Alpha", false), "Activity view must hide the comments");
  await filter().selectOption("all");
  check(await feedShows(createdText, true) && await feedShows("First comment on Alpha", true), "All view must show both comments and Activity");

  // The option labels are the ticket's: Comments, Activity, All.
  const optionLabels = await filter().locator("option").allTextContents();
  check(optionLabels.join("|") === [commentsOption, activityOption, allOption].join("|"), `filter options must be Comments, Activity, All, found ${optionLabels.join(", ")}`);

  // The chosen filter persists across reloads and across Work items for this viewer.
  await filter().selectOption("updates");
  await page.reload();
  await timeline().waitFor();
  check(await selected() === "updates", "the chosen filter must survive a reload");
  await openItem(bravo.displayId);
  check(await selected() === "updates", "the chosen filter must carry over to another Work item");
  check(await feedShows(createdText, true), "Activity view on Bravo must show Bravo's Activity entry");
  // Back to the default for the next checks.
  await filter().selectOption("comments");
  await openItem(alpha.displayId);
  check(await selected() === "comments", "the Comments choice must persist when returning to Alpha");
  check(await feedShows("First comment on Alpha", true), "Comments view on Alpha must show the comment");

  // The composer stays reachable at the bottom while the feed scrolls.
  // Scroll the page so the feed fills the window and the composer's own place is far below it.
  const composer = () => page.getByTestId("comment-editor").last();
  await page.getByText("Filler comment 14", { exact: false }).first().scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -300));
  const box = await composer().boundingBox();
  const viewport = page.viewportSize()!;
  check(box !== null && box.y >= 0 && box.y + box.height <= viewport.height + 1, `the composer must stay in the viewport while the feed scrolls, box ${JSON.stringify(box)}`);
  // The composer posts a comment from where it sits.
  await composer().locator(".ProseMirror").click();
  await page.keyboard.type("Typed while pinned");
  await page.getByRole("button", { name: translate("comments.add", "en"), exact: true }).last().click();
  await timeline().getByText("Typed while pinned", { exact: false }).waitFor();
  check(await feedShows("Typed while pinned", true), "a comment typed in the pinned composer must post to the feed");

  console.log("timeline-filter e2e: default Comments, Activity and All views, persistence across reload and Work items, composer pinned");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  process.exit(failed ? 1 : 0);
}
