// Browser end-to-end flow for work item types: a project admin turns the feature on in Project settings, adds a suggested type and a
// required custom property, a member creates a work item of that type (required value enforced), and changing the type asks before
// dropping values. Screenshots of the settings page, the create modal and the peek panel go to the review folder.
// Run with `bun e2e/run-all.ts work-item-types` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
import { paths } from "../apps/web/src/routes";
import { mkdirSync } from "node:fs";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31141);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52141);
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
const shots = reviewShots("39-work-item-types");
mkdirSync(shots, { recursive: true });

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const t = (key: string) => translate(key as never);

  await page.goto(web);
  await page.getByRole("button", { name: t("auth.signUp"), exact: true }).click();
  await page.getByLabel(t("auth.name")).fill("Types Tester");
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

  // Project settings > Features: turn Work item types on, with the plain explanation next to it.
  await page.goto(`${web}/${slug}/settings/projects/MOB/features`);
  const typesSwitch = page.getByRole("switch", { name: t("features.types") });
  await typesSwitch.waitFor();
  check(await page.getByText(t("features.typesDesc")).isVisible(), "the feature row explains what types are");
  await typesSwitch.click();
  // The switch is controlled: it turns on once the change is saved and the project reloads.
  await page.waitForFunction((label: string) => (document.querySelector(`input[role="switch"][aria-label="${label}"]`) as HTMLInputElement | null)?.checked === true, t("features.types"));
  await page.getByText(t("types.explain")).waitFor();
  await page.getByRole("heading", { name: t("types.title") }).waitFor();
  // Only Task exists at first; the suggestion list adds Bug in one click, with its one-line explanation.
  check(await page.getByText(t("types.explain")).isVisible(), "the types section explains type versus label");
  const suggestions = page.locator("[data-suggestions]");
  await suggestions.getByText("Bug", { exact: true }).waitFor();
  await page.getByRole("button", { name: t("types.addSuggestion").replace("{name}", "Bug") }).click();
  await suggestions.getByText("Bug", { exact: true }).waitFor({ state: "detached" });
  await page.screenshot({ path: `${shots}/settings-light-1440.png`, fullPage: true });

  // A required dropdown property that belongs to Bug.
  const properties = page.locator("[data-properties]");
  await properties.getByRole("heading", { name: t("types.properties") }).waitFor();
  await properties.getByLabel(t("types.propertyName")).fill("Severity");
  await properties.getByLabel(t("types.propertyKind")).selectOption("dropdown");
  await properties.getByLabel(t("types.optionsOnePerLine")).fill("low\nhigh");
  await properties.getByLabel(t("types.requiredToggle")).check();
  // Severity belongs to Bug only: the form starts with the first type (Task) checked.
  await properties.getByLabel("Bug", { exact: true }).check();
  await properties.getByLabel("Task", { exact: true }).uncheck();
  await properties.getByRole("button", { name: t("types.addProperty") }).click();
  await properties.getByText("Severity", { exact: true }).waitFor();
  await page.screenshot({ path: `${shots}/settings-light-1440-properties.png`, fullPage: true });

  // A member-facing create: Bug is chosen, the required Severity blocks save with a clear message, then a value lets it save.
  await page.goto(`${web}${paths.workItems(slug, "MOB")}`);
  await page.getByRole("button", { name: t("workItems.addNew"), exact: true }).click();
  const modal = page.getByRole("dialog", { name: t("workItems.modal.title") });
  await modal.getByLabel(t("workItems.titleField")).fill("Crash on start");
  await modal.getByRole("button", { name: t("types.type") }).first().click();
  await page.getByRole("menuitemradio", { name: "Bug" }).click();
  await modal.getByRole("button", { name: t("workItems.modal.submit") }).click();
  await modal.getByText(t("types.requiredNote").replace("{names}", "Severity").replace("{type}", "Bug")).waitFor();
  await page.screenshot({ path: `${shots}/create-light-1440.png` });
  await modal.getByLabel("Severity").selectOption({ label: "high" });
  await modal.getByRole("button", { name: t("workItems.modal.submit") }).click();
  await modal.waitFor({ state: "detached" });

  // Peek panel: the type shows; moving to Task asks before the Severity value is dropped.
  await page.getByText("Crash on start").first().click();
  const peek = page.getByRole("complementary", { name: t("workItems.properties") });
  await peek.getByRole("button", { name: t("types.type") }).first().click();
  await page.getByRole("menuitemradio", { name: "Task" }).click();
  const drop = page.getByRole("group", { name: t("types.dropHeading") });
  await drop.waitFor();
  await page.screenshot({ path: `${shots}/peek-light-1440.png` });
  await drop.getByRole("button", { name: t("types.dropConfirm") }).click();
  await drop.waitFor({ state: "detached" });
  await peek.getByRole("button", { name: t("types.type") }).first().filter({ hasText: "Task" }).waitFor();

  // Responsive and dark: the peek panel at phone width, the settings page at tablet width and in dark mode.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/peek-light-390.png` });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`${web}${paths.projectSettings(slug, "MOB", "features")}`);
  await page.getByRole("heading", { name: t("types.title") }).waitFor();
  await page.screenshot({ path: `${shots}/settings-light-768.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${shots}/settings-dark-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}${paths.workItems(slug, "MOB")}`);
  await page.getByRole("button", { name: t("workItems.addNew"), exact: true }).click();
  await page.getByRole("dialog", { name: t("workItems.modal.title") }).waitFor();
  await page.screenshot({ path: `${shots}/create-dark-390.png` });

  // Types on (MOB) and off (PLN) side by side: the board groups by type and the create modal has a type picker only where types are on.
  // The spreadsheet has no type column in either project: its columns come from the view's display properties, and types add none.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}${paths.projects(slug)}`);
  await page.getByRole("button", { name: t("projects.new"), exact: true }).click();
  await page.getByLabel(t("projects.name")).fill("Plain");
  await page.getByLabel(t("projects.key"), { exact: true }).fill("PLN");
  await page.getByRole("button", { name: t("projects.create") }).click();
  await page.getByRole("link", { name: /PLN · Plain/ }).waitFor();
  for (const [key, typesOn] of [["MOB", true], ["PLN", false]] as const) {
    const name = typesOn ? "on" : "off";
    await page.goto(`${web}${paths.workItems(slug, key)}?layout=board`);
    await page.getByRole("tab", { name: t("layout.board"), selected: true }).waitFor();
    await page.getByRole("button", { name: t("layout.display"), exact: true }).click();
    const groupOptions = await page.locator(`select option[value="type"]`).count();
    await page.keyboard.press("Escape");
    check((groupOptions > 0) === typesOn, `${key}: board group-by type option is ${typesOn ? "shown" : "absent"} with types ${name} (${groupOptions} found)`);
    await page.screenshot({ path: `${shots}/board-types-${name}-1440.png` });

    await page.goto(`${web}${paths.workItems(slug, key)}?layout=spreadsheet`);
    await page.getByRole("tab", { name: t("layout.spreadsheet"), selected: true }).waitFor();
    check(await page.getByRole("columnheader", { name: t("types.type"), exact: true }).count() === 0, `${key}: spreadsheet has no type column with types ${name}`);
    await page.screenshot({ path: `${shots}/spreadsheet-types-${name}-1440.png` });

    await page.goto(`${web}${paths.workItems(slug, key)}?layout=list`);
    await page.getByRole("button", { name: t("workItems.addNew"), exact: true }).click();
    const createModal = page.getByRole("dialog", { name: t("workItems.modal.title") });
    await createModal.getByLabel(t("workItems.titleField")).waitFor();
    check(await createModal.getByRole("button", { name: t("types.type") }).count() === (typesOn ? 1 : 0), `${key}: create modal type picker is ${typesOn ? "shown" : "absent"} with types ${name}`);
    await page.keyboard.press("Escape");
    await createModal.waitFor({ state: "detached" });
  }

  await browser.close();
  console.log(`work item types flow ok (${slug})`);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
