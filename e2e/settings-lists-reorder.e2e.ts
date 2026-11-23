// Browser end-to-end flow for reordering the three project settings lists: Labels, Work item types and Custom properties.
// A project Admin reorders each list with the keyboard (Arrow keys on the grip) or the row's Actions menu (Move up / Move down),
// reloads, and sees the order kept. The stored order then shows in the create modal's pickers and in the work item panel.
// Run with `bun e2e/run-all.ts settings-lists-reorder` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { translate } from "../packages/shared/src";
import { paths } from "../apps/web/src/routes";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31168);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52168);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("41-settings-lists-reorder");
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

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
const t = (key: string) => translate(key as never);
const say = (key: string, values: Record<string, string>) => Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), t(key));
let failed = false;

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  mkdirSync(shots, { recursive: true });
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;

  await page.goto(web);
  await page.getByRole("button", { name: t("auth.signUp"), exact: true }).click();
  await page.getByLabel(t("auth.name")).fill("Lists Admin");
  await page.getByLabel(t("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(t("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(t("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: t("auth.signUp") }).click();
  await page.getByLabel(t("workspace.name")).fill("E2E team");
  await page.getByLabel(t("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: t("workspace.create") }).click();
  await page.getByRole("button", { name: t("projects.new"), exact: true }).click();
  await page.getByLabel(t("projects.name")).fill("Mobile");
  await page.getByLabel(t("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: t("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();

  // Seed through the Actions: three labels, two more types on top of Task, and two custom properties that belong to Task.
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const projects = await call<Array<{ id: string; key: string }>>("list_projects", { workspaceId });
  const projectId = projects.find((project) => project.key === "MOB")!.id;
  await call("set_project_features", { projectId, features: { types: true } });
  const labelIds: Record<string, string> = {};
  for (const name of ["Alpha", "Bravo", "Charlie"]) labelIds[name] = (await call<{ id: string }>("create_label", { projectId, name })).id;
  const typeIds: Record<string, string> = {};
  for (const name of ["Bug", "Request"]) typeIds[name] = (await call<{ id: string }>("create_work_item_type", { projectId, name, icon: "task", color: "#dc2626" })).id;
  const taskId = (await call<Array<{ id: string; name: string }>>("list_work_item_types", { projectId })).find((type) => type.name === "Task")!.id;
  const propertyIds: Record<string, string> = {};
  for (const name of ["Area", "Owner team"]) propertyIds[name] = (await call<{ id: string }>("create_custom_property", { projectId, name, kind: "text", typeIds: [taskId] })).id;
  await call("create_work_item", { projectId, title: "Ordered item" });

  const labelRows = (page: Page) => page.locator("ul:has([data-grip])").filter({ has: page.getByRole("button", { name: new RegExp(`${t("sortable.reorder")}: Alpha`) }) }).first().locator("li");
  const rowNames = async (rows: ReturnType<typeof labelRows>) => (await rows.locator("span.flex-1").allTextContents()).map((name) => name.trim()).filter(Boolean);
  const gripOf = (page: Page, name: string) => page.getByRole("button", { name: `${t("sortable.reorder")}: ${name}`, exact: true });
  const settle = async (read: () => Promise<string[]>, expected: string[]) => {
    for (let attempt = 0; attempt < 30 && JSON.stringify(await read()) !== JSON.stringify(expected); attempt += 1) await Bun.sleep(150);
    return JSON.stringify(await read()) === JSON.stringify(expected);
  };

  // 1. Labels: the Admin moves Charlie to the top with the keyboard, reloads, and the order holds.
  await page.goto(`${web}${paths.projectSettings(slug, "MOB", "labels")}`);
  await gripOf(page, "Charlie").waitFor();
  check(await gripOf(page, "Charlie").isEnabled(), "a label grip is disabled for the Admin");
  await gripOf(page, "Charlie").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  check(await settle(() => rowNames(labelRows(page)), ["Charlie", "Alpha", "Bravo"]), `label keyboard reorder did not apply: ${(await rowNames(labelRows(page))).join(",")}`);
  await page.reload();
  await gripOf(page, "Charlie").waitFor();
  check(JSON.stringify(await rowNames(labelRows(page))) === JSON.stringify(["Charlie", "Alpha", "Bravo"]), "label order did not persist across reload");
  await page.screenshot({ path: `${shots}/labels-reordered-1440.png` });
  console.log("PASS labels: keyboard reorder persists after reload");

  // Labels: Move down from the row's Actions menu.
  await page.getByRole("button", { name: `${t("sortable.actions")}: Charlie` }).click();
  await page.getByRole("menuitem", { name: t("sortable.moveDown") }).click();
  check(await settle(() => rowNames(labelRows(page)), ["Alpha", "Charlie", "Bravo"]), "label Move down did not apply");
  await page.reload();
  await gripOf(page, "Alpha").waitFor();
  check(JSON.stringify(await rowNames(labelRows(page))) === JSON.stringify(["Alpha", "Charlie", "Bravo"]), "label Move down did not persist");
  console.log("PASS labels: Move down from the Actions menu persists after reload");

  // Pickers: the create modal's Labels picker lists the labels in the stored order.
  await page.goto(`${web}${paths.workItems(slug, "MOB")}`);
  await page.getByRole("button", { name: t("workItems.addNew"), exact: true }).first().click();
  const modal = page.getByRole("dialog", { name: t("workItems.modal.title") });
  await modal.getByRole("button", { name: new RegExp(`^${t("workItems.labels")}`) }).click();
  const labelOptions = await page.getByRole("menuitemcheckbox").allTextContents();
  check(JSON.stringify(labelOptions.map((name) => name.trim()).filter((name) => ["Alpha", "Bravo", "Charlie"].includes(name))) === JSON.stringify(["Alpha", "Charlie", "Bravo"]), `labels picker order is ${labelOptions.join(",")}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  console.log("PASS labels picker shows the stored order");

  // 2. Work item types and 3. custom properties both live on the Features page of project settings.
  await page.goto(`${web}${paths.projectSettings(slug, "MOB", "features")}`);
  const typeRows = page.locator("ul:has([data-grip])").filter({ has: page.getByRole("button", { name: `${t("sortable.reorder")}: Bug`, exact: true }) }).first().locator("li");
  const typeNames = async () => (await typeRows.locator("span.font-medium").allTextContents()).map((name) => name.trim()).filter(Boolean);
  await gripOf(page, "Request").waitFor();
  check(JSON.stringify(await typeNames()) === JSON.stringify(["Task", "Bug", "Request"]), `types start as ${(await typeNames()).join(",")}`);
  await page.getByRole("button", { name: `${t("sortable.actions")}: Request` }).click();
  await page.getByRole("menuitem", { name: t("sortable.moveUp") }).click();
  await page.getByRole("button", { name: `${t("sortable.actions")}: Request` }).click();
  await page.getByRole("menuitem", { name: t("sortable.moveUp") }).click();
  check(await settle(typeNames, ["Request", "Task", "Bug"]), `type Move up did not apply: ${(await typeNames()).join(",")}`);
  await page.reload();
  await gripOf(page, "Request").waitFor();
  check(JSON.stringify(await typeNames()) === JSON.stringify(["Request", "Task", "Bug"]), "type order did not persist across reload");
  await page.screenshot({ path: `${shots}/types-reordered-1440.png` });
  console.log("PASS work item types: Move up persists after reload");

  const propertyRows = page.locator("ul:has([data-grip])").filter({ has: page.getByRole("button", { name: `${t("sortable.reorder")}: Area`, exact: true }) }).first().locator("li");
  const propertyNames = async () => (await propertyRows.locator("span.font-medium").allTextContents()).map((name) => name.trim()).filter(Boolean);
  await gripOf(page, "Owner team").focus();
  await page.keyboard.press("ArrowUp");
  check(await settle(propertyNames, ["Owner team", "Area"]), `property keyboard reorder did not apply: ${(await propertyNames()).join(",")}`);
  await page.reload();
  await gripOf(page, "Owner team").waitFor();
  check(JSON.stringify(await propertyNames()) === JSON.stringify(["Owner team", "Area"]), "custom property order did not persist across reload");
  console.log("PASS custom properties: keyboard reorder persists after reload");

  // On the Features page every grip shown is backed (3 types + 2 properties) and enabled for the Admin.
  check(await page.locator("[data-grip]").count() >= 5, "expected grips in the reorderable settings lists");
  check(await page.locator("[data-grip]:disabled").count() === 0, "a grip in settings is disabled for the Admin");
  console.log("PASS every settings grip is backed and enabled for the Admin");

  // Panel: the work item shows its custom properties in the stored order.
  await page.goto(`${web}${paths.workItem(slug, "MOB-1")}`);
  await page.getByText("Owner team", { exact: true }).first().waitFor();
  const bodyText = await page.locator("body").innerText();
  check(bodyText.indexOf("Owner team") >= 0 && bodyText.indexOf("Area") > bodyText.indexOf("Owner team"), "work item panel does not show Owner team before Area");
  await page.screenshot({ path: `${shots}/work-item-panel-1440.png` });
  console.log("PASS work item panel shows the stored custom property order");

  console.log("settings-lists-reorder: all checks passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
  if (failed) process.exitCode = 1;
}
