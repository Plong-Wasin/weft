// Captures Work item, Page, and Wiki page Outlinks/Backlinks at desktop and phone widths in English and Thai.
import { check, launchBrowser, newPage, startApi, startWeb, waitFor } from "./harness";
import { mkdirSync } from "node:fs";
import type { Route } from "playwright";
import { createDatabase } from "../packages/db/src";
import { createMemberFactory } from "../packages/db/src/test-helpers";
import { createProjectActions, createWikiActions, createWorkItemActions } from "../packages/actions/src";
import { translate, type Locale } from "../packages/shared/src";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31267);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52267);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const captureDir = `${process.cwd()}/.scratch-captures`;
const servers = [
  startApi(apiPort, web),
  startWeb(webPort, { api, env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true" } }),
];
const { client, db } = createDatabase();
let failed = false;

try {
  mkdirSync(captureDir, { recursive: true });
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const page = await newPage(browser, { viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const slug = `outlinks-${crypto.randomUUID().slice(0, 8)}`;
  const call = async <T>(name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name} failed (${response.status()}): ${await response.text()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Links Reviewer");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Link review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const ownerId = me.user.id;
  const projects = createProjectActions(db);
  const workItems = createWorkItemActions(db);
  const wiki = createWikiActions(db);
  const project = await projects.createProject.handler({ userId: ownerId }, { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  const target = await workItems.createWorkItem.handler({ userId: ownerId }, { projectId: project.id, title: "Release plan" });
  const projectPage = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, projectId: project.id, title: "Project handbook" });
  const wikiPage = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Team handbook" });
  await workItems.updateWorkItem.handler({ userId: ownerId }, { workItemId: target.id, descriptionMarkdown: `[[Project handbook|page:${projectPage.id}]] and [[Team handbook|wiki:${wikiPage.id}]]` });
  const visibleItem = await workItems.createWorkItem.handler({ userId: ownerId }, { projectId: project.id, title: "Visible work item", descriptionMarkdown: `[[MOB-${target.sequence}|work-item:${target.id}]]` });
  const visiblePage = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, projectId: project.id, title: "Page source", contentMarkdown: `[[Project handbook|page:${projectPage.id}]]` });
  const visibleWiki = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Wiki source", contentMarkdown: `[[Team handbook|wiki:${wikiPage.id}]]` });
  const hiddenMember = await createMemberFactory(db, workspaceId, "Member");
  const hiddenCollection = await wiki.createCollection.handler({ userId: hiddenMember.id }, { workspaceId, name: "Private notes", visibility: "private" });
  const hiddenPage = await wiki.createWikiPage.handler({ userId: hiddenMember.id }, { workspaceId, collectionId: hiddenCollection.id, title: "Private backlink", contentMarkdown: `[[Release plan|work-item:${target.id}]] [[Project handbook|page:${projectPage.id}]] [[Team handbook|wiki:${wikiPage.id}]]` });
  check(Boolean(hiddenPage.id), "hidden source was seeded");

  // Page and Wiki page Links live in the Details panel's Links tab (the panel starts hidden; a drawer below 1024px).
  const openLinks = async (language: Locale) => {
    const panel = page.getByRole("complementary", { name: translate("wiki.details", language), exact: true });
    const toggle = page.getByTestId("wiki-details-toggle");
    await toggle.waitFor();
    if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
    await panel.getByRole("tab", { name: translate("outlinks.title", language), exact: true }).click();
  };
  const locale = async (value: Locale) => {
    await call("set_my_locale", { locale: value });
  };
  const destinations = [
    { name: "work-item", url: `${web}/${slug}/browse/${target.displayId}`, title: "Links" },
    { name: "page", url: `${web}/${slug}/projects/MOB/pages/${projectPage.id}`, title: "Links" },
    { name: "wiki", url: `${web}/${slug}/wiki/${wikiPage.id}`, title: "Links" },
  ] as const;
  for (const targetPage of destinations) {
    for (const language of ["en", "th"] as const) {
      await locale(language);
      for (const width of [1280, 390] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.goto(targetPage.url);
        if (targetPage.name === "work-item") await page.locator("[data-work-item-links] > summary").click();
        else await openLinks(language);
        await page.getByRole("region", { name: translate("outlinks.title", language), exact: true }).waitFor();
        await page.getByText(translate("outlinks.explanation", language)).waitFor();
        const panel = page.getByRole("region", { name: translate("outlinks.title", language), exact: true });
        check(await panel.getByText("Private backlink", { exact: false }).count() === 0, "a Backlink from a private Collection must remain hidden on every surface");
        if (targetPage.name === "work-item") {
          await panel.getByText("Visible work item", { exact: false }).waitFor();
          await panel.getByText(`${translate("outlinks.kind.work-item", language)} · Mobile`).waitFor();
        } else if (targetPage.name === "page") {
          await panel.getByText("Page source", { exact: false }).waitFor();
          await panel.getByText(translate("outlinks.emptyOut", language), { exact: true }).waitFor();
          await panel.getByText(`${translate("outlinks.kind.page", language)} · Mobile`).waitFor();
        } else {
          await panel.getByText("Wiki source", { exact: false }).waitFor();
          await panel.getByText(translate("outlinks.emptyOut", language), { exact: true }).waitFor();
          await panel.getByText(`${translate("outlinks.kind.wiki", language)} · Wiki`).waitFor();
        }
        await panel.scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        const path = `${captureDir}/06-${targetPage.name}-${width}-${language}.png`;
        await saveShot(page, { path, fullPage: true });
        console.log(path);
      }
    }
  }
  let rejectPageLinks!: () => void;
  const pageLinksRejected = new Promise<void>((resolve) => { rejectPageLinks = resolve; });
  const featureGateResponse = async (route: Route) => {
    await pageLinksRejected;
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "The Pages feature is turned off in this project." }) });
  };
  await page.route("**/actions/list_outlinks", featureGateResponse);
  await page.route("**/actions/list_backlinks", featureGateResponse);
  await page.goto(`${web}/${slug}/projects/MOB/pages/${projectPage.id}`);
  await openLinks("th");
  const gatedPanel = page.getByRole("region", { name: translate("outlinks.title", "th"), exact: true });
  await gatedPanel.waitFor();
  rejectPageLinks();
  await gatedPanel.waitFor({ state: "detached" });
  check(await page.getByText(translate("outlinks.loadFailed", "th"), { exact: true }).count() === 0, "a Pages feature-gate response must hide the panel without an error message");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  servers.forEach((server) => server.kill());
  await client.end();
}
process.exit(failed ? 1 : 0);
