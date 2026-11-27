// Browser end-to-end flow for saved Views: save from the filter and display bars, reopen exactly, update, create and delete.
// Run with `bun e2e/views.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3109);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5209);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("10-saved-views-project");
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

type View = { id: string; name: string; query: string; layout: string; groupBy: string; orderBy: string; orderDirection: string; properties: string[]; access: string };
let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 } }, api, web, {
    account: { name: "Views Tester", email: `${slug}@example.test` },
    workspace: { name: "E2E team", slug },
    project: { name: "Mobile", key: "MOB", visibility: "public", shape: "simple" },
  });
  const page = await context.newPage();
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); check(response.ok(), `${name} failed: ${response.status()}`); return await response.json() as T; };
  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  for (const [title, priority] of [["Alpha urgent", "urgent"], ["Bravo high", "high"], ["Charlie low", "low"]]) await call("create_work_item", { projectId: project!.id, title, priority });

  // Empty Views page first.
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.route(`${api}/actions/list_views`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) }), { times: 1 });
  await page.getByRole("navigation", { name: `${translate("projectNav.label")} MOB` }).getByRole("link", { name: translate("projectNav.views") }).click();
  await page.getByRole("alert").filter({ hasText: translate("views.loadFailed") }).waitFor();
  await page.getByRole("button", { name: translate("views.retry") }).click();
  await page.getByRole("status").filter({ hasText: translate("views.empty") }).waitFor();

  // Shape the work item list with the filter and display bars, then save it.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: "Charlie low" }).waitFor();
  await page.getByRole("button", { name: translate("layout.filterQuery.toggle") }).click();
  await page.getByRole("textbox", { name: translate("layout.filterQuery.label") }).fill("priority IN (urgent, high)");
  await page.getByRole("button", { name: translate("layout.filterQuery.apply") }).click();
  await page.getByRole("link", { name: "Charlie low" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("priority");
  await page.getByLabel(translate("layout.sort")).selectOption("title");
  await page.getByLabel(translate("layout.direction")).selectOption("desc");
  await page.getByRole("checkbox", { name: translate("layout.property.labels"), exact: true }).click();
  await page.keyboard.press("Escape");
  const shaped = new URL(page.url()).search;
  await page.getByRole("button", { name: translate("views.saveAs") }).click();
  const saveDialog = page.getByRole("dialog", { name: translate("views.form.saveTitle") });
  const saveName = saveDialog.getByLabel(translate("views.name"));
  const focusState = await saveDialog.evaluate((element) => ({ tag: element.tagName, open: (element as HTMLDialogElement).open, active: document.activeElement?.outerHTML.slice(0, 180), field: element.querySelector("input")?.outerHTML }));
  check(await saveName.evaluate((element) => element === document.activeElement), `saved view dialog did not focus its first field: ${JSON.stringify(focusState)}`);
  check(focusState.tag === "DIALOG" && focusState.open, `saved view form is not a native modal dialog: ${JSON.stringify(focusState)}`);
  for (let index = 0; index < 6; index += 1) await page.keyboard.press("Tab");
  check(await saveName.evaluate((element) => element === document.activeElement), "Tab did not wrap within the saved view dialog");
  await page.keyboard.press("Escape");
  const restoreState = await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 220), dialogOpen: [...document.querySelectorAll("dialog")].map((element) => (element as HTMLDialogElement).open) }));
  check(await page.getByRole("button", { name: translate("views.saveAs") }).evaluate((element) => element === document.activeElement), `Escape did not return focus to Save as view: ${JSON.stringify(restoreState)}`);
  await page.getByRole("button", { name: translate("views.saveAs") }).click();
  await page.getByRole("dialog", { name: translate("views.form.saveTitle") }).getByLabel(translate("views.name")).fill("Hot items");
  await page.getByRole("dialog").getByLabel(translate("views.description")).fill("Urgent and high");
  await page.getByRole("dialog").getByRole("button", { name: translate("views.create") }).click();
  await page.waitForURL(/\/views\/[0-9a-f-]{36}/);

  // Stored exactly: filter query, layout, group by, order by, visible properties.
  const [saved] = await call<View[]>("list_views", { projectId: project!.id });
  check(saved?.name === "Hot items" && saved.query === "priority IN (urgent, high)" && saved.layout === "list" && saved.groupBy === "priority" && saved.orderBy === "title" && saved.orderDirection === "desc"
    && !saved.properties.includes("labels") && saved.properties.includes("state") && saved.access === "public", `stored view was ${JSON.stringify(saved)}`);
  // It reopens exactly: same URL settings, same rows, same grouping, via link, bare URL and reload.
  const settingsOf = () => new URL(page.url()).search;
  await page.getByRole("region", { name: translate("workItems.priority.urgent") }).getByRole("link", { name: "Alpha urgent" }).waitFor();
  await page.waitForURL((url) => url.search === shaped);
  check(settingsOf() === shaped, `opened with ${settingsOf()}, saved from ${shaped}`);
  check(await page.getByRole("link", { name: "Charlie low" }).count() === 0, "filter not applied");
  const reopen = async (how: string) => {
    await page.getByRole("region", { name: translate("workItems.priority.high") }).getByRole("link", { name: "Bravo high" }).waitFor();
    await page.waitForURL((url) => url.search === shaped);
    check(settingsOf() === shaped, `${how}: settings ${settingsOf()} != ${shaped}`);
    check(await page.getByTestId("row-MOB-1").getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }).count() === 0, `${how}: labels property shown`);
    check(await page.getByRole("button", { name: translate("views.update") }).count() === 0, `${how}: Update view shown for an unchanged view`);
  };
  await reopen("after save");
  const viewPath = new URL(page.url()).pathname;
  await page.goto(`${web}${viewPath}`); await reopen("bare URL");
  await page.reload(); await reopen("reload");
  await page.goto(`${web}/${slug}/projects/MOB/views`);
  await page.getByTestId("view-row-Hot items").getByRole("link", { name: "Hot items" }).click(); await reopen("from the Views page");

  // Update view: change the grouping, the button appears, saving stores it.
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("state");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: translate("views.update") }).click();
  await page.getByRole("status").filter({ hasText: translate("views.updated") }).waitFor();
  await page.getByRole("button", { name: translate("views.update") }).waitFor({ state: "detached" });
  check((await call<View>("get_view", { viewId: saved!.id })).groupBy === "state", "Update view did not store the grouping");
  await page.screenshot({ path: `${shots}/view-detail-1440.png` });

  // Views page: row details, edit to private, create and delete.
  await page.goto(`${web}/${slug}/projects/MOB/views`);
  const row = page.getByTestId("view-row-Hot items");
  await row.getByText("Urgent and high").waitFor();
  await row.getByRole("button", { name: translate("views.menu") }).click();
  await page.getByRole("menuitem", { name: translate("views.edit") }).click();
  await page.getByRole("dialog").getByLabel(translate("views.access")).selectOption("private");
  await page.getByRole("dialog").getByRole("button", { name: translate("views.save") }).click();
  await row.getByLabel(translate("views.access.private")).waitFor();
  check((await call<View>("get_view", { viewId: saved!.id })).access === "private", "edit did not store private");
  await page.getByRole("button", { name: translate("views.add") }).click();
  await page.getByRole("dialog", { name: translate("views.form.createTitle") }).getByLabel(translate("views.name")).fill("Scratch");
  await page.getByRole("dialog").getByRole("button", { name: translate("views.create") }).click();
  const scratch = page.getByTestId("view-row-Scratch");
  await scratch.waitFor();
  check((await call<View[]>("list_views", { projectId: project!.id })).length === 2, "create did not store");
  await page.screenshot({ path: `${shots}/views-1440.png` });
  await scratch.getByRole("button", { name: translate("views.menu") }).click();
  await page.getByRole("menuitem", { name: translate("views.delete") }).click();
  await page.getByRole("dialog").getByRole("button", { name: translate("views.deleteAction") }).click();
  await scratch.waitFor({ state: "detached" });
  check((await call<View[]>("list_views", { projectId: project!.id })).map((view) => view.name).join() === "Hot items", "delete did not remove the view");
  check(await call<unknown[]>("list_work_items", { projectId: project!.id }).then((items) => items.length) === 3, "deleting a view changed work items");

  // A deleted View is gone for good: its URL says not found.
  await page.goto(`${web}${viewPath.replace(saved!.id, crypto.randomUUID())}`);
  await page.getByRole("alert").filter({ hasText: translate("views.notFound") }).waitFor();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}/${slug}/projects/MOB/views`);
  await page.getByTestId("view-row-Hot items").waitFor();
  await page.screenshot({ path: `${shots}/views-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/projects/MOB/views`);
  await page.getByTestId("view-row-Hot items").waitFor();
  await page.screenshot({ path: `${shots}/views-390.png` });
  await page.getByRole("button", { name: translate("views.add") }).click();
  const mobileDialog = page.getByRole("dialog", { name: translate("views.form.createTitle") });
  const mobileBounds = await mobileDialog.boundingBox();
  check(!!mobileBounds && mobileBounds.x >= 0 && mobileBounds.y >= 0 && mobileBounds.x + mobileBounds.width <= 390 && mobileBounds.y + mobileBounds.height <= 844, `mobile dialog is outside the viewport: ${JSON.stringify(mobileBounds)}`);
  await page.keyboard.press("Escape");
  await mobileDialog.waitFor({ state: "detached" });
  await page.goto(`${web}${viewPath}`);
  await page.getByRole("link", { name: "Bravo high" }).waitFor();
  await page.screenshot({ path: `${shots}/view-detail-390.png` });
  console.log("e2e views: ok");
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
