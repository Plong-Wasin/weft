// Browser check for the "@" mention and ":" emoji popups in the Wiki and comment editors: one look and one selection rule,
// keyboard wrap-around with the selected row kept in view, Escape, Enter and mouse picks, and the selected option exposed to assistive tech.
// Set MENTION_SCREENSHOT to a .png path to save the dark-theme mention popup there (not committed).
import { check, createSignedInContext, launchBrowser, startApi, startLive, startWeb, waitFor } from "./harness";
import { type Locator, type Page } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31480);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52480);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31481);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  startApi(apiPort, web),
  startLive(livePort, web),
  startWeb(webPort, { api, live: `ws://localhost:${livePort}`, env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true" } }),
];

const agentNames = ["Atlas", "Basil", "Cedar", "Dune", "Ember", "Flint", "Grove"];
const groupHeadings = () => [translate("members.group"), translate("agents.group")];

/** Whether the selected option sits fully inside the popup's visible area. */
const selectedInView = (list: Locator) => list.evaluate((element) => {
  const selected = element.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!selected) return false;
  const box = element.getBoundingClientRect();
  const row = selected.getBoundingClientRect();
  return row.top >= box.top && row.bottom <= box.bottom;
});

const selectedIndex = (list: Locator) => list.evaluate((element) => Array.from(element.querySelectorAll('[role="option"]')).findIndex((option) => option.getAttribute("aria-selected") === "true"));

/** The mention list: headings, agent avatars, one highlight rule, wrap-around scrolling, and the picks. */
async function checkMentionPopup(page: Page, editor: Locator, label: string, disabledName?: string) {
  await page.keyboard.type("@");
  const list = page.getByRole("listbox", { name: translate("wiki.mentionMembers"), exact: true });
  await list.waitFor();
  check(await list.evaluate((element) => element.classList.contains("suggest-menu")), `${label}: mention list must use the shared suggest-menu look`);
  const options = list.getByRole("option");
  const count = await options.count();
  check(count === 8, `${label}: expected the full 8-option mention list, got ${count}`);
  check(await list.evaluate((element) => element.scrollHeight > element.clientHeight), `${label}: popup must overflow so the scroll check means something`);
  check(await list.evaluate((element) => getComputedStyle(element).scrollbarWidth === "thin"), `${label}: popup needs a thin scrollbar`);
  check(await list.evaluate((element) => getComputedStyle(element).boxShadow !== "none"), `${label}: popup needs the theme shadow`);

  const headings = await list.locator(".suggest-group").allTextContents();
  check(headings.includes(translate("agents.group")) && headings.every((heading) => groupHeadings().includes(heading)), `${label}: headings must be People and Agents, got ${JSON.stringify(headings)}`);
  check(!(await list.textContent() ?? "").includes("◉"), `${label}: the ◉ glyph must be gone`);
  const agentRows = list.getByRole("option").filter({ has: page.locator("svg") });
  check(await agentRows.count() === agentNames.length, `${label}: every Agent row needs the Agent avatar icon`);
  for (const row of await agentRows.all()) {
    check(!(await row.innerText()).includes(translate("comments.agent")), `${label}: Agent rows must not repeat the word Agent`);
  }
  const personRows = list.getByRole("option").filter({ hasNot: page.locator("svg") });
  check(await personRows.count() === count - agentNames.length, `${label}: people rows must show their avatar letter`);

  const selected = list.locator('[aria-selected="true"]');
  check(await selected.count() === 1, `${label}: exactly one option must be aria-selected`);
  const background = await selected.evaluate((element) => getComputedStyle(element).backgroundColor);
  check(background !== "rgba(0, 0, 0, 0)" && background !== "transparent", `${label}: selected row needs a background token`);
  const weights = await options.evaluateAll((elements) => [...new Set(elements.map((element) => getComputedStyle(element).fontWeight))]);
  check(weights.length === 1, `${label}: selected row must not be bold (font weights differ: ${JSON.stringify(weights)})`);

  // Repeated ArrowDown past the end, then ArrowUp past the start: the highlight wraps and stays inside the popup.
  for (let step = 1; step <= count * 2 + 2; step += 1) {
    await page.keyboard.press("ArrowDown");
    check(await selectedIndex(list) === step % count, `${label}: ArrowDown step ${step} selected the wrong row`);
    check(await selectedInView(list), `${label}: ArrowDown step ${step} left the selected row outside the popup`);
  }
  let expected = await selectedIndex(list);
  for (let step = 1; step <= count * 2 + 2; step += 1) {
    await page.keyboard.press("ArrowUp");
    expected = (expected - 1 + count) % count;
    check(await selectedIndex(list) === expected, `${label}: ArrowUp step ${step} selected the wrong row`);
    check(await selectedInView(list), `${label}: ArrowUp step ${step} left the selected row outside the popup`);
  }

  // Enter picks the selected row; the second row is an Agent or a person, either way it becomes a mention.
  await page.keyboard.press("ArrowDown");
  const pickedName = await selected.locator(".suggest-option-name").textContent() ?? "";
  const mentionsBefore = await editor.locator(".mention", { hasText: pickedName }).count();
  await page.keyboard.press("Enter");
  await list.waitFor({ state: "detached" });
  check(await editor.locator(".mention", { hasText: pickedName }).count() === mentionsBefore + 1, `${label}: Enter did not insert the selected mention`);

  // Escape closes the list and keeps the typed "@"; a mouse pick inserts the clicked row.
  await page.keyboard.type(" @");
  await list.waitFor();
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  check((await editor.innerText()).trimEnd().endsWith("@"), `${label}: Escape must keep the typed @`);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  await list.waitFor();
  const clicked = "Flint";
  const mentionsBeforeClick = await editor.locator(".mention", { hasText: clicked }).count();
  await list.getByRole("option", { name: clicked, exact: true }).click();
  await list.waitFor({ state: "detached" });
  check(await editor.locator(".mention", { hasText: clicked }).count() === mentionsBeforeClick + 1, `${label}: mouse pick did not insert the clicked mention`);
  await editor.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace"); await page.keyboard.type("@");
  await list.waitFor();
  const beforeShiftTab = await editor.locator(".mention").count();
  await page.keyboard.press("Shift+Tab");
  check(await editor.locator(".mention").count() === beforeShiftTab && await editor.evaluate((element) => document.activeElement !== element), `${label}: Shift-Tab should move focus without accepting the highlighted mention`);

  if (disabledName) {
    await editor.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace"); await page.keyboard.type("@");
    await list.waitFor();
    const disabled = list.getByRole("option").filter({ hasText: disabledName });
    check(await disabled.getAttribute("aria-disabled") === "true", `${label}: ${disabledName} should be an unavailable suggestion`);
    const targetIndex = await disabled.evaluate((element) => [...element.parentElement!.querySelectorAll('[role="option"]')].indexOf(element));
    for (let step = 0; step < targetIndex; step++) await page.keyboard.press("ArrowDown");
    check(await list.locator('[aria-selected="true"]').getAttribute("aria-disabled") === "true", `${label}: disabled suggestion was not highlighted`);
    const beforeIme = await editor.locator(".mention").count();
    const imeTabPrevented = await editor.evaluate((element) => {
      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, isComposing: true, keyCode: 229 });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    check(!imeTabPrevented && await editor.locator(".mention").count() === beforeIme, `${label}: synthetic IME Tab must not accept a disabled suggestion`);
    await page.keyboard.press("Tab");
    check(await editor.locator(".mention").count() === beforeIme && await editor.evaluate((element) => document.activeElement !== element), `${label}: Tab must leave the editor without accepting a disabled suggestion`);
  }
  console.log(`case passed: ${label} mention popup look, keyboard wrap, Enter, Escape and mouse pick`);
}

/** The emoji list: the same listbox look, arrow keys, Enter and mouse pick. */
async function checkEmojiPopup(page: Page, editor: Locator) {
  await page.keyboard.type(" :");
  const list = page.getByRole("listbox", { name: translate("wiki.insert.emoji"), exact: true });
  await list.waitFor();
  check(await list.evaluate((element) => element.classList.contains("suggest-menu")), "emoji list must use the shared suggest-menu look");
  check(await list.evaluate((element) => getComputedStyle(element).boxShadow !== "none" && getComputedStyle(element).scrollbarWidth === "thin"), "emoji popup needs the shadow and a thin scrollbar");
  const count = await list.getByRole("option").count();
  for (let step = 0; step < count + 1; step += 1) {
    await page.keyboard.press("ArrowDown");
    check(await selectedInView(list), `emoji ArrowDown step ${step} left the selected row outside the popup`);
  }
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  check((await editor.innerText()).includes(":"), "emoji Escape must keep the typed colon");
  await page.keyboard.type(" :ro");
  await list.waitFor();
  check(await list.getByRole("option").count() === 1, "emoji typed filter did not narrow to one option");
  await page.keyboard.press("Enter");
  await list.waitFor({ state: "detached" });
  check((await editor.innerText()).includes("🚀"), "Enter did not insert the chosen emoji");
  console.log("case passed: emoji popup shares the list look and keyboard pick");
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 } }, api, web, {
    account: { name: "Mention Tester", email: `${slug}@example.test` },
    workspace: { name: "Mention team", slug },
    project: { name: "Mobile", key: "MOB", visibility: "public", shape: "simple" },
  });
  const page = await context.newPage();
  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();

  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  let inaccessibleAgentId: string | undefined;
  for (const name of agentNames) {
    const agent = await call<{ id?: string }>("create_agent", { workspaceId, name, instructions: "", model: "default" });
    check(agent.id !== undefined, `create_agent ${name} failed`);
    if (name === "Grove") inaccessibleAgentId = agent.id;
    // Agents need project access to be picked in a work item comment; the Wiki list does not check it.
    await call("set_agent_project_access", { agentId: agent.id, allProjects: true, projectIds: [] });
  }
  const projects = await call<Array<{ id: string; key: string }>>("list_projects", { workspaceId });
  const project = projects.find((row) => row.key === "MOB")!;
  await call("create_work_item", { projectId: project.id, title: "Mention target" });
  await call("create_wiki_page", { workspaceId, title: "Mention popups", content: { type: "doc", content: [{ type: "paragraph" }] } });
  const wikiPage = (await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId })).find((row) => row.title === "Mention popups")!;

  // Wiki editor, light theme.
  await page.goto(`${web}/${slug}/wiki/${wikiPage.id}`);
  const wikiEditor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await wikiEditor.click();
  await checkMentionPopup(page, wikiEditor, "wiki");

  // Dark theme: the selected row and the popup shadow keep their tokens; the screenshot is for a visual check only.
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await wikiEditor.click();
  await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  const darkList = page.getByRole("listbox", { name: translate("wiki.mentionMembers"), exact: true });
  await darkList.waitFor();
  await page.keyboard.press("ArrowDown");
  check(await darkList.locator('[aria-selected="true"]').evaluate((element) => getComputedStyle(element).backgroundColor) !== "rgba(0, 0, 0, 0)", "dark theme: selected row lost its background");
  if (Bun.env.MENTION_SCREENSHOT) {
    const box = await darkList.boundingBox();
    if (box) await page.screenshot({ path: Bun.env.MENTION_SCREENSHOT, clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 40), width: box.width + 80, height: box.height + 80 } });
  }
  await page.keyboard.press("Escape");
  await darkList.waitFor({ state: "detached" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");
  await checkEmojiPopup(page, wikiEditor);

  // Comment editor on the work item.
  check(inaccessibleAgentId !== undefined, "Grove Agent id was not captured");
  await call("set_agent_access", { agentId: inaccessibleAgentId, userIds: [] });
  await page.goto(`${web}/${slug}/browse/MOB-1`);
  const comment = page.getByTestId("comment-editor").locator(".ProseMirror");
  await comment.click();
  await checkMentionPopup(page, comment, "comment", "Grove");
  console.log("mention-popups: all cases passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  process.exit(failed ? 1 : 0);
}
