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
const bugRowOn = (page: Page) => page.locator("li").filter({ has: page.getByRole("button", { name: translate("types.editNamed" as never).replace("{name}", "Bug"), exact: true }) });
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

  // Editing a type: the form opens under the title line at the full width of the card, two columns at desktop width, with a
  // grid of real icons, colour swatches with a custom choice, a live preview chip and a description field wide enough to read.
  const editBug = t("types.editNamed").replace("{name}", "Bug");
  const bugRow = page.locator("li").filter({ has: page.getByRole("button", { name: editBug, exact: true }) });
  await bugRow.getByRole("button", { name: editBug, exact: true }).click();
  const editor = bugRow.locator("[data-type-form]");
  await editor.waitFor();
  const rowBox = await bugRow.boundingBox();
  const editorBox = await editor.boundingBox();
  check(rowBox !== null && editorBox !== null && editorBox.width >= rowBox.width * 0.9, "edit form fills the card width at 1440");
  const nameBox = await editor.getByLabel(t("types.name"), { exact: true }).boundingBox();
  const colourBox = await editor.getByRole("radiogroup", { name: t("types.color") }).boundingBox();
  check(nameBox !== null && colourBox !== null && nameBox.x < colourBox.x && Math.abs(nameBox.y - colourBox.y) < 40, "name and colour sit side by side at desktop width");
  const nameLabelBox = await editor.getByText(t("types.name"), { exact: true }).boundingBox();
  const colourLabelBox = await editor.getByText(t("types.color"), { exact: true }).boundingBox();
  check(nameLabelBox !== null && colourLabelBox !== null && Math.abs(nameLabelBox.y - colourLabelBox.y) < 2, "the field labels sit on one baseline");
  const descriptionBox = await editor.getByLabel(t("types.description"), { exact: true }).boundingBox();
  check(descriptionBox !== null && descriptionBox.width >= 360, "the description field is wide enough to read its placeholder");
  // Edit sits on the title line of the row, not in the middle of the tall card.
  const titleBox = await bugRow.getByText("Bug", { exact: true }).first().boundingBox();
  const editButtonBox = await bugRow.getByRole("button", { name: editBug, exact: true }).boundingBox();
  check(titleBox !== null && editButtonBox !== null && Math.abs(editButtonBox.y + editButtonBox.height / 2 - (titleBox.y + titleBox.height / 2)) < 20, "Edit sits on the title line");

  // Icon grid: real icons, a tooltip with the name, arrow keys move the selection and the focus.
  const icons = editor.getByRole("radiogroup", { name: t("types.icon") });
  check(await icons.getByRole("radio").count() >= 60, "the icon choice shows at least 60 icons in groups");
  check(await icons.getByRole("radio", { name: t("types.icon.task"), exact: true }).count() === 1 && await icons.getByRole("radio", { name: t("types.icon.bug"), exact: true }).count() === 1, "the six original icons stay in the library");
  check(await icons.getByRole("radio", { name: t("types.icon.bug"), exact: true }).getAttribute("title") === t("types.icon.bug"), "an icon button shows its name as a tooltip");
  await icons.getByRole("radio", { name: t("types.icon.task"), exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const groupIcon = icons.getByRole("radio", { name: t("types.icon.group"), exact: true });
  check(await groupIcon.getAttribute("aria-checked") === "true" && await groupIcon.evaluate((element) => element === document.activeElement), "the arrow key selects and focuses the next icon");
  await icons.getByRole("radio", { name: t("types.icon.bug"), exact: true }).click();

  // Colour: eight palette swatches and grey, then custom; a custom colour still takes any value.
  const colours = editor.getByRole("radiogroup", { name: t("types.color") });
  check(await colours.getByRole("radio").count() === 10, "the colour choice shows nine swatches and a custom choice");
  await colours.getByRole("radio", { name: t("types.colour.blue"), exact: true }).click();
  await page.keyboard.press("ArrowRight");
  check(await colours.getByRole("radio", { name: t("types.colour.violet"), exact: true }).getAttribute("aria-checked") === "true", "the arrow key moves the colour selection");
  await colours.getByRole("radio", { name: t("types.colour.custom"), exact: true }).click();
  await editor.locator('input[type="color"]').fill("#123456");

  // Live preview: the chip shows the name, icon and colour as they are chosen, before anything is saved.
  const preview = editor.locator("[data-type-preview]");
  check((await preview.textContent())?.includes("Bug") === true, "the preview chip shows the name");
  const previewIconBefore = await preview.locator("svg").evaluate((element) => element.outerHTML);
  await icons.getByRole("radio", { name: t("types.icon.task"), exact: true }).click();
  check(await preview.locator("svg").evaluate((element) => element.outerHTML) !== previewIconBefore, "the preview chip shows the icon as it is chosen");
  await icons.getByRole("radio", { name: t("types.icon.bug"), exact: true }).click();
  check(await preview.locator("svg").evaluate((element) => getComputedStyle(element).color) === "rgb(18, 52, 86)", "the preview chip shows the custom colour before saving");

  await editor.getByLabel(t("types.description"), { exact: true }).fill("Something that works wrongly and needs fixing.");
  await editor.getByRole("button", { name: t("types.save"), exact: true }).click();
  await editor.waitFor({ state: "detached" });
  // The custom colour is kept: the form opens again on the custom choice with that value.
  await bugRow.getByRole("button", { name: editBug, exact: true }).click();
  await editor.waitFor();
  check(await editor.locator('input[type="color"]').inputValue() === "#123456", "a custom colour is saved and shown again");
  check(await editor.getByRole("radio", { name: t("types.colour.custom"), exact: true }).getAttribute("aria-checked") === "true", "the custom choice is selected for a colour that is not a swatch");
  await editor.getByRole("button", { name: t("types.cancel"), exact: true }).click();
  await editor.waitFor({ state: "detached" });

  // Add a type: the same form, with the grey default selected, and a preview that follows the name.
  const addType = page.locator("[data-add-type]");
  check(await addType.getByRole("radio", { name: t("types.colour.grey"), exact: true }).getAttribute("aria-checked") === "true", "the add form starts on the grey swatch");
  await addType.getByLabel(t("types.name"), { exact: true }).fill("Feature");
  check((await addType.locator("[data-type-preview]").textContent())?.includes("Feature") === true, "the add form preview follows the name");
  await addType.getByRole("radio", { name: t("types.icon.document"), exact: true }).click();
  await addType.getByRole("radio", { name: t("types.colour.green"), exact: true }).click();
  await addType.getByRole("button", { name: t("types.add"), exact: true }).click();
  await page.locator("li").filter({ hasText: "Feature" }).first().waitFor();
  await page.waitForFunction(() => (document.getElementById("add-type-name") as HTMLInputElement | null)?.value === "");
  check(await addType.getByLabel(t("types.name"), { exact: true }).inputValue() === "", "the add form clears after a type is added");

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
  await bugRowOn(page).getByRole("button", { name: editBug, exact: true }).click();
  await bugRowOn(page).locator("[data-type-form]").waitFor();
  await page.screenshot({ path: `${shots}/settings-dark-edit-1440.png`, fullPage: true });
  await bugRowOn(page).getByRole("button", { name: t("types.cancel"), exact: true }).click();
  await page.locator("[data-add-type]").screenshot({ path: `${shots}/settings-dark-add-1440.png` });
  // Phone width: the edit form stacks in one column, inside the viewport, with no sideways scroll on the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}${paths.projectSettings(slug, "MOB", "features")}`);
  await page.getByRole("heading", { name: t("types.title") }).waitFor();
  await bugRowOn(page).getByRole("button", { name: editBug, exact: true }).click();
  const phoneEditor = bugRowOn(page).locator("[data-type-form]");
  await phoneEditor.waitFor();
  const phoneName = await phoneEditor.getByLabel(t("types.name"), { exact: true }).boundingBox();
  const phoneColour = await phoneEditor.getByRole("radiogroup", { name: t("types.color") }).boundingBox();
  const phoneForm = await phoneEditor.boundingBox();
  check(phoneName !== null && phoneColour !== null && Math.abs(phoneName.x - phoneColour.x) < 2 && phoneName.y < phoneColour.y, "the edit form stacks in one column at 390 px");
  check(phoneForm !== null && phoneForm.x >= 0 && phoneForm.x + phoneForm.width <= 390, "the edit form stays inside the 390 px viewport");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the settings page does not scroll sideways at 390 px");
  await page.screenshot({ path: `${shots}/settings-dark-edit-390.png`, fullPage: true });
  await bugRowOn(page).getByRole("button", { name: t("types.cancel"), exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}${paths.workItems(slug, "MOB")}`);
  await page.getByRole("button", { name: t("workItems.addNew"), exact: true }).click();
  await page.getByRole("dialog", { name: t("workItems.modal.title") }).waitFor();
  await page.screenshot({ path: `${shots}/create-dark-390.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: t("workItems.modal.title") }).waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}${paths.workItems(slug, "MOB")}`);
  await page.getByRole("button", { name: t("workItems.addNew"), exact: true }).click();
  await page.getByRole("dialog", { name: t("workItems.modal.title") }).waitFor();
  await page.screenshot({ path: `${shots}/create-dark-1440.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: t("workItems.modal.title") }).waitFor({ state: "detached" });

  // A project with one type only (Task): its Delete says why it cannot be used, in a tooltip and in the accessible description.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}${paths.projects(slug)}`);
  await page.getByRole("button", { name: t("projects.new"), exact: true }).click();
  await page.getByLabel(t("projects.name")).fill("Solo");
  await page.getByLabel(t("projects.key"), { exact: true }).fill("SOL");
  await page.getByRole("button", { name: t("projects.create") }).click();
  await page.getByRole("link", { name: /SOL · Solo/ }).waitFor();
  await page.goto(`${web}/${slug}/settings/projects/SOL/features`);
  await page.getByRole("switch", { name: t("features.types") }).click();
  await page.waitForFunction((label: string) => (document.querySelector(`input[role="switch"][aria-label="${label}"]`) as HTMLInputElement | null)?.checked === true, t("features.types"));
  await page.getByRole("heading", { name: t("types.title") }).waitFor();
  await page.getByRole("button", { name: t("types.editNamed").replace("{name}", "Task"), exact: true }).waitFor();
  const onlyDelete = page.getByRole("button", { name: t("types.deleteNamed").replace("{name}", "Task"), exact: true });
  check(await onlyDelete.getAttribute("aria-disabled") === "true", "the only type cannot be deleted");
  check(await onlyDelete.getAttribute("title") === t("types.deleteLast"), "the unusable Delete says why in a tooltip");
  const reasonId = await onlyDelete.getAttribute("aria-describedby");
  check(reasonId !== null && (await page.locator(`[id="${reasonId}"]`).textContent()) === t("types.deleteLast"), "the unusable Delete says why in its accessible description");
  await onlyDelete.click({ force: true });
  check(await page.locator("[data-type-delete]").count() === 0, "clicking the unusable Delete opens nothing");

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
    // The picker renders once list_work_item_types answers, after the modal opens: wait for it where types are on.
    if (typesOn) await createModal.getByRole("button", { name: t("types.type") }).waitFor();
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
