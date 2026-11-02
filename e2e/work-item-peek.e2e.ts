// Browser end-to-end flow for the work item peek panel, full page, inline property editing and the create modal.
// Run with `bun e2e/work-item-peek.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("07-work-item-peek-and-detail");
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

type Item = { id: string; displayId: string; title: string; stateId: string; priority: string; assigneeIds: string[]; labelIds: string[]; parentId: string | null; startDate: string | null; dueDate: string | null; description: unknown };
let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };
  const t = translate as (key: string) => string;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Peek Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
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
  const projectId = project!.id;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const label = await call<{ id: string }>("create_label", { projectId, name: "Bug" });
  const cycle = await call<{ id: string }>("create_cycle", { projectId, name: "Sprint 1", startDate: day(-1), endDate: day(6) });
  const module = await call<{ id: string }>("create_module", { projectId, name: "Auth" });
  const alpha = await call<Item>("create_work_item", { projectId, title: "Alpha" });
  await call<Item>("create_work_item", { projectId, title: "Bravo" });
  await call("add_cycle_items", { cycleId: cycle.id, workItemIds: [alpha.id] });
  await call("add_module_items", { moduleId: module.id, workItemIds: [alpha.id] });
  const stored = async (displayId: string) => await call<Item>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId });
  const peek = page.getByRole("dialog", { name: translate("workItems.peek.title") });
  const base = `${web}/${slug}/projects/MOB`;

  // Peek opens from the list and closes with Escape.
  await page.goto(`${base}/issues`);
  await page.getByRole("link", { name: "Alpha" }).click();
  await peek.waitFor();
  check(page.url().includes("peek=MOB-1"), "the peek is not in the URL");
  await peek.getByRole("heading", { name: "MOB-1" }).waitFor();
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });
  check(!page.url().includes("peek="), "closing the peek left it in the URL");
  // A reload keeps an open peek; the backdrop closes it too.
  await page.getByRole("link", { name: "Alpha" }).click();
  await peek.waitFor();
  await page.reload();
  await peek.waitFor();
  await page.mouse.click(60, 450);
  await peek.waitFor({ state: "detached" });
  // An open dropdown takes the first Escape; the peek takes the second.
  await page.getByRole("link", { name: "Alpha" }).click();
  await peek.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) }).click();
  await page.keyboard.press("Escape");
  await peek.waitFor();
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });

  // Board, Cycle and Module pages open the same peek.
  await page.goto(`${base}/issues?layout=board`);
  await page.getByTestId("card-MOB-1").getByRole("link").click();
  await peek.waitFor();
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });
  for (const where of [`${base}/cycles/${cycle.id}`, `${base}/modules/${module.id}`]) {
    await page.goto(where);
    await page.getByRole("link", { name: "Alpha" }).click();
    await peek.waitFor();
    await page.keyboard.press("Escape");
    await peek.waitFor({ state: "detached" });
  }
  console.log("peek: opens from list, board, cycle, module and closes with Escape");

  // Expand to the full page at the browse-by-key URL, with every section.
  await page.goto(`${base}/issues`);
  await page.getByRole("link", { name: "Alpha" }).click();
  await peek.getByRole("link", { name: translate("workItems.peek.expand") }).click();
  await page.waitForURL(`${web}/${slug}/browse/MOB-1`);
  await page.getByRole("heading", { name: "MOB-1" }).waitFor();
  // Empty sections stay hidden; the action row is the way in.
  const actionRow = page.getByRole("group", { name: translate("workItems.actions") });
  for (const key of ["workItems.addSubItemAction", "workItems.addRelationAction", "workItems.addLinkAction", "workItems.attachAction"] as const) await actionRow.getByRole("button", { name: translate(key) }).waitFor();
  for (const name of [translate("timeline.title"), translate("workItems.properties")]) {
    await page.getByRole("heading", { name }).first().waitFor();
  }
  await page.getByTestId("description-editor").waitFor();
  await page.getByRole("navigation", { name: translate("workItems.breadcrumb") }).waitFor();
  await page.screenshot({ path: `${shots}/page-1440-light.png` });

  // Every sidebar property is editable inline.
  const sidebar = page.getByRole("complementary", { name: translate("workItems.properties") });
  const pick = async (property: string, option: string, role: "menuitemradio" | "menuitemcheckbox" = "menuitemradio") => {
    await sidebar.getByRole("button", { name: new RegExp(`^${property}:`) }).click();
    await page.getByRole(role, { name: option, exact: true }).click();
    await page.keyboard.press("Escape");
  };
  await pick(translate("workItems.state"), "Todo");
  await pick(translate("workItems.priority"), translate("workItems.priority.high"));
  await pick(translate("workItems.assignees"), "Peek Tester", "menuitemcheckbox");
  await pick(translate("workItems.labels"), "Bug", "menuitemcheckbox");
  await sidebar.getByLabel(translate("workItems.startDate")).fill(day(1));
  await sidebar.getByLabel(translate("workItems.dueDate")).fill(day(4));
  await pick(translate("workItems.modules"), "Auth", "menuitemcheckbox"); // removes the existing membership
  await pick(translate("workItems.cycle"), translate("workItems.noCycle"));
  await pick(translate("workItems.parent"), "MOB-2 Bravo");
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).first().fill("Alpha renamed");
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).first().press("Enter");
  await page.getByTestId("description-editor").locator(".ProseMirror").click();
  await page.keyboard.type("Typed in the description");
  await page.waitForResponse((response) => response.url().includes("update_work_item") && response.ok() && (response.request().postData() ?? "").includes("description"));
  await Bun.sleep(300);
  const edited = await stored("MOB-1");
  const states = await call<Array<{ id: string; name: string }>>("list_states", { projectId });
  check(edited.stateId === states.find((state) => state.name === "Todo")!.id, "state did not store");
  check(edited.priority === "high", "priority did not store");
  check(edited.assigneeIds.join() === me.user.id, "assignee did not store");
  check(edited.labelIds.join() === label.id, "label did not store");
  check(edited.startDate === day(1) && edited.dueDate === day(4), "dates did not store");
  check(edited.parentId !== null && edited.title === "Alpha renamed", "parent or title did not store");
  check(JSON.stringify(edited.description).includes("Typed in the description"), "description did not autosave");
  check((await call<Item[]>("list_work_items", { projectId, cycleId: cycle.id })).length === 0, "cycle was not cleared");
  check((await call<Item[]>("list_work_items", { projectId, moduleId: module.id })).length === 0, "module was not cleared");
  await pick(translate("workItems.cycle"), "Sprint 1");
  await pick(translate("workItems.modules"), "Auth", "menuitemcheckbox");
  await Bun.sleep(500);
  check((await call<Item[]>("list_work_items", { projectId, cycleId: cycle.id })).length === 1, "cycle did not store");
  check((await call<Item[]>("list_work_items", { projectId, moduleId: module.id })).length === 1, "module did not store");
  console.log("page: every property edits inline");

  // Sub-work items, relations, comments with replies and the activity timeline.
  await actionRow.getByRole("button", { name: translate("workItems.addSubItemAction") }).click();
  await page.getByRole("textbox", { name: `${translate("workItems.subItems")}: ${translate("workItems.titleField")}` }).fill("Child task");
  await page.locator("form").getByRole("button", { name: translate("workItems.subItems.add") }).click();
  await page.getByRole("link", { name: /Child task/ }).waitFor();
  await actionRow.getByRole("button", { name: translate("workItems.addRelationAction") }).click();
  await page.getByRole("combobox", { name: translate("relations.target") }).selectOption({ label: "MOB-2 Bravo" });
  await page.locator("form").getByRole("button", { name: translate("relations.add"), exact: true }).click();
  await page.getByText(translate("relations.type.blocks")).first().waitFor();
  const commentEditor = '[data-testid="comment-editor"] .ProseMirror';
  await page.locator(commentEditor).first().click();
  await page.keyboard.type("First comment");
  await page.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  await page.getByText("First comment").waitFor();
  await page.getByRole("button", { name: translate("comments.reply"), exact: true }).first().click();
  await page.locator(commentEditor).first().click();
  await page.keyboard.type("A reply");
  await page.getByRole("button", { name: translate("comments.reply"), exact: true }).last().click();
  await page.getByText("A reply").waitFor();
  await page.getByText(translate("workItems.activity.created")).first().waitFor();
  await page.screenshot({ path: `${shots}/page-activity-1440-light.png`, fullPage: true });
  console.log("page: sub-work items, relations, comments with replies and activity");

  // Create modal.
  await page.goto(`${base}/issues`);
  await page.getByRole("button", { name: translate("workItems.addNew"), exact: true }).click();
  const modal = page.getByRole("dialog", { name: translate("workItems.modal.title") });
  await modal.waitFor();
  await modal.getByRole("textbox", { name: translate("workItems.titleField") }).fill("From the modal");
  await modal.getByRole("textbox", { name: translate("workItems.description") }).fill("Line one\nLine two");
  const modalPick = async (property: string, option: string, role: "menuitemradio" | "menuitemcheckbox" = "menuitemradio") => {
    await modal.getByRole("button", { name: new RegExp(`^${property}:`) }).click();
    await page.getByRole(role, { name: option, exact: true }).click();
    if (role === "menuitemcheckbox") await page.keyboard.press("Escape"); // a multi dropdown stays open; a single one already closed
  };
  await modalPick(translate("workItems.priority"), translate("workItems.priority.urgent"));
  await modalPick(translate("workItems.assignees"), "Peek Tester", "menuitemcheckbox");
  await modalPick(translate("workItems.labels"), "Bug", "menuitemcheckbox");
  await modalPick(translate("workItems.cycle"), "Sprint 1");
  await modalPick(translate("workItems.modules"), "Auth", "menuitemcheckbox");
  await modalPick(translate("workItems.modal.parent"), "MOB-2 Bravo");
  await modal.getByLabel(translate("workItems.startDate")).fill(day(2));
  await modal.getByLabel(translate("workItems.dueDate")).fill(day(5));
  await page.screenshot({ path: `${shots}/create-modal-1440-light.png` });
  await modal.getByRole("button", { name: translate("workItems.modal.submit") }).click();
  await modal.waitFor({ state: "detached" });
  await page.getByRole("link", { name: "From the modal" }).waitFor();
  const created = (await call<Item[]>("list_work_items", { projectId })).find((item) => item.title === "From the modal")!;
  check(created.priority === "urgent" && created.assigneeIds.join() === me.user.id && created.labelIds.join() === label.id, "modal priority, assignee or label did not store");
  check(created.parentId !== null && created.startDate === day(2) && created.dueDate === day(5), "modal parent or dates did not store");
  check(JSON.stringify(created.description).includes("Line two"), "modal description did not store");
  check((await call<Item[]>("list_work_items", { projectId, cycleId: cycle.id })).some((item) => item.id === created.id), "modal cycle did not store");
  check((await call<Item[]>("list_work_items", { projectId, moduleId: module.id })).some((item) => item.id === created.id), "modal module did not store");
  // Escape closes an empty modal.
  await page.getByRole("button", { name: translate("workItems.addNew"), exact: true }).click();
  await modal.waitFor();
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached" });
  console.log("modal: creates with parent, labels, assignees, dates, cycle and modules");

  // Narrow screens: the peek goes full screen, the page stacks, the modal fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "From the modal" }).click();
  await peek.waitFor();
  const box = await peek.boundingBox();
  check(!!box && box.width >= 388, `peek is not full screen at 390px (${box?.width})`);
  await page.screenshot({ path: `${shots}/peek-390-light.png` });
  await page.keyboard.press("Escape");
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  await page.getByRole("heading", { name: translate("workItems.properties") }).first().waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page scrolls sideways at 390px");
  await page.screenshot({ path: `${shots}/page-390-light.png`, fullPage: true });
  await page.goto(`${base}/issues`);
  await page.getByRole("button", { name: translate("workItems.addNew"), exact: true }).click();
  await modal.waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "modal scrolls sideways at 390px");
  await page.screenshot({ path: `${shots}/create-modal-390-light.png` });
  // Peek at 1440 for the review shots.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "From the modal" }).click();
  await peek.waitFor();
  await page.screenshot({ path: `${shots}/peek-1440-light.png` });
  // Delete asks first: dismissing the confirmation keeps the work item, accepting deletes it and closes the peek.
  let asked = "";
  page.once("dialog", (dialog) => { asked = dialog.message(); void dialog.dismiss(); });
  await peek.getByRole("button", { name: translate("workItems.delete"), exact: true }).click();
  check(asked === translate("workItems.deleteConfirm"), `delete did not ask for confirmation (${asked})`);
  check(await peek.isVisible(), "dismissing the delete confirmation closed the peek");
  await page.goto(`${base}/issues`);
  await page.getByRole("link", { name: "From the modal" }).waitFor();
  await page.getByRole("link", { name: "From the modal" }).click();
  await peek.waitFor();
  page.once("dialog", (dialog) => void dialog.accept());
  await peek.getByRole("button", { name: translate("workItems.delete"), exact: true }).click();
  await peek.waitFor({ state: "detached" });
  await page.goto(`${base}/issues`);
  await page.getByRole("link", { name: "Alpha" }).waitFor();
  check(await page.getByRole("link", { name: "From the modal" }).count() === 0, "accepting the delete confirmation kept the work item");
  void t;
  console.log("e2e work item peek and detail: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
