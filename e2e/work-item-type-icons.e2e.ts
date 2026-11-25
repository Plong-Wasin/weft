// Browser end-to-end flow for the work item type icon library: the picker lists grouped icons with a search (English and Thai), an
// empty state, Enter and Escape in the search, and an icon from a new group is saved, then shown in the type row, the Create work item
// dialog and the work item's type, and survives a reload. Screenshots of the open picker with a search typed, dark theme, at 1440 and 390 px.
// Run with `bun e2e/run-all.ts work-item-type-icons` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
import { paths } from "../apps/web/src/routes";
import { mkdirSync } from "node:fs";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31142);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52142);
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
const t = (key: string) => translate(key as never);
const shots = reviewShots("19-type-icon-library");
mkdirSync(shots, { recursive: true });

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page: Page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const action = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };
  const enter = async (locator: ReturnType<typeof page.locator>, options: { isComposing?: boolean; keyCode?: number } = {}) => locator.evaluate((element, eventOptions) => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: eventOptions.isComposing ?? false });
    if (eventOptions.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: eventOptions.keyCode });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, focused: document.activeElement === element };
  }, options);

  // Account, workspace and project, as the other type flows do.
  await page.goto(web);
  await page.getByRole("button", { name: t("auth.signUp"), exact: true }).click();
  await page.getByLabel(t("auth.name")).fill("Icon Tester");
  await page.getByLabel(t("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(t("auth.password"), { exact: true }).fill("a-secure-password-19");
  await page.getByLabel(t("auth.confirmPassword"), { exact: true }).fill("a-secure-password-19");
  await page.getByRole("button", { name: t("auth.signUp") }).click();
  await page.getByLabel(t("workspace.name")).fill("E2E icons");
  await page.getByLabel(t("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: t("workspace.create") }).click();
  await page.getByRole("button", { name: t("projects.new"), exact: true }).click();
  await page.getByLabel(t("projects.name")).fill("Mobile");
  await page.getByLabel(t("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: t("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();

  // Turn Work item types on, then add the Bug suggestion.
  await page.goto(`${web}/${slug}/settings/projects/MOB/features`);
  const typesSwitch = page.getByRole("switch", { name: t("features.types") });
  await typesSwitch.waitFor();
  await typesSwitch.click();
  await page.waitForFunction((label: string) => (document.querySelector(`input[role="switch"][aria-label="${label}"]`) as HTMLInputElement | null)?.checked === true, t("features.types"));
  await page.getByRole("heading", { name: t("types.title") }).waitFor();
  await page.getByRole("button", { name: t("types.addSuggestion").replace("{name}", "Bug") }).click();

  const bugRow = page.locator("li").filter({ has: page.getByRole("button", { name: t("types.editNamed").replace("{name}", "Bug"), exact: true }) });
  await bugRow.getByRole("button", { name: t("types.editNamed").replace("{name}", "Bug"), exact: true }).click();
  const editor = bugRow.locator("[data-type-form]");
  await editor.waitFor();
  const icons = editor.getByRole("radiogroup", { name: t("types.icon") });
  const search = editor.getByLabel(t("types.iconSearch"), { exact: true });

  // The library: at least 60 icons, in seven headed groups, with the search above them.
  check(await icons.getByRole("radio").count() >= 60, "the library lists at least 60 icons");
  check(await icons.getByRole("radio", { name: t("types.icon.rocket"), exact: true }).getAttribute("title") === t("types.icon.rocket"), "an icon from a new group shows its name as a tooltip");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the settings page does not scroll sideways at 1440 px");
  check(await editor.locator("[data-icon-group]").count() === 7, "the library shows seven headed groups");
  for (const group of ["work", "people", "comms", "status", "objects", "tech", "nature"]) {
    check((await editor.locator(`[data-icon-group="${group}"] h4`).textContent())?.trim() === t(`types.iconGroup.${group}`), `group ${group} has its heading`);
  }
  check(await editor.locator('[data-icon-group="tech"] [role="radio"]').count() >= 6, "the Tech group holds several icons");

  // Search by English name and keyword, then Thai keyword, then the empty state.
  await search.fill("rocket");
  check(await icons.getByRole("radio").count() === 1 && await icons.getByRole("radio", { name: t("types.icon.rocket"), exact: true }).count() === 1, "searching the name shows only that icon");
  await search.fill("deploy");
  check(await icons.getByRole("radio", { name: t("types.icon.rocket"), exact: true }).count() === 1, "searching a keyword finds the icon");
  await search.fill("ปลั๊กอิน");
  check(await icons.getByRole("radio", { name: t("types.icon.puzzle"), exact: true }).count() === 1, "searching in Thai finds the icon");
  await search.fill("zzqqxx");
  check(await icons.getByRole("radio").count() === 0 && await editor.getByText(t("types.iconNoMatch"), { exact: true }).isVisible(), "an empty result says No icon matches");

  // Escape clears a typed search; Enter picks the first match.
  await search.press("Escape");
  check(await search.inputValue() === "" && await icons.getByRole("radio").count() >= 60, "Escape clears the search and shows the library again");
  await search.fill("rocket");
  const composingIconEnter = await enter(search, { isComposing: true });
  check(!composingIconEnter.defaultPrevented && composingIconEnter.focused && await icons.getByRole("radio", { name: t("types.icon.rocket"), exact: true }).getAttribute("aria-checked") === "false", "composing Enter does not select an icon or prevent native IME handling");
  const safariIconEnter = await enter(search, { keyCode: 229 });
  check(!safariIconEnter.defaultPrevented && safariIconEnter.focused && await icons.getByRole("radio", { name: t("types.icon.rocket"), exact: true }).getAttribute("aria-checked") === "false", "keyCode 229 does not select an icon or prevent native IME handling");
  const normalIconEnter = await enter(search);
  check(normalIconEnter.defaultPrevented, "ordinary Enter is consumed by icon selection");
  check(await icons.getByRole("radio", { name: t("types.icon.rocket"), exact: true }).getAttribute("aria-checked") === "true", "Enter picks the first match");

  // Dark theme, search typed, at 1440 and then 390 px: the open picker with a search in it.
  await page.emulateMedia({ colorScheme: "dark" });
  await search.fill("ship");
  await editor.screenshot({ path: `${shots}/icon-picker-dark-search-1440.png` });
  await search.fill("");
  await search.fill("rocket");
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the settings page does not scroll sideways at 390 px");
  await editor.screenshot({ path: `${shots}/icon-picker-dark-search-390.png` });
  await search.fill("");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Save the icon from the rocket and check the row, and reopen to see the saved pick.
  await search.fill("rocket");
  await icons.getByRole("radio", { name: t("types.icon.rocket"), exact: true }).click();
  await editor.getByRole("button", { name: t("types.save"), exact: true }).click();
  await editor.waitFor({ state: "detached" });
  check(await bugRow.locator('[data-type-icon="rocket"]').count() >= 1, "the type row shows the saved icon");

  // Prepare a Bug property and work item so title and draft-property Enter behavior is exercised in the actual detail controls.
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const project = (await action<Array<{ id: string }>>("list_projects", { workspaceId: me.workspaces[0]!.id }))[0]!;
  const bugType = (await action<Array<{ id: string; name: string }>>("list_work_item_types", { projectId: project.id })).find((type) => type.name === "Bug")!;
  const property = await action<{ id: string }>("create_custom_property", { projectId: project.id, name: "IME notes", kind: "text", typeIds: [bugType.id] });
  const item = await action<{ displayId: string }>("create_work_item", {
    projectId: project.id, title: "Original IME title", typeId: bugType.id, properties: [{ propertyId: property.id, value: "before" }],
  });
  const original = await action<{ properties: Array<{ propertyId: string; value: string }> }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: item.displayId });
  check(original.properties.some((value) => value.propertyId === property.id && value.value === "before"), "the IME fixture has its typed property value");

  // Create work item: the type chip in the dialog shows the saved icon.
  await page.goto(`${web}${paths.workItems(slug, "MOB")}`);
  await page.getByRole("button", { name: t("workItems.addNew"), exact: true }).first().click();
  const modal = page.getByRole("dialog", { name: t("workItems.modal.title") });
  await modal.getByLabel(t("workItems.titleField")).fill("Rocket launch");
  await modal.getByRole("button", { name: t("types.type") }).first().click();
  await page.getByRole("menuitemradio", { name: "Bug" }).click();
  check(await modal.locator('[data-type-icon="rocket"]').count() >= 1, "the Create work item dialog shows the saved icon on the type");
  await modal.getByRole("button", { name: t("workItems.modal.submit") }).click();
  await modal.waitFor({ state: "detached" });

  // Work item detail: the type row shows the icon; it survives a reload.
  await page.getByText("Rocket launch").first().click();
  const peek = page.getByRole("complementary", { name: t("workItems.properties") });
  await peek.locator('[data-type-icon="rocket"]').first().waitFor();
  check(await peek.locator('[data-type-icon="rocket"]').count() >= 1, "the work item detail shows the saved icon on its type");
  await page.reload();
  await page.getByText("Rocket launch").first().click();
  const reloaded = page.getByRole("complementary", { name: t("workItems.properties") });
  await reloaded.locator('[data-type-icon="rocket"]').first().waitFor();
  check(await reloaded.locator('[data-type-icon="rocket"]').count() >= 1, "the work item detail keeps the icon after a reload");

  // The work item title saves on blur; composition Enter must leave it focused and unchanged, while ordinary Enter blurs and saves.
  await page.goto(`${web}${paths.workItem(slug, item.displayId)}`);
  const propertiesToggle = page.getByTestId("work-item-properties-toggle");
  await propertiesToggle.waitFor();
  if (await propertiesToggle.getAttribute("aria-pressed") !== "true") await propertiesToggle.click();
  const detail = page.getByRole("complementary", { name: t("workItems.properties") });
  const detailStateChip = detail.getByRole("button", { name: new RegExp(`^${t("workItems.state")}:`) });
  check(await detailStateChip.evaluate((element) => getComputedStyle(element).borderTopWidth === "1px"), "work item detail State chip should retain its outlined border");
  const notes = detail.locator("[data-property-fields] input");
  await notes.waitFor({ state: "visible" });
  const detailState = await detail.evaluate((element) => ({ viewport: innerWidth, className: element.className, display: getComputedStyle(element).display, rect: element.getBoundingClientRect().toJSON() }));
  check(await notes.count() === 1, `the work item detail shows one draft property field (${JSON.stringify(detailState)})`);
  const title = page.getByRole("textbox", { name: t("workItems.titleField") }).first();
  await title.fill("Draft IME title");
  const composingTitleEnter = await enter(title, { isComposing: true });
  check(!composingTitleEnter.defaultPrevented && composingTitleEnter.focused, "composing Enter keeps the title focused without preventing native IME handling");
  const safariTitleEnter = await enter(title, { keyCode: 229 });
  check(!safariTitleEnter.defaultPrevented && safariTitleEnter.focused, "keyCode 229 keeps the title focused");
  const unchanged = await action<{ title: string }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: item.displayId });
  check(unchanged.title === "Original IME title", "composition Enter did not save the title");
  const titleSave = page.waitForResponse((response) => response.url().includes("/actions/update_work_item") && response.ok());
  const normalTitleEnter = await enter(title);
  check(normalTitleEnter.defaultPrevented && !normalTitleEnter.focused, "ordinary Enter prevents its default and blurs the title");
  await titleSave;
  const savedTitle = await action<{ title: string }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: item.displayId });
  check(savedTitle.title === "Draft IME title", "ordinary Enter saved the title on blur");

  // The custom text property commits on Enter; composing Enter must keep its draft local until ordinary Enter is pressed.
  await notes.fill("draft note");
  const composingPropertyEnter = await enter(notes, { isComposing: true });
  check(!composingPropertyEnter.defaultPrevented && composingPropertyEnter.focused, "composing Enter keeps the property draft focused");
  const safariPropertyEnter = await enter(notes, { keyCode: 229 });
  check(!safariPropertyEnter.defaultPrevented && safariPropertyEnter.focused, "keyCode 229 keeps the property draft focused");
  const unchangedProperty = await action<{ properties: Array<{ propertyId: string; value: string }> }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: item.displayId });
  check(unchangedProperty.properties.find((value) => value.propertyId === property.id)?.value === "before", "composition Enter did not commit the property draft");
  const propertySave = page.waitForResponse((response) => response.url().includes("/actions/update_work_item") && response.ok());
  const normalPropertyEnter = await enter(notes);
  check(normalPropertyEnter.defaultPrevented, "ordinary Enter is consumed by the property commit");
  await propertySave;
  const savedProperty = await action<{ properties: Array<{ propertyId: string; value: string }> }>("get_work_item", { workspaceId: me.workspaces[0]!.id, displayId: item.displayId });
  check(savedProperty.properties.find((value) => value.propertyId === property.id)?.value === "draft note", "ordinary Enter committed the property draft");
  await page.goto(`${web}${paths.projectSettings(slug, "MOB", "features")}`);
  await page.getByRole("heading", { name: t("types.title") }).waitFor();
  check(await bugRow.locator('[data-type-icon="rocket"]').count() >= 1, "the type row keeps the icon after a reload");

  await browser.close();
  console.log(`work item type icon flow ok (${slug})`);
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
