// Browser end-to-end flow: design fixes for the workspace and project settings.
// Phone width: every settings route fits without a sideways page scroll, a long member name is not cut off, and the
// Members and access section sits clear of the member list. Desktop: project rows keep one height, settings navigation
// puts the project finder first, one state form targets a workflow group, and the populated Inbox text stays unclipped.
// Run with `bun e2e/design-fixes-settings.e2e.ts` (set DATABASE_URL to an isolated test database).
import { chromium } from "playwright";
import { createDatabase, notifications } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { stateGroupColors } from "../apps/web/src/types";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31440);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52440);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31442);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const longName = "Design Tester With A Long Display Name";
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  // Sign up, make a workspace and a project.
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill(longName);
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Settings fixes");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/actions/create_workspace")), page.getByRole("button", { name: translate("workspace.create") }).click()]);
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("create_project", { workspaceId, name: "Settings archive", key: "SET", visibility: "public" });
  const secondProjectName = "Regional customer support workspace project with a long name";
  await call("create_project", { workspaceId, name: secondProjectName, key: "SUP", visibility: "public" });

  // Every settings route fits the phone and the desktop width without a sideways scroll.
  const routes = ["projects", "settings", "settings/members", "settings/projects/SET", "settings/projects/SET/states", "settings/projects/SET/estimates", "settings/projects/SET/labels", "settings/projects/SET/features"];
  for (const width of [390, 768, 820, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of routes) {
      await page.goto(`${web}/${slug}/${route}`);
      try { await page.getByRole("heading").first().waitFor(); }
      catch { throw new Error(`/${route} did not render a heading at ${width}px: ${await page.locator("body").innerText()}`); }
      check(await noSideScroll(), `/${route} scrolls the page sideways at ${width}px`);
      if (route === "projects") {
        // The content column can clip its own overflow, so measure the header actions against the header itself.
        await page.locator("[data-project-row]").first().waitFor();
        const header = await page.evaluate(() => {
          const node = document.querySelector("[data-testid='page-header']")!;
          const box = node.getBoundingClientRect();
          const controls = [...node.querySelectorAll("input, button, label")].map((control) => control.getBoundingClientRect()).filter((control) => control.width > 1 && control.height > 1);
          return { left: box.left, right: box.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, controls: controls.map((control) => [Math.round(control.left), Math.round(control.right)]) };
        });
        check(header.scrollWidth <= header.clientWidth + 1 && header.controls.every(([left, right]) => left! >= header.left - 1 && right! <= header.right + 1), `the Projects header actions overflow the header at ${width}px: ${JSON.stringify(header)}`);
        console.log(`projects header at ${width}px: ${Math.round(header.right - header.left)}px wide, controls ${JSON.stringify(header.controls)}`);
      }
    }
  }
  console.log("settings ok: Projects and all settings routes fit at 390, 768, 820, 1024 and 1440 without a sideways scroll");

  // The Projects page has one finder, aligns it with the title, and keeps every project row on one shared rhythm.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}/${slug}/projects`);
  const projectFinder = page.getByRole("searchbox", { name: translate("projects.find"), exact: true });
  await projectFinder.waitFor();
  check(await projectFinder.count() === 1, "the Projects page shows duplicate project finders");
  const projectRows = page.locator("[data-project-row]");
  await projectRows.nth(1).waitFor();
  const rowHeights = await projectRows.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  check(rowHeights.every((height) => Math.abs(height - rowHeights[0]!) <= 1), `project rows do not have equal heights: ${rowHeights.join(", ")}`);
  const longProjectName = projectRows.nth(1).locator("a .truncate");
  const projectNameFit = await longProjectName.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    const glyph = range.getBoundingClientRect();
    const truncated = node.scrollWidth > node.clientWidth + 1;
    return { fits: !truncated || (node.getAttribute("title") === node.textContent && getComputedStyle(node).textOverflow === "ellipsis"), glyphInside: glyph.left >= box.left - 1 && glyph.right <= box.right + 1 };
  });
  check(projectNameFit.fits, "a long project name is clipped without an ellipsis and a full-text title");
  check(projectNameFit.glyphInside, "project-name glyphs render outside their text box");
  const headerCenters = await page.evaluate(() => {
    const title = document.querySelector("[data-testid='page-header'] h1")!.getBoundingClientRect();
    const input = document.querySelector("[data-testid='page-header'] input")!.getBoundingClientRect();
    return [title.top + title.height / 2, input.top + input.height / 2];
  });
  check(Math.abs(headerCenters[0]! - headerCenters[1]!) <= 1, `Projects title and finder centers differ: ${headerCenters.join(", ")}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/projects`);
  await page.getByRole("searchbox", { name: translate("projects.find"), exact: true }).waitFor();
  await page.locator("[data-project-row]").first().waitFor();
  const phoneHeaderBounds = await page.evaluate(() => {
    const title = document.querySelector("[data-testid='page-header'] h1")!.getBoundingClientRect();
    const search = document.querySelector("[data-testid='page-header'] input")!.getBoundingClientRect();
    const rowRight = document.querySelector("[data-project-row]")!.getBoundingClientRect().right;
    return { title, search, rowRight, pageWidth: document.documentElement.scrollWidth };
  });
  const phoneLongName = await page.locator("[data-project-row]").filter({ hasText: secondProjectName }).locator("a .truncate").evaluate((node) => ({ truncated: node.scrollWidth > node.clientWidth + 1, title: node.getAttribute("title"), text: node.textContent, ellipsis: getComputedStyle(node).textOverflow === "ellipsis" }));
  check(phoneLongName.truncated && phoneLongName.ellipsis && phoneLongName.title === phoneLongName.text, `the long project name at 390px is not truncated with an ellipsis and a full-text title: ${JSON.stringify(phoneLongName)}`);
  check(phoneHeaderBounds.pageWidth <= 390 && phoneHeaderBounds.search.right <= phoneHeaderBounds.rowRight + 1 && (phoneHeaderBounds.title.bottom <= phoneHeaderBounds.search.top || phoneHeaderBounds.search.bottom <= phoneHeaderBounds.title.top), `Projects title and search overlap or overflow on phone: ${JSON.stringify(phoneHeaderBounds)}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("projects ok: one finder, aligned header, equal row heights, measured title text");

  // Workspace settings moves the project picker ahead of the long settings list and keeps all input surfaces consistent.
  await page.goto(`${web}/${slug}/settings`);
  const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });
  const settingsFinder = sidebar.getByRole("searchbox", { name: translate("projects.find"), exact: true });
  await settingsFinder.waitFor();
  check(await sidebar.getByRole("link", { name: translate("inbox.navLabel"), exact: true }).count() === 0, "Inbox still appears in the Settings navigation");
  const projectSection = await settingsFinder.evaluate((node) => node.closest("label")!.previousElementSibling!.getBoundingClientRect().top);
  const workspaceHeading = await sidebar.getByText(translate("sidebar.workspace"), { exact: true }).boundingBox();
  check(workspaceHeading !== null && projectSection < workspaceHeading.y, "the project picker appears below the Workspace settings group");
  const inputStyle = (label: string) => page.getByLabel(label).evaluate((node) => ({ height: node.getBoundingClientRect().height, background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color, readOnly: (node as HTMLInputElement).readOnly, tabIndex: (node as HTMLInputElement).tabIndex }));
  // Run limits are disabled until the admin check loads; measure them once they are editable and colour transitions settle.
  await page.waitForFunction((labels) => labels.every((label) => [...document.querySelectorAll("label")].some((node) => node.textContent?.startsWith(label) && node.querySelector("input:not(:disabled)"))), [translate("settings.runsPerPersonPerHour"), translate("settings.runsPerAgentPerHour")]);
  await page.waitForTimeout(300);
  const editableStyles = await Promise.all([translate("settings.runsPerPersonPerHour"), translate("settings.runsPerAgentPerHour")].map(inputStyle));
  const readOnlyStyles = await Promise.all([translate("settings.workspaceName"), translate("settings.workspaceUrl")].map(inputStyle));
  const inputStyles = [...editableStyles, ...readOnlyStyles];
  check(inputStyles.every((style) => Math.abs(style.height - inputStyles[0]!.height) <= 1), `workspace inputs differ in height: ${JSON.stringify(inputStyles)}`);
  check(editableStyles.every((style) => style.background === editableStyles[0]!.background), `editable workspace inputs use inconsistent surfaces: ${JSON.stringify(editableStyles)}`);
  check(readOnlyStyles.every((style) => style.readOnly && style.tabIndex < 0 && style.background !== editableStyles[0]!.background && style.color !== editableStyles[0]!.color), `read-only workspace inputs look editable or sit in the tab order: ${JSON.stringify({ readOnlyStyles, editableStyles })}`);
  const dangerButton = page.getByRole("button", { name: translate("settings.leave"), exact: true });
  const dangerStyles = await dangerButton.evaluate((node) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--destructive)";
    document.body.append(probe);
    const expectedDanger = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = "var(--border)";
    const neutralBorder = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = "var(--background)";
    const pageBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color, borderWidth: style.borderTopWidth, borderColor: style.borderTopColor, expectedDanger, neutralBorder, pageBackground };
  });
  check(dangerStyles.background !== dangerStyles.expectedDanger, "the danger-zone action is still a filled destructive button");
  // Outlined destructive: no coloured fill (transparent or the page background), destructive text, a visible border that is not the neutral one.
  check((dangerStyles.background === "rgba(0, 0, 0, 0)" || dangerStyles.background === dangerStyles.pageBackground) && dangerStyles.color === dangerStyles.expectedDanger && parseFloat(dangerStyles.borderWidth) >= 1 && dangerStyles.borderColor !== dangerStyles.neutralBorder && dangerStyles.borderColor !== "rgba(0, 0, 0, 0)", `the danger-zone action is not an outlined destructive button: ${JSON.stringify(dangerStyles)}`);
  // Workspace navigation: the section links stack without overlapping boxes, share one row height, and the divider adds no row.
  const navLinkNames = [translate("settings.general"), translate("members.title"), translate("settings.invites"), translate("settings.agents"), translate("settings.connectAi"), translate("tokens.title"), translate("runtimes.title"), translate("settings.skills"), translate("settings.exports"), translate("settings.projectOrder")];
  const navBoxes = await Promise.all(navLinkNames.map((name) => sidebar.getByRole("link", { name, exact: true }).boundingBox()));
  check(navBoxes.every((box) => box !== null), "a Workspace settings link is missing from the navigation");
  const navGaps = navBoxes.slice(1).map((box, index) => box!.y - (navBoxes[index]!.y + navBoxes[index]!.height));
  check(navGaps.every((gap) => gap >= -1), `Workspace settings links overlap: ${navGaps.join(", ")}`);
  const navHeights = navBoxes.map((box) => box!.height);
  check(navHeights.every((height) => Math.abs(height - navHeights[0]!) <= 1), `Workspace settings link rows differ in height: ${navHeights.join(", ")}`);
  console.log("settings ok: project picker is first, navigation is clean, inputs match and danger action is outlined");

  // Members at phone width: the long name is shown whole, and the Members and access section is clear of the list above it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/settings/members`);
  const memberName = page.getByText(longName, { exact: true }).first();
  await memberName.waitFor();
  const nameWhole = await memberName.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
  check(nameWhole, "a long member name is cut off on phone width");
  const heading = page.getByRole("heading", { name: translate("account.adminTitle"), exact: true });
  const listBottom = await memberName.evaluate((node) => node.closest("ul")!.getBoundingClientRect().bottom);
  const gap = (await heading.boundingBox())!.y - listBottom;
  check(gap >= 24, `the Members and access heading sits ${gap}px below the member list; expected at least 24px`);
  console.log("members ok: long name whole on phone, section clear of the list");

  // States at desktop width: one add form targets the selected group and state rows share a height.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}/${slug}/settings/projects/SET/states`);
  const startedBlock = page.locator("section").filter({ has: page.getByRole("heading", { name: translate("states.group.started") }) }).last();
  await startedBlock.getByRole("heading", { name: translate("states.group.started") }).waitFor();
  const backLink = page.getByRole("link", { name: translate("sidebar.backToWorkspace"), exact: true });
  const backText = await backLink.locator("span").evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
  check(backText, "the project settings back link text is clipped");
  const projectSectionLink = page.getByRole("link", { name: translate("settings.general"), exact: true });
  const navMetrics = await Promise.all([backLink, projectSectionLink].map((link) => link.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const iconNode = node.querySelector("svg");
    const icon = iconNode?.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();
    return { height: box.height, iconCenter: icon ? icon.top + icon.height / 2 : null, textCenter: text.top + text.height / 2 };
  })));
  check(Math.abs(navMetrics[0]!.height - navMetrics[1]!.height) <= 1, `project settings navigation rows differ in height: ${JSON.stringify(navMetrics)}`);
  check(navMetrics[0]!.iconCenter !== null && Math.abs(navMetrics[0]!.iconCenter - navMetrics[0]!.textCenter) <= 1, `the project settings back arrow and label do not share a center: ${JSON.stringify(navMetrics[0])}`);
  check(await backLink.getAttribute("title") === translate("sidebar.backToWorkspace"), "the truncated project settings back link does not reveal its full text");
  check((await page.getByLabel(translate("states.name"), { exact: true }).count()) === 0, "the add field shows before Add state is pressed");
  check(await page.getByRole("button", { name: translate("states.add"), exact: true }).count() === 1, "States shows more than one Add state action");
  const stateRows = await page.locator("section section ul.rounded-lg li").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  if (stateRows.length > 1) check(stateRows.every((height) => Math.abs(height - stateRows[0]!) <= 1), `state rows do not have equal heights: ${stateRows.join(", ")}`);
  const reveal = page.getByRole("button", { name: translate("states.add"), exact: true });
  await reveal.click();
  check((await reveal.getAttribute("aria-expanded")) === "true", "Add state does not report that it is open");
  // The State group is named as such (not "Group by"), has no silent default, and takes focus first.
  check(await page.getByLabel(translate("layout.group"), { exact: true }).count() === 0, "the add form labels the State group as Group by");
  const groupSelect = page.getByLabel(translate("analytics.axis.stateGroup"), { exact: true });
  check(await groupSelect.inputValue() === "", "the add form preselects a State group");
  check(await groupSelect.evaluate((node) => node === document.activeElement), "the State group is not focused when the add form opens");
  const statesBefore = (await call<unknown[]>("list_states", { projectId: project.id })).length;
  await page.getByLabel(translate("states.name"), { exact: true }).fill("No group chosen");
  await page.getByLabel(translate("states.name"), { exact: true }).press("Enter");
  await Bun.sleep(300);
  check((await call<unknown[]>("list_states", { projectId: project.id })).length === statesBefore && await groupSelect.count() === 1, "Enter without a State group created a state");
  await page.getByRole("button", { name: translate("settings.cancel"), exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "add-state");
  await reveal.click();
  check(await page.getByLabel(translate("states.name"), { exact: true }).inputValue() === "", "Cancel kept the typed state name");
  await groupSelect.selectOption("started");
  await page.getByLabel(translate("states.name"), { exact: true }).fill("Review");
  await page.getByRole("button", { name: translate("states.create"), exact: true }).click();
  await startedBlock.getByText("Review", { exact: true }).waitFor();
  check((await page.getByLabel(translate("states.name"), { exact: true }).count()) === 0, "the add field stays open after a state is created");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "add-state");
  check(await page.getByRole("button", { name: translate("states.add"), exact: true }).count() === 1, "creating a state duplicates the Add state action");
  console.log("states ok: one add form asks for the State group, targets Started, creates a state, closes and returns focus");

  // Analytics keeps numeric headings separated and gives completed/cancelled status bars distinct state colours.
  const states = await call<Array<{ id: string; name: string; group: string }>>("list_states", { projectId: project.id });
  const completedState = states.find((state) => state.group === "completed")!;
  const cancelledState = states.find((state) => state.group === "cancelled")!;
  await call("create_work_item", { projectId: project.id, title: "Completed analytics fixture", stateId: completedState.id });
  await call("create_work_item", { projectId: project.id, title: "Cancelled analytics fixture", stateId: cancelledState.id });
  await page.goto(`${web}/${slug}/analytics/overview`);
  const analyticsTable = page.getByRole("table", { name: translate("analytics.projectList") });
  await analyticsTable.waitFor();
  const numericHeaders = analyticsTable.getByRole("columnheader").filter({ hasText: new RegExp([translate("analytics.total"), translate("analytics.open"), translate("analytics.completed")].map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")) });
  const headerTextBounds = await numericHeaders.evaluateAll((nodes) => nodes.map((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const glyph = range.getBoundingClientRect();
    return { left: glyph.left, right: glyph.right, alignment: getComputedStyle(node).textAlign };
  }));
  check(headerTextBounds.length === 3 && headerTextBounds.every((box) => box.alignment === "right"), `Analytics numeric headings are not right-aligned: ${JSON.stringify(headerTextBounds)}`);
  check(headerTextBounds.slice(0, -1).every((box, index) => box.right < headerTextBounds[index + 1]!.left), `Analytics numeric heading glyphs overlap: ${JSON.stringify(headerTextBounds)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/analytics/overview`);
  const phoneTable = page.getByRole("table", { name: translate("analytics.projectList") });
  await phoneTable.waitFor();
  const phoneTableFits = await phoneTable.evaluate((node) => {
    const parent = node.parentElement!;
    const bounds = parent.getBoundingClientRect();
    const text = [...node.querySelectorAll("thead th")].map((header) => {
      const visual = [...header.querySelectorAll<HTMLElement>("span")].filter((span) => !span.classList.contains("sr-only") && getComputedStyle(span).display !== "none");
      const targets: Node[] = visual.length ? visual : [...header.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE);
      const glyphs = targets.flatMap((target) => { const range = document.createRange(); range.selectNodeContents(target); return [...range.getClientRects()]; });
      const left = Math.min(...glyphs.map((glyph) => glyph.left));
      const right = Math.max(...glyphs.map((glyph) => glyph.right));
      return glyphs.length > 0 && left >= bounds.left - 1 && right <= bounds.right + 1;
    });
    const rows = [...node.querySelectorAll("tbody tr")];
    const rowHeights = rows.map((row) => row.getBoundingClientRect().height);
    // A name shows whole, or it is line-clamped (ellipsis on the last line) and carries its full text in a title.
    const nameStates = [...node.querySelectorAll<HTMLElement>("tbody th [title]")].map((name) => {
      const clipped = name.scrollHeight > name.clientHeight + 1 || name.scrollWidth > name.clientWidth + 1;
      const clamp = getComputedStyle(name).webkitLineClamp;
      return { clipped, ok: !clipped || (name.title === name.textContent && clamp !== "none" && clamp !== "") };
    });
    const names = nameStates.map((name) => name.ok);
    const clampedNames = nameStates.filter((name) => name.clipped).length;
    return { fits: node.scrollWidth <= parent.clientWidth + 1, text, rowHeights, names, clampedNames, tableWidth: node.getBoundingClientRect().width, tableScrollWidth: node.scrollWidth, parentWidth: parent.clientWidth, parentScrollWidth: parent.scrollWidth };
  });
  check(phoneTableFits.fits && phoneTableFits.text.every(Boolean) && phoneTableFits.rowHeights.every((height) => Math.abs(height - phoneTableFits.rowHeights[0]!) <= 1) && phoneTableFits.names.length > 0 && phoneTableFits.names.every(Boolean) && phoneTableFits.clampedNames > 0 && await noSideScroll(), `Analytics table rows or heading glyphs clip at 390px: ${JSON.stringify(phoneTableFits)}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}/${slug}/analytics/work-items`);
  await page.getByRole("heading", { name: translate("analytics.insights"), exact: true }).waitFor();
  const axisControls = page.locator("[data-slot='select-trigger']");
  await axisControls.nth(1).waitFor();
  const axisLabels = await axisControls.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  check(axisLabels.includes(translate("analytics.xAxis")) && axisLabels.includes(translate("analytics.groupBy")), `Analytics selects do not expose their visible labels: ${JSON.stringify(axisLabels)}`);
  // The accessible name comes from the visible label, and the trigger shows the translated option, never the internal value.
  const xAxisSelect = page.getByRole("combobox", { name: translate("analytics.xAxis"), exact: true });
  const groupBySelect = page.getByRole("combobox", { name: translate("analytics.groupBy"), exact: true });
  const shownValues = [(await xAxisSelect.innerText()).trim(), (await groupBySelect.innerText()).trim()];
  check(shownValues[0] === translate("analytics.axis.state") && shownValues[1] === translate("analytics.groupNone"), `Analytics selects show internal values instead of their labels: ${JSON.stringify(shownValues)}`);
  const waitForGroupByText = async (label: string) => {
    for (let attempt = 0; attempt < 50 && (await groupBySelect.innerText()).trim() !== label; attempt += 1) await Bun.sleep(100);
    const shown = (await groupBySelect.innerText()).trim();
    check(shown === label, `the Group by select shows "${shown}" instead of "${label}"`);
  };
  await groupBySelect.click();
  await page.getByRole("option", { name: translate("analytics.axis.priority"), exact: true }).click();
  await waitForGroupByText(translate("analytics.axis.priority"));
  await groupBySelect.click();
  await page.getByRole("option", { name: translate("analytics.groupNone"), exact: true }).click();
  await waitForGroupByText(translate("analytics.groupNone"));
  const doneBar = page.getByRole("img", { name: /^Done:/ });
  const cancelledBar = page.getByRole("img", { name: /^Cancelled:/ });
  await doneBar.waitFor();
  await cancelledBar.waitFor();
  const semanticColors = await page.evaluate((colors) => {
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.backgroundColor = colors.completed;
    const completed = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = colors.cancelled;
    const cancelled = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { completed, cancelled };
  }, stateGroupColors);
  await page.waitForFunction(({ completed, cancelled }) => {
    const done = [...document.querySelectorAll<HTMLElement>("[role='img']")].find((node) => node.getAttribute("aria-label")?.startsWith("Done:"));
    const stopped = [...document.querySelectorAll<HTMLElement>("[role='img']")].find((node) => node.getAttribute("aria-label")?.startsWith("Cancelled:"));
    return Boolean(done && stopped && getComputedStyle(done.querySelector("span")!).backgroundColor === completed && getComputedStyle(stopped.querySelector("span")!).backgroundColor === cancelled);
  }, semanticColors, { timeout: 5000 });
  const [doneColor, cancelledColor] = await Promise.all([doneBar.locator("span").first().evaluate((node) => getComputedStyle(node).backgroundColor), cancelledBar.locator("span").first().evaluate((node) => getComputedStyle(node).backgroundColor)]);
  check(doneColor === semanticColors.completed && cancelledColor === semanticColors.cancelled, `Analytics state bars have incorrect semantic colours: ${JSON.stringify({ doneColor, cancelledColor, semanticColors })}`);
  console.log("analytics ok: numeric heading glyphs align, controls are labelled, status bars have distinct colours");

  // Seed Notifications because self-actions do not notify their author; check the populated Inbox text against its rendered row.
  const user = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string } };
  const inboxItem = await call<{ id: string }>("create_work_item", { projectId: project.id, title: "Inbox layout fixture" });
  const database = createDatabase();
  await database.db.insert(notifications).values([
    { workspaceId, userId: user.user.id, actorId: user.user.id, kind: "mention", workItemId: inboxItem.id, jobId: crypto.randomUUID() },
    { workspaceId, userId: user.user.id, actorId: user.user.id, kind: "secret_output_blocked", detail: null, readAt: new Date(), jobId: crypto.randomUUID() },
  ]);
  await database.client.end();
  await page.goto(`${web}/${slug}/notifications`);
  const notificationRows = page.locator("li").filter({ has: page.locator("div[id^='notification-description-']") });
  await notificationRows.first().waitFor();
  check(await notificationRows.count() === 2, "the Inbox populated-state fixture did not render both notifications");
  const notificationTextBounds = await notificationRows.evaluateAll((rows) => rows.map((row) => {
    const content = row.querySelector("div[id^='notification-description-']")!;
    const bounds = content.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(content);
    const glyph = range.getBoundingClientRect();
    const boxes = [...row.children].map((child) => child.getBoundingClientRect());
    const overlaps = boxes.some((box, index) => boxes.slice(index + 1).some((next) => Math.min(box.right, next.right) - Math.max(box.left, next.left) > 1 && Math.min(box.bottom, next.bottom) - Math.max(box.top, next.top) > 1));
    return { inside: glyph.left >= bounds.left - 1 && glyph.right <= bounds.right + 1 && glyph.top >= bounds.top - 1 && glyph.bottom <= bounds.bottom + 1, visible: content.scrollHeight <= content.clientHeight + 1 || getComputedStyle(content).overflowY !== "hidden", overlaps };
  }));
  check(notificationTextBounds.every((item) => item.inside && item.visible && !item.overlaps), `Inbox notification text clips, overlaps, or escapes its row: ${JSON.stringify(notificationTextBounds)}`);
  console.log("inbox ok: populated rows keep measured text inside their content boxes");

  // A real coarse-pointer context keeps the key controls reachable at touch target size.
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  const touchPage = await touchContext.newPage();
  const assertTouchTargets = async (selector: string, label: string) => {
    const heights = await touchPage.locator(selector).evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).map((node) => node.getBoundingClientRect().height));
    check(heights.length > 0 && heights.every((height) => height >= 44), `${label} has undersized touch targets: ${heights.join(", ")}`);
  };
  const assertTouchWidths = async (selector: string, label: string) => {
    const widths = await touchPage.locator(selector).evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).map((node) => node.getBoundingClientRect().width));
    check(widths.length > 0 && widths.every((width) => width >= 44), `${label} has undersized touch widths: ${widths.join(", ")}`);
  };
  await touchPage.goto(`${web}/${slug}/projects`);
  await touchPage.getByRole("button", { name: translate("projects.new"), exact: true }).waitFor();
  await touchPage.locator("[data-project-row] button[aria-label^='Star project']").first().waitFor();
  await assertTouchTargets("[data-project-row] button[aria-label^='Star project']", "project star");
  await assertTouchWidths("[data-project-row] button[aria-label^='Star project']", "project star");
  await assertTouchTargets("[data-testid='page-header'] button", "Projects page action");
  await assertTouchTargets("[data-testid='page-header'] label:has([role='checkbox'])", "Show archived projects");
  await touchPage.goto(`${web}/${slug}/settings/projects/SET/states`);
  await touchPage.getByRole("button", { name: new RegExp(`^${translate("sortable.reorder")}`) }).first().waitFor();
  await assertTouchTargets("button[aria-label^='Reorder']", "state reorder handle");
  await assertTouchTargets("button[data-testid='add-state']", "Add state action");
  await touchPage.goto(`${web}/${slug}/analytics/work-items`);
  await touchPage.locator("[data-slot='select-trigger']").first().waitFor();
  await assertTouchTargets("[role='combobox']", "Analytics selects");
  await touchPage.goto(`${web}/${slug}/notifications`);
  await touchPage.locator("button[aria-labelledby^='notification-action-']").first().waitFor();
  await assertTouchTargets("button[aria-labelledby^='notification-action-']", "Inbox read-state action");
  await touchContext.close();
  console.log("touch ok: Projects, States, Analytics and Inbox controls meet the 44px target size");

  console.log("design fixes settings: all checks passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  process.exit(failed ? 1 : 0);
}
