import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createDatabase } from "../packages/db/src";
import { createProjectActions, createWikiActions, createWorkItemActions } from "../packages/actions/src";
import { translate, type Locale } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31279);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52279);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31280);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const captures = `${process.cwd()}/.scratch-captures`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, CHOKIDAR_USEPOLLING: "true", VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];
const { client, db } = createDatabase();
let failed = false;

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}

try {
  mkdirSync(captures, { recursive: true });
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US", acceptDownloads: true });
  const slug = `markdown-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name} failed (${response.status()}): ${await response.text()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Markdown reviewer");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword", "en")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Markdown review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const userId = me.user.id;
  const projects = createProjectActions(db);
  const project = await projects.createProject.handler({ userId }, { workspaceId, name: "Documents", key: "DOC", visibility: "public" });
  const target = await createWorkItemActions(db).createWorkItem.handler({ userId }, { projectId: project.id, title: "Release plan" });
  const wiki = createWikiActions(db);
  const targetPage = await wiki.createWikiPage.handler({ userId }, { workspaceId, title: "Team handbook" });
  const source = await wiki.createWikiPage.handler({ userId }, { workspaceId, title: "Export source", contentMarkdown: `[[Release plan (DOC-${target.sequence})|work-item:${target.id}]]\n\n[[Team handbook|wiki:${targetPage.id}]]\n\n@{Markdown reviewer|${userId}}\n\n> [!note]\n> Source note.` });
  const sourceUrl = `${web}/${slug}/wiki/${source.id}`;
  const warningMarkdown = "<custom-widget>kept tag</custom-widget>\n\n[javascript label](javascript:alert(1))\n\n[[Missing page]]\n\n![remote image](https://example.test/image.png)\n\n| A | B |\n| --- | --- |\n| value |\n\n####### Deep heading";

  for (const language of ["en", "th"] as const satisfies readonly Locale[]) {
    await call("set_my_locale", { locale: language });
    for (const width of [1280, 390] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(sourceUrl);
      const exportsButton = page.getByRole("button", { name: translate("wiki.exports", language) });
      await exportsButton.click();
      await page.getByText("Source note.", { exact: true }).waitFor();
      await page.getByRole("menuitem", { name: translate("wiki.exportMarkdown", language), exact: true }).waitFor();
      await page.getByRole("menuitem", { name: translate("wiki.importMarkdown", language), exact: true }).waitFor();
      await page.screenshot({ path: `${captures}/09-export-import-${width}-${language}-controls.png`, fullPage: true });
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("menuitem", { name: translate("wiki.exportMarkdown", language), exact: true }).click(),
      ]);
      check(download.suggestedFilename() === "Export source.md", "export must use the page title as the Markdown filename");
      await download.saveAs(`/tmp/rtm09-${language}-${width}.md`);
      const exported = await Bun.file(`/tmp/rtm09-${language}-${width}.md`).text();
      const stableReferences = [...source.contentMarkdown.matchAll(/\|((?:work-item|wiki):[0-9a-f-]{36})\]\]/g)].map((match) => match[1]!);
      check(stableReferences.length === 2 && stableReferences.every((reference) => exported.includes(reference)), "export must include readable labels and the same stable target ids as the Page");
      check(exported.includes("Release plan (DOC-") && exported.includes("@{Markdown reviewer|"), "export must name people, work items, and pages readably");

      await page.getByRole("button", { name: translate("wiki.exports", language) }).click();
      await page.locator("#wiki-markdown-import").setInputFiles({ name: "Imported review.md", mimeType: "text/markdown", buffer: Buffer.from(warningMarkdown) });
      await page.waitForURL(/\/wiki\/[0-9a-f-]+$/);
      const result = page.getByRole("alert", { name: translate("wiki.importResult", language) });
      await result.waitFor();
      await page.getByText("kept tag", { exact: false }).waitFor();
      await result.getByText(translate("wiki.importSuccess", language), { exact: true }).waitFor();
      await result.getByText(translate("wiki.importFileUnchanged", language), { exact: true }).waitFor();
      await result.getByText(translate("wiki.importWarningsTitle", language), { exact: true }).waitFor();
      for (const key of ["html", "link", "reference", "image", "table", "heading"] as const) {
        const explanation = translate(`wiki.importWarning.${key}` as const, language).replace("{text}", "").replace(/^[\s—]+/, "");
        await result.getByText(explanation, { exact: false }).first().waitFor();
      }
      await page.screenshot({ path: `${captures}/09-export-import-${width}-${language}-result-warnings.png`, fullPage: true });
      console.log(`${captures}/09-export-import-${width}-${language}-controls.png`);
      console.log(`${captures}/09-export-import-${width}-${language}-result-warnings.png`);
    }
  }
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  servers.forEach((server) => server.kill());
  await client.end();
}
process.exit(failed ? 1 : 0);
