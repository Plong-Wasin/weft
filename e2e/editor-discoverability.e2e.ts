// Browser cases for ticket 13: a first-time user finds Add image, Table and Link in the comment, description and Wiki editors without being told.
import { chromium, type Browser } from "playwright";
import { translate } from "../packages/shared/src";
import { withShortcut } from "../apps/web/src/shortcuts";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31163);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52163);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31183);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const liveHttp = `http://localhost:${livePort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];
let browser: Browser | null = null;

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(liveHttp)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Discovery Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Discovery team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Discovery");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("DIS");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /DIS · Discovery/ }).waitFor();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const [project] = await call<Array<{ id: string }>>("list_projects", { workspaceId, archived: false });
  const item = await call<{ displayId: string }>("create_work_item", { projectId: project!.id, title: "Discoverable item" });
  await call("create_wiki_page", { workspaceId, title: "Discoverable page", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Wiki anchor" }] }, { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Open task" }] }] }] }] } });
  const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId });
  const wiki = pages.find((row) => row.title === "Discoverable page")!;

  // Comment composer: the same toolbar as the description; Table in it inserts a table.
  await page.goto(`${web}/${slug}/browse/${item.displayId}`);
  const comment = page.getByTestId("comment-editor").last();
  const commentToolbar = comment.locator("xpath=preceding-sibling::div[@data-testid='comment-toolbar'][1]");
  const tableButton = commentToolbar.getByRole("button", { name: translate("wiki.insert.table"), exact: true });
  check(await tableButton.getAttribute("title") === translate("wiki.insert.table"), "comment Table button has no tooltip");
  // Ticket 11: Add image is a toolbar icon; the Comment button stays in the footer on the right.
  check(await commentToolbar.getByRole("button", { name: translate("wiki.insert.image"), exact: true }).count() === 1, "comment Add image icon is not in the toolbar");
  const commentSubmit = page.getByRole("button", { name: translate("comments.add"), exact: true }).last();
  check(await commentSubmit.evaluate((button) => button.closest(".editor-footer") !== null), "Comment button is not in the composer footer");
  await comment.locator(".ProseMirror").click();
  await tableButton.click();
  check(await comment.locator(".ProseMirror table").count() === 1, "comment Table button did not insert a table");
  console.log("PASS comment toolbar has Add image and inserts a labelled Table");

  // Description: Table and Link sit in the labelled toolbar under the editor, next to Add image.
  const description = page.getByTestId("description-editor");
  const descriptionToolbar = page.getByTestId("description-toolbar");
  for (const key of ["wiki.insert.image", "wiki.insert.table", "wiki.tool.link"] as const) {
    check(await descriptionToolbar.getByRole("button", { name: translate(key), exact: true }).count() === 1, `description toolbar has no ${key} button`);
  }
  await description.locator(".ProseMirror").click();
  await descriptionToolbar.getByRole("button", { name: translate("wiki.insert.table"), exact: true }).click();
  check(await description.locator(".ProseMirror table").count() === 1, "description Table button did not insert a table");
  console.log("PASS description toolbar has labelled Add image, Table and Link and Table inserts a table");

  // Ticket 11: the toolbar reports the active state, the Markdown / Visual switch is a pressed icon, and the status sits at the toolbar end.
  await description.locator(".ProseMirror").click();
  await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("probe");
  for (let i = 0; i < 5; i += 1) await page.keyboard.press("Shift+ArrowLeft");
  const bold = descriptionToolbar.getByRole("button", { name: translate("wiki.tool.bold"), exact: true });
  await bold.click();
  check((await description.locator(".ProseMirror strong").allInnerTexts()).some((text) => text.includes("probe")), "Bold toolbar button did not bold the selection");
  check(await bold.getAttribute("aria-pressed") === "true", "Bold toolbar button does not show its active state");
  await bold.click();
  await page.keyboard.press("Control+End");
  const sourceSwitch = descriptionToolbar.getByRole("button", { name: translate("editor.sourceMode"), exact: true });
  check(await sourceSwitch.getAttribute("aria-pressed") === "false" && await sourceSwitch.getAttribute("title") === translate("editor.sourceMode"), "source switch is not an unpressed icon with its tooltip");
  const statusBox = await page.getByTestId("description-save-status").boundingBox();
  const switchBox = await sourceSwitch.boundingBox();
  check(!!statusBox && !!switchBox && Math.abs(statusBox.y + statusBox.height / 2 - (switchBox.y + switchBox.height / 2)) < 4 && statusBox.x < switchBox.x, "save status is not at the toolbar end beside the switch");
  await sourceSwitch.click();
  check(await sourceSwitch.getAttribute("aria-pressed") === "true" && await sourceSwitch.getAttribute("title") === translate("editor.visualMode"), "source switch does not show its pressed state");
  await sourceSwitch.click();
  const toolbarBox = await descriptionToolbar.boundingBox();
  const toolBoxes = await descriptionToolbar.locator(".editor-tool").evaluateAll((buttons) => buttons.map((button) => { const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height, top: rect.top }; }));
  check(toolBoxes.length === 13 && toolBoxes.every((box) => Math.round(box.width) === 28 && Math.round(box.height) === 28 && Math.abs(box.top - toolBoxes[0]!.top) < 1), `toolbar icons are not one 28 px row: ${JSON.stringify(toolBoxes)}`);
  check(!!toolbarBox && toolbarBox.height <= 34, `toolbar is taller than about 32 px (${toolbarBox?.height}px)`);
  await sourceSwitch.focus();
  const focusRing = await sourceSwitch.evaluate((element) => ({ visible: element.matches(":focus-visible"), style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }));
  check(focusRing.visible && focusRing.style === "solid" && focusRing.width === "2px", `toolbar focus ring is missing: ${JSON.stringify(focusRing)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(phoneOverflow <= 0, `page scrolls sideways on a phone by ${phoneOverflow}px`);
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("PASS toolbar shows active state, the Markdown / Visual icon is pressed in turn, status sits at the end, one 28 px row at 1440 px, and no sideways scroll at 390 px");

  await description.locator(".ProseMirror table td").first().click();
  // Table controls are grouped under plain headings, and each action explains itself on hover.
  for (const group of ["table.group.rows", "table.group.columns", "table.group.table"] as const) {
    check(await page.locator(`[role="group"][aria-label="${translate(group)}"]`).count() === 1, `table controls are missing the ${group} group`);
  }
  check(await page.getByRole("group", { name: translate("table.cellColor"), exact: true }).count() === 0, "unsupported table cell background controls should not be shown");
  check(await page.getByRole("button", { name: translate("table.clearRow"), exact: true }).getAttribute("title") === translate("table.clearRow.help"), "Clear row has no tooltip explaining it");
  console.log("PASS supported table controls are grouped under Rows, Columns and Whole table, with tooltips");

  // Wiki page: no fixed toolbar; Link and the marks sit on the selection bubble, Table comes from the / menu.
  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await wikiEditor.waitFor();
  check(await page.getByRole("toolbar", { name: translate("wiki.toolbar") }).count() === 0, "Wiki page must not show the fixed formatting toolbar");
  // A task item shows its checkbox beside its text, not above it.
  const taskItem = wikiEditor.locator('li[data-checked]').first();
  check(await taskItem.evaluate((node) => getComputedStyle(node).display) === "flex", "Wiki task item stacks its checkbox above its text");
  console.log("PASS task item keeps its checkbox beside its text");
  await wikiEditor.click();
  await page.keyboard.press("Control+a");
  const wikiBubble = page.getByTestId("wiki-bubble-menu");
  await wikiBubble.waitFor();
  check((await wikiBubble.getByRole("button", { name: translate("wiki.tool.link"), exact: true }).count()) === 1, "Selection bubble has no Link action");
  check((await wikiBubble.getByRole("button", { name: translate("wiki.tool.bold"), exact: true }).getAttribute("title")) === withShortcut(translate("wiki.tool.bold"), "B"), "Bubble Bold tooltip has no shortcut hint");
  console.log("PASS Wiki selection bubble offers Link, a Bold tooltip with its shortcut, and no fixed toolbar");
  // Keyboard only: Tab from the selected text reaches the bubble's Bold button, and Enter applies it.
  let boldFocused = false;
  for (let step = 0; step < 40 && !boldFocused; step += 1) {
    await page.keyboard.press("Tab");
    boldFocused = await page.evaluate((label) => document.activeElement?.getAttribute("aria-label") === label, translate("wiki.tool.bold"));
  }
  check(boldFocused, "Keyboard Tab cannot reach the selection bubble's Bold button");
  const strongBefore = await wikiEditor.locator("strong").count();
  await page.keyboard.press("Enter");
  await page.waitForFunction((count) => document.querySelectorAll('[data-testid="wiki-editor"] .ProseMirror strong').length > count, strongBefore).catch(() => undefined);
  check(await wikiEditor.locator("strong").count() > strongBefore, `Enter on the bubble's Bold button did not bold the selection (strong before ${strongBefore})`);
  console.log("PASS Wiki selection bubble actions are reachable and work from the keyboard");
  // Click into the last line (the container's centre can land on a gap that selects the whole document), then add a new empty paragraph after it.
  await wikiEditor.getByText("Open task", { exact: true }).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  // Let the editor take the "/" and open the menu before choosing: choosing in the same instant raced the editor's own update and replaced the document.
  await wikiEditor.getByText("/", { exact: true }).waitFor();
  const tableOption = page.getByRole("listbox", { name: translate("editor.slashMenu") }).getByRole("option", { name: translate("wiki.insert.table"), exact: true });
  await tableOption.waitFor();
  await tableOption.click();
  check(await wikiEditor.locator("table").count() === 1, "Wiki / menu Table did not insert a table");
  console.log("PASS Wiki / menu inserts a Table");
  // Pages list: the row menu is labelled and its items name what they do.
  await page.goto(`${web}/${slug}/wiki`);
  const rowMenu = page.getByRole("button", { name: `${translate("wiki.collection.actions")}: Wiki`, exact: true });
  check(await rowMenu.getAttribute("title") === `${translate("wiki.collection.actions")}: Wiki`, "Pages list row menu has no tooltip");
  await rowMenu.click();
  await page.getByRole("menuitem", { name: translate("wiki.collection.rename"), exact: true }).waitFor();
  await page.keyboard.press("Escape");
  console.log("PASS Pages list row menu has a labelled trigger and named items");

  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  await wikiEditor.getByText("Wiki anchor", { exact: true }).waitFor();
  // Link lives on the selection bubble; Save applies it and the link is clickable in the Wiki page.
  await wikiEditor.getByText("Wiki anchor", { exact: true }).click({ clickCount: 3 });
  await wikiBubble.getByRole("button", { name: translate("wiki.tool.link"), exact: true }).click();
  await wikiBubble.getByLabel(translate("wiki.linkUrl"), { exact: true }).fill("https://link-check.example");
  await wikiBubble.getByRole("button", { name: translate("wiki.linkSave"), exact: true }).click();
  check(await wikiEditor.locator('a[href="https://link-check.example"]').count() === 1, "Bubble Link form did not add the link to the selection");
  console.log("PASS Selection bubble Link form applies a link");
  await wikiEditor.getByText("Wiki anchor", { exact: true }).click({ clickCount: 3 });
  await wikiBubble.getByRole("button", { name: translate("wiki.tool.link"), exact: true }).click();
  await wikiBubble.getByRole("button", { name: translate("wiki.linkRemove"), exact: true }).click();
  check(await wikiEditor.locator('a[href="https://link-check.example"]').count() === 0, "Bubble Remove did not unlink the selected text");

  // Ctrl/Cmd+K opens the Link field on the selection bubble; pasting a URL over selected text makes it a link.
  await wikiEditor.getByText("Wiki anchor", { exact: true }).click({ clickCount: 3 });
  await page.keyboard.press("Control+k");
  await wikiBubble.getByLabel(translate("wiki.linkUrl"), { exact: true }).waitFor();
  check(await wikiBubble.getByLabel(translate("wiki.linkUrl"), { exact: true }).evaluate((input) => input === document.activeElement), "Ctrl/Cmd+K did not focus the bubble's Link field");
  console.log("PASS Ctrl/Cmd+K opens the bubble's Link field and focuses it");

  await wikiEditor.getByText("Wiki anchor", { exact: true }).click({ clickCount: 3 });
  await wikiEditor.evaluate((root) => {
    const data = new DataTransfer();
    data.setData("text/plain", "https://paste-link.example");
    root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  check(await wikiEditor.locator('a[href="https://paste-link.example"]').getByText("Wiki anchor", { exact: true }).count() === 1, "pasting a URL over selected text did not link the selection");
  console.log("PASS pasting a URL over selected text links the selection");

  // Markdown shortcuts: "- " starts a bullet list, "1. " a numbered list, "[] " a task item.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- markdown bullet");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("1. markdown number");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[] markdown task");
  check(await wikiEditor.locator("ul li", { hasText: "markdown bullet" }).count() === 1, "- did not start a bullet list");
  check(await wikiEditor.locator("ol li", { hasText: "markdown number" }).count() === 1, "1. did not start a numbered list");
  check(await wikiEditor.locator('li[data-checked]', { hasText: "markdown task" }).count() === 1, "[] did not start a task item");
  console.log("PASS markdown shortcuts '- ', '1. ' and '[] ' start lists and task items");

  // Shortcut hints: the toolbar tooltips name the keyboard shortcut.


  // Bulleted and numbered list buttons sit in the description toolbar and make the paragraph a list.
  await page.goto(`${web}/${slug}/browse/${item.displayId}`);
  await description.locator(".ProseMirror").click();
  await descriptionToolbar.getByRole("button", { name: translate("wiki.tool.bulletList"), exact: true }).click();
  check(await description.locator(".ProseMirror ul").count() === 1, "description Bulleted list button did not make a bullet list");
  await descriptionToolbar.getByRole("button", { name: translate("wiki.tool.orderedList"), exact: true }).click();
  check(await description.locator(".ProseMirror ol").count() === 1, "description Numbered list button did not make a numbered list");
  console.log("PASS description toolbar Bulleted list and Numbered list buttons create lists");

  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  // Lock sits in the page menu; a locked page shows a Locked badge beside its title, and the menu offers Unlock.
  const pageMenu = page.getByRole("button", { name: translate("wiki.exports"), exact: true });
  await pageMenu.click();
  await page.getByRole("menuitem", { name: translate("wiki.lock"), exact: true }).click();
  await page.getByTestId("wiki-locked-badge").waitFor();
  check(await page.getByText("Lock the page so nobody can edit it until someone unlocks it.", { exact: true }).count() === 0, "the Lock help line is still shown");
  await pageMenu.click();
  await page.getByRole("menuitem", { name: translate("wiki.unlock"), exact: true }).click();
  await page.getByTestId("wiki-locked-badge").waitFor({ state: "detached" });
  console.log("PASS lock is in the page menu, shows a Locked badge, and Unlock clears it");

  // Location names where the page lives; the default is the whole workspace Wiki. The Details panel starts hidden, so open it first.
  const detailsToggle = page.getByTestId("wiki-details-toggle");
  await detailsToggle.waitFor();
  if (await detailsToggle.getAttribute("aria-pressed") !== "true") await detailsToggle.click();
  const location = page.getByRole("group", { name: translate("wiki.location"), exact: true });
  await location.getByText(translate("wiki.location.help"), { exact: true }).waitFor();
  check(await location.getByRole("combobox").evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.textContent) === translate("wiki.location.default"), "Location does not show the whole-workspace Wiki by default");
  console.log("PASS Location group names its scope with helper text");

} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
