// Browser cases for tickets 10 and 22: the selection toolbar is one compact row above (or below) the selection, its colour button holds Text color and Highlight, and with AI off (no provider key) no AI menu is shown.
import { check, createSignedInContext, launchBrowser, newContext, startApi, startLive, startWeb, waitFor } from "./harness";
import { type Browser, type Locator } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31163);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52163);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31183);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const liveHttp = `http://localhost:${livePort}`;
const servers = [
  startApi(apiPort, web),
  startLive(livePort, web),
  startWeb(webPort, { api, live: `ws://localhost:${livePort}` }),
];
let browser: Browser | null = null;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(liveHttp)]);
  browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" }, api, web, {
    account: { name: "Toolbar Tester", email: `${slug}@example.test` },
    workspace: { name: "Toolbar team", slug },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(15_000);
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };

  await page.goto(`${web}/${slug}`);
  await page.waitForURL((url) => url.pathname.includes(slug));

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  // A long page, so the target paragraph sits low in the editor, below the Page title.
  const filler = Array.from({ length: 30 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `Filler line ${index + 1}` }] }));
  const trailing = Array.from({ length: 30 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `Trailing line ${index + 1}` }] }));
  await call("create_wiki_page", { workspaceId, title: "Toolbar page", content: { type: "doc", content: [...filler, { type: "paragraph", content: [{ type: "text", text: "Lower target text" }] }, ...trailing] } });
  const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId });
  const wiki = pages.find((row) => row.title === "Toolbar page")!;
  // With no provider key AI is off, so /api/ai/status answers 404 and the web app shows no AI menu.
  const aiStatus = await context.request.post(`${api}/api/ai/status`, { data: { workspaceId } });
  check(aiStatus.status() === 404, "this flow assumes no provider key in the test environment");

  const editorErrors: string[] = [];
  page.on("pageerror", (error) => editorErrors.push(error.message));
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
  await wikiEditor.getByText("Lower target text", { exact: true }).hover();
  await page.getByTestId("wiki-block-handle").waitFor();
  check(editorErrors.length === 0, `the Wiki block hover listener attaches when the editor opens: ${editorErrors.join(", ")}`);
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
      probe.style.background = "var(--muted)"; probe.style.boxShadow = "var(--shadow-md)";
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const result = { background: style.backgroundColor, shadow: style.boxShadow };
      probe.remove();
      return result;
    });
    const actual = await bubble.evaluate((node) => { const style = getComputedStyle(node); return { background: style.backgroundColor, shadow: style.boxShadow }; });
    check(actual.background === expected.background && expected.background !== "" , `${theme}: toolbar background is not the muted token (${actual.background} vs ${expected.background})`);
    check(actual.shadow === expected.shadow && actual.shadow !== "none", `${theme}: toolbar shadow is not the shadow token (${actual.shadow} vs ${expected.shadow})`);
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  console.log("PASS toolbar surface and shadow come from theme tokens in light and dark");

  // AI off (no provider key counts as off, so the server reports AI off): selecting text shows the formatting toolbar and no AI menu.
  const aiMenu = page.getByRole("toolbar", { name: translate("assist.menu"), exact: true });
  await wikiEditor.getByText("Lower target text", { exact: true }).click();
  await page.keyboard.press("Shift+ArrowLeft");
  await bubble.waitFor();
  check(await aiMenu.count() === 0, "the AI menu is shown while AI is off");
  check(await page.getByRole("status").filter({ hasText: translate("assist.notConfigured") }).count() === 0, "an AI-not-configured note is shown while AI is off");
  console.log("PASS with AI off, selecting text shows no AI menu");

  const phone = await newContext(browser, { viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  try {
    const touchPage = await phone.newPage();
    await touchPage.goto(`${web}/${slug}/wiki/${wiki.id}`);
    const text = touchPage.locator(".ProseMirror").getByText("Filler line 1", { exact: true });
    await text.tap();
    await touchPage.keyboard.press("End");
    await touchPage.keyboard.press("Shift+Home");
    const toolbar = touchPage.getByTestId("wiki-bubble-menu");
    await toolbar.waitFor();
    check(await toolbar.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll("button, select")];
      return matchMedia("(pointer: coarse)").matches && controls.length === 8 &&
        bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth &&
        controls.every((control) => {
          const box = control.getBoundingClientRect();
          return box.width >= 44 && box.height >= 44 && box.left >= bounds.left && box.right <= bounds.right;
        });
    }), "at 320px on a coarse pointer, all eight formatting controls fit at 44px without sideways page scroll");
    const touchColors = toolbar.getByRole("button", { name: translate("wiki.tool.colors"), exact: true });
    await touchColors.tap();
    const touchPanel = touchPage.getByRole("group", { name: translate("wiki.tool.colors"), exact: true });
    await touchPanel.waitFor();
    const panelBox = await box(touchPanel);
    check(panelBox.x >= 0 && panelBox.x + panelBox.width <= 320, "the phone colour panel fits and remains reachable");
    await touchPanel.getByRole("button", { name: `${translate("wiki.insert.color")} ${translate("wiki.color.blue")}`, exact: true }).tap();
    await touchPage.locator('.ProseMirror span[style*="color: rgb(59, 130, 246)"]')
      .filter({ hasText: "Filler line 1" }).waitFor({ timeout: 5_000 });
    if (Bun.env.E2E_SHOTS_DIR) {
      await touchPage.screenshot({ path: `${Bun.env.E2E_SHOTS_DIR}/selection-toolbar-coarse-320.png` });
    }
    console.log("PASS 320px coarse-pointer toolbar and colour panel fit and remain usable");
  } finally {
    await phone.close();
  }

  console.log("e2e selection-toolbar: ok");
  await browser.close();
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
