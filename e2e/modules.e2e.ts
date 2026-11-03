// Browser end-to-end flow: Modules pages (list and grid, create, edit, properties sidebar, add and remove work items, archive, delete).
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31137);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52137);
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => { const response = await context.request.post(`${api}/actions/${name}`, { data: body }); if (!response.ok()) throw new Error(`${name} failed: ${response.status()}`); return await response.json() as T; };
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Modules Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  if (await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).count()) await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id, archived: false });
  for (const title of ["Alpha", "Beta"]) await call("create_work_item", { projectId: project!.id, title });

  const t = (key: string) => translate(key as never);
  const shots = reviewShots("13-modules-ui");
  page.on("dialog", (dialog) => void dialog.accept());
  const base = `${web}/${slug}/projects/MOB`;
  await page.goto(`${base}/modules`);
  await page.getByText(t("modules.empty")).waitFor();

  // Create (modal): name, status, lead, members, dates.
  await page.getByRole("button", { name: t("modules.addNew") }).click();
  const modal = page.getByRole("dialog", { name: t("modules.addTitleModal") });
  check(await modal.evaluate((element) => element.scrollHeight <= element.clientHeight), "Create Module dialog should fit without a scrollbar at 1080p");
  await modal.getByLabel(t("modules.name")).fill("Auth");
  const status = modal.getByRole("button", { name: new RegExp(`^${t("modules.status")}:`) });
  await status.click();
  const dates = await modal.getByLabel(t("modules.start")).evaluate((element) => {
    const row = element.closest("div.flex");
    return row?.getBoundingClientRect().toJSON();
  });
  const statusMenu = await page.locator('[role="menu"]').last().boundingBox();
  check(Boolean(dates && statusMenu && (statusMenu.y + statusMenu.height <= dates.top || statusMenu.y >= dates.bottom)), "Status options should not cover the date row");
  check(await modal.evaluate((element) => element.scrollHeight <= element.clientHeight), "Opening Status should not add a dialog scrollbar");
  await page.getByRole("menuitemradio", { name: t("modules.status.in-progress") }).click();
  await modal.getByRole("button", { name: new RegExp(`^${t("modules.lead")}:`) }).click();
  await page.getByRole("menuitemradio", { name: "Modules Tester" }).click();
  await modal.getByRole("button", { name: new RegExp(`^${t("modules.members")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Modules Tester" }).click();
  await page.keyboard.press("Escape");
  await modal.getByLabel(t("modules.start")).fill("2026-01-01");
  await modal.getByLabel(t("modules.end")).fill("2026-03-01");
  await modal.getByRole("button", { name: t("modules.create"), exact: true }).click();
  await modal.waitFor({ state: "detached" });
  const row = page.getByTestId("module-row-Auth");
  await row.waitFor();
  check((await row.innerText()).includes(t("modules.status.in-progress")), "status badge missing in list");
  check((await row.innerText()).includes("0"), "progress missing");
  await page.screenshot({ path: `${shots}/modules-list-1440.png` });

  // Grid display.
  await page.getByRole("button", { name: t("modules.display.grid"), exact: true }).click();
  await page.getByTestId("module-card-Auth").waitFor();
  await page.screenshot({ path: `${shots}/modules-grid-1440.png` });
  await page.getByRole("button", { name: t("modules.display.list"), exact: true }).click();
  await row.waitFor();

  // Edit from the menu.
  await row.getByRole("button", { name: t("modules.actions") }).click();
  await page.getByRole("menuitem", { name: t("modules.edit") }).click();
  const edit = page.getByRole("dialog", { name: t("modules.editTitle") });
  await edit.getByLabel(t("modules.name")).fill("Authentication");
  await edit.getByRole("button", { name: t("modules.save"), exact: true }).click();
  await edit.waitFor({ state: "detached" });
  await page.getByTestId("module-row-Authentication").waitFor();
  console.log("modules: create, grid/list, edit");

  // Detail: add work items from the module page.
  await page.getByRole("link", { name: "Authentication" }).click();
  await page.getByRole("heading", { name: "Authentication" }).waitFor();
  await page.getByRole("button", { name: t("modules.addWorkItems") }).click();
  const add = page.getByRole("dialog", { name: t("modules.addItemsTitle") });
  await add.getByLabel(/Alpha/).check();
  await add.getByLabel(/Beta/).check();
  await add.getByRole("button", { name: t("modules.add"), exact: true }).click();
  await add.waitFor({ state: "detached" });
  await page.getByRole("link", { name: /Alpha/ }).waitFor();
  await page.getByRole("link", { name: /Beta/ }).waitFor();
  check((await page.getByTestId("module-items-count").innerText()) === "0/2", "count should be 0/2");

  // Properties sidebar: status, dates, lead, members are editable inline.
  const side = page.getByRole("complementary", { name: t("modules.properties") });
  await side.getByRole("button", { name: new RegExp(`^${t("modules.status")}:`) }).click();
  await page.getByRole("menuitemradio", { name: t("modules.status.completed") }).click();
  await side.getByRole("button", { name: `${t("modules.status")}: ${t("modules.status.completed")}` }).waitFor();
  await side.getByLabel(t("modules.end")).fill("2026-04-01");
  await side.getByLabel(t("modules.end")).evaluate((el) => el.blur());
  await page.reload();
  check((await page.getByRole("complementary", { name: t("modules.properties") }).getByLabel(t("modules.end")).inputValue()) === "2026-04-01", "end date not saved");
  await page.getByRole("button", { name: new RegExp(`^${t("modules.lead")}:`) }).click();
  await page.getByRole("menuitemradio", { name: t("modules.noLead") }).click();
  await page.getByRole("button", { name: `${t("modules.lead")}: ${t("modules.noLead")}` }).waitFor();
  await page.getByRole("button", { name: new RegExp(`^${t("modules.members")}:`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Modules Tester" }).click();
  await page.getByRole("button", { name: `${t("modules.members")}: —` }).waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/module-detail-1440.png` });

  // Remove a work item from the module page.
  await page.getByRole("button", { name: t("modules.remove") }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="module-items-count"]')?.textContent === "0/1");
  console.log("modules: add/remove work items, properties sidebar");

  // Archive (completed Module), see it under archived, unarchive, delete.
  await page.getByRole("button", { name: t("modules.actions") }).click();
  await page.getByRole("menuitem", { name: t("modules.archive") }).click();
  await page.getByText(t("modules.archivedNote")).waitFor();
  check(await page.getByRole("button", { name: t("modules.remove") }).count() === 0, "archived module must be read-only");
  await page.goto(`${base}/modules`);
  await page.getByText(t("modules.empty")).waitFor();
  await page.getByLabel(t("modules.showArchived")).check();
  await page.getByTestId("module-row-Authentication").waitFor();
  await page.getByTestId("module-row-Authentication").getByRole("button", { name: t("modules.actions") }).click();
  await page.getByRole("menuitem", { name: t("modules.unarchive") }).click();
  await page.getByText(t("modules.empty")).waitFor();
  await page.getByLabel(t("modules.showArchived")).uncheck();
  await page.getByTestId("module-row-Authentication").getByRole("button", { name: t("modules.actions") }).click();
  await page.getByRole("menuitem", { name: t("modules.delete") }).click();
  await page.getByText(t("modules.empty")).waitFor();
  console.log("modules: archive, unarchive, delete");

  // Mobile width: the list stays usable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/modules`);
  await page.screenshot({ path: `${shots}/modules-390.png` });
  console.log("e2e modules: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  // The flow commits real rows (the servers use their own connections), so remove them: other tests expect an empty instance.
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
