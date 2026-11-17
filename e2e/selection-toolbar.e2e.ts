// Browser cases for tickets 10 and 22: the selection toolbar is one compact row above (or below) the selection, its colour button holds Text color and Highlight, and with AI not configured the AI actions stay visible with no card, their explanation shows on press.
import { chromium, type Browser, type Locator } from "playwright";
import { translate } from "../packages/shared/src";

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
  await page.getByLabel(translate("auth.name")).fill("Toolbar Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Toolbar team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL((url) => url.pathname.includes(slug));

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  // A long page, so the target paragraph sits low in the editor, below the Page title.
  const filler = Array.from({ length: 30 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `Filler line ${index + 1}` }] }));
  const trailing = Array.from({ length: 30 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `Trailing line ${index + 1}` }] }));
  await call("create_wiki_page", { workspaceId, title: "Toolbar page", content: { type: "doc", content: [...filler, { type: "paragraph", content: [{ type: "text", text: "Lower target text" }] }, ...trailing] } });
  const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId });
  const wiki = pages.find((row) => row.title === "Toolbar page")!;
  const aiStatus = await (await context.request.post(`${api}/api/ai/status`, { data: { workspaceId } })).json() as { configured: boolean };
  check(aiStatus.configured === false, "this flow assumes AI is not configured in the test environment");

  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  const title = page.locator(".wiki-edit-title");
  const bubble = page.getByTestId("wiki-bubble-menu");
  // Select the target line with the keyboard: a triple-click on a heading also takes the next block's edge.
  const selectTarget = async () => { await wikiEditor.getByText("Lower target text", { exact: true }).click(); await page.keyboard.press("End"); await page.keyboard.press("Shift+Home"); };
  const selectionRect = () => page.evaluate(() => { const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left }; });
  const box = async (locator: Locator) => { const found = await locator.boundingBox(); check(!!found, "element has no box"); return found!; };
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  await wikiEditor.getByText("Lower target text", { exact: true }).waitFor();
  await selectTarget();
  await bubble.waitFor();
  // Single row: every control shares one top edge, and the bubble never covers the Page title.
  const tops = await bubble.locator("select, button, summary").evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).map((node) => Math.round(node.getBoundingClientRect().top)));
  check(tops.length === 8 && Math.max(...tops) - Math.min(...tops) <= 2, `toolbar is not one row of 8 controls: tops ${tops.join(",")}`);
  check(!overlaps(await box(bubble), await box(title)), "selection toolbar covers the Page title when text lower in the page is selected");
  console.log("PASS toolbar is one row at 1440 px and does not cover the Page title");

  // Above the selection: the bubble's bottom edge sits just over the selected text.
  const above = await box(bubble), selected = await selectionRect();
  check(above.y + above.height <= selected.top && selected.top - (above.y + above.height) <= 16, `toolbar is not directly above the selection (bubble bottom ${above.y + above.height}, selection top ${selected.top})`);
  console.log("PASS toolbar sits directly above the selection");

  // Flip: with the selection at the top of the viewport there is no room above, so the toolbar goes below.
  // Collapse the selection, scroll the target near the top of the viewport, then select it: there is no room above, so the toolbar must go below.
  await wikiEditor.getByText("Filler line 1", { exact: true }).click();
  await bubble.waitFor({ state: "hidden" });
  await wikiEditor.getByText("Lower target text", { exact: true }).evaluate((node) => node.scrollIntoView({ block: "start" }));
  const target = wikiEditor.getByText("Lower target text", { exact: true });
  for (let attempt = 0; attempt < 40 && (await box(target)).y > 30; attempt += 1) {
    await page.mouse.wheel(0, 10);
    await Bun.sleep(30);
  }
  await wikiEditor.getByText("Lower target text", { exact: true }).evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await bubble.waitFor();
  check((await selectionRect()).top < 45, "test could not place the selection near the top of the viewport");
  let flipped = false;
  for (let attempt = 0; attempt < 30 && !flipped; attempt += 1) {
    await Bun.sleep(100);
    const top = await selectionRect();
    const at = await box(bubble);
    flipped = top.top < 45 && at.y >= top.bottom - 1;
  }
  check(flipped, `toolbar did not flip below the selection when there was no room above: selection ${JSON.stringify(await selectionRect())} bubble ${JSON.stringify(await box(bubble))}`);
  console.log("PASS toolbar flips below the selection when there is no room above");

  // Every control: accessible name, tooltip, a square icon size, and one control per named action.
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const key of ["wiki.tool.bold", "wiki.tool.italic", "wiki.tool.underline", "wiki.tool.strike", "wiki.tool.code", "wiki.tool.link", "wiki.tool.colors"]) {
    const label = translate(key as never), button = bubble.getByRole("button", { name: label, exact: true });
    check(await button.count() === 1, `${label} button is missing from the toolbar`);
    check((await button.getAttribute("title"))?.startsWith(label) === true, `${label} button has no tooltip`);
    const size = await box(button);
    check(Math.abs(size.width - size.height) < 1 && size.width <= 32, `${label} button is not a compact square icon button`);
  }
  check(await bubble.getByRole("combobox", { name: translate("wiki.tool.blockType"), exact: true }).count() === 1, "block type dropdown is missing");
  console.log("PASS every toolbar control has an accessible name, tooltip and a square icon size");

  // Formatting still works and reports its active state.
  const bold = bubble.getByRole("button", { name: translate("wiki.tool.bold"), exact: true });
  await bold.click();
  check(await bold.getAttribute("aria-pressed") === "true" && await wikiEditor.locator("strong").filter({ hasText: "Lower target text" }).count() === 1, "Bold did not apply or show its active state");
  await bold.click();
  check(await wikiEditor.locator("strong").count() === 0, "Bold did not toggle off");
  await bubble.getByRole("combobox", { name: translate("wiki.tool.blockType"), exact: true }).selectOption("h2");
  check(await wikiEditor.locator("h2").filter({ hasText: "Lower target text" }).count() === 1, "block type dropdown did not convert the block");
  await wikiEditor.getByText("Lower target text", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await bubble.waitFor();
  console.log("PASS Bold toggles with its active state and block type still converts the block");

  // One colour button opens a popover holding Text color and Highlight, each with eight swatches and a reset.
  const colorButton = bubble.getByRole("button", { name: translate("wiki.tool.colors"), exact: true });
  await colorButton.click();
  const colors = page.getByRole("group", { name: translate("wiki.tool.colors"), exact: true });
  await colors.waitFor();
  check(await colors.getByRole("button", { name: `${translate("wiki.insert.color")} ${translate("wiki.color.blue")}`, exact: true }).count() === 1, "Text color swatches are not in the colour popover");
  check(await colors.getByRole("button", { name: `${translate("wiki.highlight")} ${translate("wiki.color.yellow")}`, exact: true }).count() === 1, "Highlight swatches are not in the colour popover");
  await colors.getByRole("button", { name: `${translate("wiki.insert.color")} ${translate("wiki.color.blue")}`, exact: true }).click();
  await colors.getByRole("button", { name: `${translate("wiki.highlight")} ${translate("wiki.color.yellow")}`, exact: true }).click();
  check(await wikiEditor.locator('span[style*="color: rgb(59, 130, 246)"]').filter({ hasText: "Lower target text" }).count() === 1, "text colour did not apply from the colour popover");
  check(await wikiEditor.locator('mark[style*="background-color: rgb(234, 179, 8)"]').filter({ hasText: "Lower target text" }).count() === 1, "highlight did not apply from the colour popover");
  check((await colorButton.getAttribute("class"))?.includes("is-active") === true, "colour button does not show its active state");
  await colors.getByRole("button", { name: translate("wiki.tool.resetTextColor"), exact: true }).click();
  await colors.getByRole("button", { name: translate("wiki.tool.resetHighlight"), exact: true }).click();
  check(await wikiEditor.locator('span[style*="color"], mark').filter({ hasText: "Lower target text" }).count() === 0, "text colour or highlight reset did not clear the selection");
  console.log("PASS colour button holds Text color and Highlight, applies both and resets both");

  // Keyboard only: Tab reaches the colour button, Enter opens the popover, Escape closes it and returns focus to the button.
  await selectTarget();
  await bubble.waitFor();
  let colourFocused = false;
  for (let step = 0; step < 40 && !colourFocused; step += 1) {
    await page.keyboard.press("Tab");
    colourFocused = await page.evaluate((label) => document.activeElement?.getAttribute("aria-label") === label, translate("wiki.tool.colors"));
  }
  check(colourFocused, "keyboard Tab cannot reach the colour button");
  await page.keyboard.press("Enter");
  await colors.waitFor();
  await page.keyboard.press("Escape");
  await colors.waitFor({ state: "detached" });
  check(await page.evaluate((label) => document.activeElement?.getAttribute("aria-label") === label, translate("wiki.tool.colors")), "Escape did not return focus to the colour button");
  console.log("PASS colour popover opens and closes from the keyboard with focus kept on its button");

  // Outside click closes the popover; the link field opens from its button and applies a link.
  await colorButton.click();
  await colors.waitFor();
  await title.click();
  await colors.waitFor({ state: "detached" });
  await selectTarget();
  await bubble.waitFor();
  const linkButton = bubble.getByRole("button", { name: translate("wiki.tool.link"), exact: true });
  await linkButton.click();
  await bubble.getByLabel(translate("wiki.linkUrl"), { exact: true }).fill("https://toolbar-check.example");
  await bubble.getByRole("button", { name: translate("wiki.linkSave"), exact: true }).click();
  check(await wikiEditor.locator('a[href="https://toolbar-check.example"]').count() === 1, "Link button did not apply a link to the selection");
  await selectTarget();
  await linkButton.click();
  await bubble.getByRole("button", { name: translate("wiki.linkRemove"), exact: true }).click();
  check(await wikiEditor.locator('a[href="https://toolbar-check.example"]').count() === 0, "Remove link did not unlink the selection");
  console.log("PASS colour popover closes on an outside click; Link button applies and removes a link");

  // Theme: the toolbar's surface and shadow are the theme tokens in light and dark.
  await selectTarget();
  await bubble.waitFor();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await Bun.sleep(150);
    const expected = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--bg-surface-1)"; probe.style.boxShadow = "var(--shadow-menu)";
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const result = { background: style.backgroundColor, shadow: style.boxShadow };
      probe.remove();
      return result;
    });
    const actual = await bubble.evaluate((node) => { const style = getComputedStyle(node); return { background: style.backgroundColor, shadow: style.boxShadow }; });
    check(actual.background === expected.background && expected.background !== "" , `${theme}: toolbar background is not the surface token (${actual.background} vs ${expected.background})`);
    check(actual.shadow === expected.shadow && actual.shadow !== "none", `${theme}: toolbar shadow is not the menu token (${actual.shadow} vs ${expected.shadow})`);
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  console.log("PASS toolbar surface and shadow come from theme tokens in light and dark");

  // AI not configured: selecting text shows the AI actions with no card over the selection; pressing one shows the explanation in the menu.
  const notConfiguredText = translate("assist.notConfigured");
  const aiMenu = page.getByRole("toolbar", { name: translate("assist.menu"), exact: true });
  const rephrase = aiMenu.getByRole("button", { name: translate("assist.task.rephrase"), exact: true });
  await rephrase.waitFor();
  check(await aiMenu.getByRole("button", { name: translate("assist.task.summarize"), exact: true }).count() === 1, "AI actions are not visible while AI is not configured");
  check(await page.getByRole("status").filter({ hasText: notConfiguredText }).count() === 0, "selecting text opened the AI-not-configured card");
  check(await rephrase.getAttribute("title") === notConfiguredText, "AI action has no tooltip with the not-configured explanation");
  if (Bun.env.E2E_SHOT_DIR) await page.screenshot({ path: `${Bun.env.E2E_SHOT_DIR}/wiki-ai-not-configured-selection.png` });
  console.log("PASS selecting text with AI not configured shows the AI actions and no AI card");

  await rephrase.click();
  const explanation = aiMenu.getByRole("status").filter({ hasText: notConfiguredText });
  await explanation.waitFor();
  check(await page.getByRole("status").filter({ hasText: notConfiguredText }).count() === 1, "pressing an AI action showed the explanation outside the AI menu");
  check(await page.getByText(translate("assist.loading"), { exact: true }).count() === 0, "pressing an AI action with AI not configured started a run");
  if (Bun.env.E2E_SHOT_DIR) await page.screenshot({ path: `${Bun.env.E2E_SHOT_DIR}/wiki-ai-not-configured-pressed.png` });
  console.log("PASS pressing an AI action shows the not-configured explanation in the menu");

  // A new selection hides the explanation again.
  await wikiEditor.getByText("Filler line 30", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await explanation.waitFor({ state: "detached" });
  console.log("PASS the explanation hides on a new selection");

  console.log("e2e selection-toolbar: ok");
  await browser.close();
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
