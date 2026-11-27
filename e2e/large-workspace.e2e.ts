// Measures Workspace View discovery and completeness against a large fixture.
// Run with `bun e2e/run-all.ts large-workspace` against a dedicated migrated test database.
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import { asc, eq, like } from "drizzle-orm";
import { createDatabase, labels, projects, workItemLabels, workItemStates, workItems, users, workspaces, workspaceMembers } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { mkdir } from "node:fs/promises";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3129);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5229);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = "/home/plong/workspace/weft/.local/continuous-improvements/workspace-performance";
const { client, db } = createDatabase();
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api }),
];

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await mkdir(shots, { recursive: true });
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 } }, api, web, {
    account: { name: "Scale Tester", email: `${slug}@example.test` },
    workspace: { name: "Scale team", slug },
    project: { name: "Scale Project 000", key: "SCL000", visibility: "public", shape: "simple" },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as Window & { __workspaceLongTasks?: number[] }).__workspaceLongTasks = [];
    new PerformanceObserver((entries) => {
      (window as Window & { __workspaceLongTasks: number[] }).__workspaceLongTasks.push(...entries.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask", buffered: true });
  });
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name} failed: ${response.status()} ${await response.text()}`);
    return await response.json() as T;
  };
  await page.goto(`${web}/${slug}`);
  await page.getByRole("link", { name: /SCL000 · Scale Project 000/ }).waitFor();

  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }>; user: { id: string } };
  const workspaceId = me.workspaces[0]!.id;
  const [template] = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId));
  const [states] = await Promise.all([
    db.select().from(workItemStates).where(eq(workItemStates.projectId, template!.id)).orderBy(asc(workItemStates.sortOrder)),
  ]);
  const otherMembers = Array.from({ length: 74 }, (_, index) => ({ id: crypto.randomUUID(), name: `Scale Member ${String(index + 1).padStart(2, "0")}`, email: `${slug}-member-${index + 1}@example.test` }));
  await db.insert(users).values(otherMembers);
  await db.insert(workspaceMembers).values(otherMembers.map((member) => ({ workspaceId, userId: member.id, role: "Member" })));
  const peopleIds = [me.user.id, ...otherMembers.map((member) => member.id)];
  const memberStarted = performance.now();
  const listedMembers = await call<Array<{ userId: string }>>("list_members", { workspaceId });
  console.log(`Member discovery observation: members=${listedMembers.length}, responseMs=${Math.round(performance.now() - memberStarted)}`);
  const agentIds: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const agent = await call<{ id: string }>("create_agent", { workspaceId, name: `Scale Agent ${index + 1}`, instructions: "", model: "default" });
    agentIds.push(agent.id);
    await call("set_agent_access", { agentId: agent.id, userIds: peopleIds });
  }
  const accessStarted = performance.now();
  const manageable = await call<Array<{ id: string; accessUserIds: string[] }>>("list_manageable_agent_access", { workspaceId });
  const accessMs = Math.round(performance.now() - accessStarted);
  check(manageable.length === 5 && manageable.every((agent) => agent.accessUserIds.length === peopleIds.length), "Agent access discovery did not return all five grants");
  console.log(`Agent access observation: agents=${manageable.length}, grantsPerAgent=${peopleIds.length}, responseMs=${accessMs}`);

  const projectRows = Array.from({ length: 249 }, (_, index) => ({
    ...template!, id: crypto.randomUUID(), key: `SCL${String(index + 1).padStart(3, "0")}`,
    name: `Scale Project ${String(index + 1).padStart(3, "0")}`,
  }));
  await db.insert(projects).values(projectRows);
  const allProjects = [template!, ...projectRows];
  const projectStarted = performance.now();
  const discoveredProjects = await call<Array<{ id: string }>>("list_projects", { workspaceId });
  const projectsMs = Math.round(performance.now() - projectStarted);
  check(discoveredProjects.length === 250, `expected 250 discoverable Projects, got ${discoveredProjects.length}`);
  console.log(`Project discovery observation: projects=${discoveredProjects.length}, responseMs=${projectsMs}`);
  const clonedStates = projectRows.flatMap((project) => states.map((state) => ({ ...state, id: crypto.randomUUID(), projectId: project.id })));
  await db.insert(workItemStates).values(clonedStates);
  const stateByProject = new Map<string, string>([[template!.id, states[0]!.id]]);
  for (let index = 0; index < projectRows.length; index += 1) stateByProject.set(projectRows[index]!.id, clonedStates[index * states.length]!.id);
  const fixture = allProjects.flatMap((project, projectIndex) => Array.from({ length: 10 }, (_, itemIndex) => ({
    id: crypto.randomUUID(), workspaceId, projectId: project.id, sequence: itemIndex + 1, title: `Scale ${String(projectIndex).padStart(3, "0")} item ${String(itemIndex + 1).padStart(2, "0")}`,
    stateId: stateByProject.get(project.id)!, sortOrder: itemIndex, createdBy: me.user.id,
  })));
  for (let offset = 0; offset < fixture.length; offset += 500) await db.insert(workItems).values(fixture.slice(offset, offset + 500));
  const fixtureLabels = allProjects.map((project, index) => ({ id: crypto.randomUUID(), workspaceId, projectId: project.id, name: `Scale Label ${index}`, color: "#4488cc" }));
  await db.insert(labels).values(fixtureLabels);
  const firstItemPerProject = new Map<string, string>();
  for (const item of fixture) if (!firstItemPerProject.has(item.projectId)) firstItemPerProject.set(item.projectId, item.id);
  await db.insert(workItemLabels).values(fixtureLabels.map((label) => ({ workItemId: firstItemPerProject.get(label.projectId)!, labelId: label.id })));

  // The last of 250 Projects is discoverable from the navigation by key and name, on desktop and phone.
  await page.goto(`${web}/${slug}`);
  const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });
  const projectSearch = sidebar.getByRole("searchbox", { name: translate("projects.find") });
  await projectSearch.fill("SCL249");
  const projectResult = sidebar.getByRole("button", { name: `${translate("sidebar.toggleProject")}: Scale Project 249` });
  await projectResult.waitFor();
  check(await sidebar.getByRole("button", { name: new RegExp(`^${translate("sidebar.toggleProject")}:`) }).count() === 1, "Project search did not narrow the 250-project navigation to one result");
  await projectResult.click();
  const projectNav = page.getByRole("navigation", { name: `${translate("projectNav.label")} SCL249` });
  await projectNav.getByRole("link", { name: translate("workItems.title") }).click();
  await page.waitForURL(new RegExp(`/${slug}/projects/SCL249`));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  const mobileSidebar = page.getByRole("dialog", { name: translate("shell.sidebar") });
  const mobileProjectSearch = mobileSidebar.getByRole("searchbox", { name: translate("projects.find") });
  await mobileProjectSearch.fill("SCL249");
  await mobileSidebar.getByRole("button", { name: `${translate("sidebar.toggleProject")}: Scale Project 249` }).waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth), "Project search widened the page on mobile");
  await mobileSidebar.getByRole("button", { name: translate("shell.closeMenu") }).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  // The full Projects directory has the same name/key search for selection outside the sidebar.
  await page.goto(`${web}/${slug}/projects`);
  const directorySearch = page.locator("#main-content").getByRole("searchbox", { name: translate("projects.find") });
  await directorySearch.fill("SCL249");
  const directory = page.locator("#main-content").getByRole("list", { name: translate("projects.title") });
  await directory.getByRole("link", { name: "SCL249 · Scale Project 249" }).waitFor();
  check(await directory.getByRole("listitem").count() === 1, "Projects directory search did not narrow results to one Project");
  await saveShot(page, { path: `${shots}/project-search-1440.png`, fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await saveShot(page, { path: `${shots}/project-search-390.png`, fullPage: false });
  check(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth), "Projects directory search widened the page on mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  await directorySearch.fill("no-such-project");
  await page.getByRole("status").filter({ hasText: translate("projects.noSearchResults") }).waitFor();

  // Project access is another long selection list: filtering one Project must leave other access choices intact.
  await page.goto(`${web}/${slug}/settings/agents`);
  const firstAgent = page.locator('[data-agent="Scale Agent 1"]');
  await firstAgent.waitFor();
  const access = firstAgent.getByRole("group", { name: translate("agents.access") });
  const allProjectToggle = access.getByRole("checkbox", { name: translate("agents.allProjects") });
  if (await allProjectToggle.getAttribute("aria-checked") === "true") await allProjectToggle.click();
  const accessSearch = access.getByRole("searchbox", { name: translate("projects.find") });
  await accessSearch.fill("SCL249");
  const targetProject = access.getByRole("checkbox", { name: "SCL249 · Scale Project 249" });
  await targetProject.click();
  await accessSearch.fill("SCL248");
  await access.getByRole("checkbox", { name: "SCL248 · Scale Project 248" }).waitFor();
  await access.getByRole("button", { name: translate("agents.save"), exact: true }).click();
  await accessSearch.fill("SCL249");
  check(await targetProject.getAttribute("aria-checked") === "true", "filtering another Project removed the selected Project from Agent access");

  const started = performance.now();
  const measured = await call<{ items: Array<{ displayId: string; labelIds: string[] }>; truncated: boolean }>("list_workspace_work_items_with_metadata", { workspaceId });
  const apiMs = Math.round(performance.now() - started);
  const payloadBytes = Buffer.byteLength(JSON.stringify(measured));
  check(measured.items.length === 2000 && measured.truncated, `expected a disclosed 2,000-row cap, got ${measured.items.length} rows and truncated=${measured.truncated}`);
  console.log(`fixture: workspaceMembers=${1 + otherMembers.length + agentIds.length} (people=${peopleIds.length}, agents=${agentIds.length}), projects=${allProjects.length}, workItems=${fixture.length}`);
  console.log(`action observation: returned=${measured.items.length}, truncated=${measured.truncated}, responseMs=${apiMs}, payloadBytes=${payloadBytes}`);

  const renderStarted = performance.now();
  const actionRequests: string[] = [];
  let metadataResponseMs: number | null = null;
  const actionStarted = new WeakMap<object, number>();
  const workItemsResponseMs: number[] = [];
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(/^\/actions\/([^/]+)$/);
    if (match) {
      actionRequests.push(match[1]!);
      actionStarted.set(request, performance.now());
    }
  });
  page.on("response", (response) => {
    const elapsed = Math.round(performance.now() - (actionStarted.get(response.request()) ?? performance.now()));
    const path = new URL(response.url()).pathname;
    if (path === "/actions/list_workspace_view_metadata") metadataResponseMs = elapsed;
    if (path === "/actions/list_workspace_work_items_with_metadata") workItemsResponseMs.push(elapsed);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metricsBefore = await cdp.send("Performance.getMetrics");
  await page.evaluate(() => (window as Window & { __workspaceLongTasks: number[] }).__workspaceLongTasks.splice(0));
  await page.goto(`${web}/${slug}/workspace-views/all-issues`);
  await page.getByRole("status").filter({ hasText: "Showing the first 2,000" }).waitFor();
  await page.getByTestId("row-SCL000-1").waitFor().catch(() => undefined);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length === 2000, null, { timeout: 120_000 });
  const navigationToRowsMs = Math.round(performance.now() - renderStarted);
  const stateLabelRequests = actionRequests.filter((name) => name === "list_states" || name === "list_labels").length;
  if (Bun.env.EXPECT_OPTIMIZED === "true") {
    check(stateLabelRequests === 0, `Workspace View made ${stateLabelRequests} per-Project state/label requests`);
    check(actionRequests.filter((name) => name === "list_workspace_view_metadata").length === 1, `expected one workspace metadata request, got ${actionRequests.join(", ")}`);
  }
  console.log(`Workspace View request observation: actions=${actionRequests.length}, perProjectStateLabelRequests=${stateLabelRequests}, metadataResponseMs=${metadataResponseMs ?? "missing"}, navigationToRowsMs=${navigationToRowsMs}`);
  const renderedRows = await page.locator('[data-testid^="row-"]').count();
  const browserMetrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return {
      domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd - navigation.startTime),
      loadEventMs: Math.round(navigation.loadEventEnd - navigation.startTime),
      longTasks: (window as Window & { __workspaceLongTasks: number[] }).__workspaceLongTasks,
      nodeCount: document.getElementsByTagName("*").length,
    };
  });
  const { metrics } = await cdp.send("Performance.getMetrics");
  const before = new Map(metricsBefore.metrics.map((entry) => [entry.name, entry.value]));
  const metric = (name: string) => Number((metrics.find((entry) => entry.name === name)?.value ?? 0) - (before.get(name) ?? 0)).toFixed(3);
  console.log(`browser profile: ${JSON.stringify({ ...browserMetrics, workItemsResponseMs, metadataResponseMs, scriptDurationSeconds: metric("ScriptDuration"), layoutDurationSeconds: metric("LayoutDuration"), recalcStyleDurationSeconds: metric("RecalcStyleDuration"), jsHeapUsedBytes: metrics.find((entry) => entry.name === "JSHeapUsedSize")?.value ?? null })}`);
  const firstRow = page.getByTestId("row-SCL000-1");
  await firstRow.getByText("Scale Label 0", { exact: true }).waitFor();
  await firstRow.getByText("Backlog", { exact: true }).waitFor();
  await saveShot(page, { path: `${shots}/workspace-view-1440.png`, fullPage: false });
  console.log(`browser observation desktop: rows=${renderedRows}, navigationToRowsMs=${navigationToRowsMs}, screenshot=${shots}/workspace-view-1440.png`);

  await page.setViewportSize({ width: 390, height: 844 });
  await saveShot(page, { path: `${shots}/workspace-view-390.png`, fullPage: false });
  const overflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth, table: document.querySelector('[data-testid="sheet-scroll"]')?.scrollWidth ?? 0 }));
  console.log(`browser observation mobile: viewport=${overflow.viewport}, page=${overflow.page}, sheetScrollWidth=${overflow.table}, screenshot=${shots}/workspace-view-390.png`);
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
