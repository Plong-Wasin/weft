// Browser end-to-end flow: the default Work item type descriptions (Task and the suggestions) follow the interface language, while an
// edited description stays exactly as typed in both languages. Run with `bun e2e/run-all.ts type-descriptions-language` (needs the shared
// weft-postgres container; set DATABASE_URL to use your own database). A screenshot of the Thai settings page goes to the review folder.
import { check, launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import { translate, type MessageKey } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
import { paths } from "../apps/web/src/routes";
import { mkdirSync } from "node:fs";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31150);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52150);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

const shots = reviewShots("41-type-descriptions-language");
mkdirSync(shots, { recursive: true });
const en = (key: string) => translate(key as MessageKey, "en");
const th = (key: string) => translate(key as MessageKey, "th");
const named = (text: string, name: string) => text.replace("{name}", name);
const TASK_EN = "The default type for every work item";
const TASK_TH = th("types.default.task");
const BUG_EN = "Something that works wrongly and needs fixing.";
const BUG_TH = th("types.default.bug");
const OWN_TEXT = "Our own wording for Task, kept as typed";

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const context = await newContext(browser, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name} failed: ${response.status()} ${await response.text()}`);
    return await response.json() as T;
  };
  // The interface language: the signed-in account's saved language wins over the browser copy, so set it on the account and the device.
  const setLanguage = async (locale: "en" | "th") => {
    await call("set_my_locale", { locale });
    await page.evaluate((value: string) => localStorage.setItem("weft.locale", value), locale);
    await page.reload();
  };

  await page.goto(web);
  await page.getByRole("button", { name: en("auth.signUp"), exact: true }).click();
  await page.getByLabel(en("auth.name")).fill("Language Tester");
  await page.getByLabel(en("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(en("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(en("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: en("auth.signUp") }).click();
  await page.getByLabel(en("workspace.name")).fill("E2E team");
  await page.getByLabel(en("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: en("workspace.create") }).click();
  await page.getByRole("button", { name: en("projects.new"), exact: true }).click();
  await page.getByLabel(en("projects.name")).fill("Mobile");
  await page.getByLabel(en("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: en("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();

  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  await call("set_project_features", { projectId: project.id, features: { types: true } });
  const typeRow = (page: import("playwright").Page, name: string) => page.locator("li").filter({ has: page.getByRole("button", { name: named(th("types.editNamed"), name), exact: true }) });

  // English first: the stored English default of Task reads in English.
  await page.goto(`${web}${paths.projectSettings(slug, "MOB", "features")}`);
  await page.getByRole("heading", { name: en("types.title") }).waitFor();
  await page.getByText(TASK_EN, { exact: true }).waitFor();
  check(await page.locator("[data-suggestions]").getByText(BUG_EN, { exact: true }).isVisible(), "the suggested Bug type shows its English description in English");

  // Thai: the same stored text now reads in Thai, and the suggestions do too.
  await setLanguage("th");
  await page.getByRole("heading", { name: th("types.title") }).waitFor();
  await page.getByText(TASK_TH, { exact: true }).waitFor();
  check(await page.getByText(TASK_EN, { exact: true }).count() === 0, "the Task type no longer shows the English default in Thai");
  const suggestions = page.locator("[data-suggestions]");
  await suggestions.getByText(BUG_TH, { exact: true }).waitFor();
  check(await suggestions.getByText(BUG_EN, { exact: true }).count() === 0, "the suggested Bug type shows its Thai description in Thai");
  await page.screenshot({ path: `${shots}/settings-thai-1440.png`, fullPage: true });

  // Saving the untouched default keeps the stored English text, so it keeps following the language.
  const editTask = named(th("types.editNamed"), "Task");
  await typeRow(page, "Task").getByRole("button", { name: editTask, exact: true }).click();
  const taskEditor = typeRow(page, "Task").locator("[data-type-form]");
  await taskEditor.waitFor();
  check(await taskEditor.getByLabel(th("types.description"), { exact: true }).inputValue() === TASK_TH, "the Thai edit form starts with the Thai description");
  await taskEditor.getByRole("button", { name: th("types.save"), exact: true }).click();
  await taskEditor.waitFor({ state: "detached" });
  const storedAfterUntouchedSave = (await call<Array<{ name: string; description: string }>>("list_work_item_types", { projectId: project.id })).find((type) => type.name === "Task")!;
  check(storedAfterUntouchedSave.description === TASK_EN, "an untouched default is stored as the English default, not as the Thai text");

  // An edited description is stored as typed and shows the same in both languages.
  await typeRow(page, "Task").getByRole("button", { name: editTask, exact: true }).click();
  await taskEditor.getByLabel(th("types.description"), { exact: true }).fill(OWN_TEXT);
  await taskEditor.getByRole("button", { name: th("types.save"), exact: true }).click();
  await taskEditor.waitFor({ state: "detached" });
  await page.getByText(OWN_TEXT, { exact: true }).waitFor();
  check(await page.getByText(TASK_TH, { exact: true }).count() === 0, "an edited Task description replaces the Thai default");
  await setLanguage("en");
  await page.getByRole("heading", { name: en("types.title") }).waitFor();
  await page.getByText(OWN_TEXT, { exact: true }).waitFor();
  check(await page.getByText(TASK_EN, { exact: true }).count() === 0, "an edited Task description stays as typed in English too");
  const storedOwn = (await call<Array<{ name: string; description: string }>>("list_work_item_types", { projectId: project.id })).find((type) => type.name === "Task")!;
  check(storedOwn.description === OWN_TEXT, "the edited description is stored exactly as typed");
  console.log("ok: the default Task and Bug descriptions follow the language; an edited Task description stays as typed in both");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
