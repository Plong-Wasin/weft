// Browser acceptance flow for Mermaid diagrams in a work item description.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium, type Locator } from "playwright";
import { createDatabase } from "../packages/db/src";
import { createProjectActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31238);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52238);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31239);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const live = `ws://localhost:${livePort}`;
const servers: ReturnType<typeof Bun.spawn>[] = [];
const { client, db } = createDatabase();
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const imageSource = async (image: Locator) => image.evaluate((element) => {
  const image = element as HTMLImageElement;
  return decodeURIComponent(image.src.slice(image.src.indexOf(",") + 1));
});
async function waitFor(url: string) { for (let i = 0; i < 100; i += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* server starting */ } await Bun.sleep(200); } throw new Error(`${url} did not start`); }
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  servers.push(Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }));
  servers.push(Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }));
  // The build goes to a folder of its own: apps/web/dist is shared with every flow running side by side.
  const webDist = mkdtempSync(`${tmpdir()}/weft-e2e-web-`);
  const build = Bun.spawnSync(["node", "node_modules/vite/bin/vite.js", "build", "--outDir", webDist, "--emptyOutDir"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: live }, stdout: "inherit", stderr: "inherit" });
  check(build.exitCode === 0, "web build failed");
  const serviceWorker = readFileSync(`${webDist}/sw.js`, "utf8");
  check(!/mermaid\.core-|(?:flow|sequence|class|state|er|gantt|mindmap|pie|sankey|xychart|block|architecture|journey|timeline|kanban|requirement|quadrant|radar|c4)Diagram-/i.test(serviceWorker), "service worker precaches Mermaid renderer code for pages without diagrams");
  servers.push(Bun.spawn(["node", "node_modules/vite/bin/vite.js", "preview", "--outDir", webDist, "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: Bun.env, stdout: "ignore", stderr: "inherit" }));
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const waitForDiagramImage = async (image: Locator) => {
    const handle = await image.elementHandle();
    if (!handle) throw new Error("diagram image is missing");
    await page.waitForFunction((element) => { const image = element as HTMLImageElement; return image.complete || !!document.querySelector(".mermaid-error"); }, handle, { timeout: 10000 });
    const width = await handle.evaluate((element) => (element as HTMLImageElement).naturalWidth);
    if (width === 0) throw new Error(`diagram image failed to load${await page.locator(".mermaid-error").first().textContent().catch(() => "")}`);
  };
  const outsideSnapshot = () => page.evaluate(() => {
    const bodyStyle = getComputedStyle(document.body);
    const sample = (element: Element | null, includeWidth = true) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { display: style.display, visibility: style.visibility, position: style.position, zIndex: style.zIndex, color: style.color, backgroundColor: style.backgroundColor, x: rect.x, y: rect.y, ...(includeWidth ? { width: rect.width } : {}), height: rect.height };
    };
    return { body: { display: bodyStyle.display, visibility: bodyStyle.visibility }, header: sample(document.querySelector("header")), title: sample(document.querySelector("h1"), false) };
  });
  const externalRequests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).origin !== web && new URL(request.url()).origin !== api) externalRequests.push(request.url()); });
  page.on("dialog", (dialog) => { void dialog.dismiss(); });
  const slug = `mermaid-${crypto.randomUUID().slice(0, 7)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Diagram reviewer");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword", "en")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Diagram review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded", timeout: 8000 });
  const beforeDiagramResources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((row) => row.slug === slug)!.id;
  const project = await createProjectActions(db).createProject.handler({ userId: me.user.id }, { workspaceId, name: "Diagrams", key: "DIA", visibility: "public" });
  const item = await page.request.post(`${api}/actions/create_work_item`, { data: { projectId: project.id, title: "Diagram acceptance", descriptionMarkdown: "```mermaid\nflowchart LR\n  A[Request] --> B[Review]\n```" } }).then((response) => response.json() as Promise<{ id: string }>);
  await page.goto(`${web}/${slug}/browse/DIA-1`);
  const description = page.getByTestId("description-editor").locator(".ProseMirror");
  await description.waitFor();
  const initialDiagram = description.locator(".mermaid-diagram img");
  await initialDiagram.waitFor({ state: "attached", timeout: 15000 });
  await waitForDiagramImage(initialDiagram);
  check((await imageSource(initialDiagram)).includes("Request"), "valid Mermaid diagram labels are missing");
  const initialSource = description.locator(".mermaid-source");
  await initialSource.waitFor();
  check(!(await initialSource.evaluate((element) => (element as HTMLDetailsElement).open)), "Mermaid source should be collapsed until requested");
  await initialSource.locator("summary").click();
  await initialSource.locator("pre code").waitFor();
  check((await initialSource.locator("pre code").textContent())?.includes("flowchart LR"), "raw Mermaid code is not available after opening the source disclosure");
  const stored = await page.request.post(`${api}/actions/get_work_item`, { data: { workspaceId, displayId: "DIA-1" } }).then((response) => response.json() as Promise<{ descriptionMarkdown: string }>);
  check(stored.descriptionMarkdown === "```mermaid\nflowchart LR\n  A[Request] --> B[Review]\n```", "diagram did not round-trip as an ordinary Mermaid code block");
  const afterDiagramResources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  check(!beforeDiagramResources.some((url) => url.includes("mermaid.core")), "Mermaid renderer loaded on a page without a diagram");
  check(afterDiagramResources.some((url) => url.includes("mermaid.core")), "Mermaid renderer did not load locally when a diagram appeared");
  check(item.id.length > 0, "work item was not created");

  const captureDir = `${process.cwd()}/.scratch-captures`;
  mkdirSync(captureDir, { recursive: true });
  const fixtures = [
    ["valid", "```mermaid\nflowchart LR\n  A[Request] --> B[Review]\n```"],
    ["broken", "```mermaid\nnotARealDiagram\n  A --> B\n```"],
    ["frontmatter", '```mermaid\n---\nconfig:\n  themeCSS: "body{display:none!important}"\n---\nflowchart LR\n  A[Safe] --> B[Review]\n```'],
    ["hostile", '```mermaid\n%%{init: {"theme": "base", "themeCSS": "body{display:none!important} h1{position:fixed!important;inset:0!important;z-index:2147483647!important;background:red!important}", "fontFamily": "Comic Sans MS", "themeVariables": {"fontFamily": "Comic Sans MS"}}}%%\nflowchart LR\n  A[Safe] --> B[Review]\n```'],
  ] as const;
  for (const [kind, markdown] of fixtures) {
    if (kind !== "hostile") {
      const update = await page.request.post(`${api}/actions/update_work_item`, { data: { workItemId: item.id, descriptionMarkdown: markdown } });
      check(update.ok(), `${kind} diagram fixture did not save: ${update.status()} ${await update.text()}`);
    }
    for (const locale of ["en", "th"] as const) {
      const localeResponse = await page.request.post(`${api}/actions/set_my_locale`, { data: { locale } });
      check(localeResponse.ok(), `could not set ${locale} capture locale`);
      for (const theme of ["light", "dark"] as const) {
        let expectedOutside: Awaited<ReturnType<typeof outsideSnapshot>> | undefined;
        if (kind === "hostile" || kind === "frontmatter") {
          // Keep exactly the same Mermaid source and diagram, removing only its init directive for the baseline.
          const safeBaseline = kind === "hostile" ? markdown.replace(/%%\{\s*init:[\s\S]*?\}%%\s*\n/i, "") : markdown.replace(/---\n[\s\S]*?\n---\n/, "");
          const safeUpdate = await page.request.post(`${api}/actions/update_work_item`, { data: { workItemId: item.id, descriptionMarkdown: safeBaseline } });
          check(safeUpdate.ok(), `could not prepare safe style baseline: ${safeUpdate.status()}`);
          await page.goto(`${web}/${slug}/browse/DIA-1`);
          await page.evaluate((nextTheme) => document.documentElement.setAttribute("data-theme", nextTheme), theme);
          await page.getByTestId("description-editor").locator(".mermaid-source").waitFor();
          expectedOutside = await outsideSnapshot();
          const update = await page.request.post(`${api}/actions/update_work_item`, { data: { workItemId: item.id, descriptionMarkdown: markdown } });
          check(update.ok(), `hostile diagram fixture did not save: ${update.status()} ${await update.text()}`);
        }
        await page.goto(`${web}/${slug}/browse/DIA-1`);
        await page.evaluate((nextTheme) => document.documentElement.setAttribute("data-theme", nextTheme), theme);
        const editor = page.getByTestId("description-editor").locator(".ProseMirror");
        await editor.waitFor();
        if (kind === "broken") {
          await editor.locator(".mermaid-error").waitFor({ timeout: 10000 });
          check((await editor.locator("pre code").textContent())?.includes("notARealDiagram"), "broken diagram does not keep its raw source beside the error");
        } else if (kind === "hostile" || kind === "frontmatter") {
          const diagramImage = editor.locator(".mermaid-diagram img");
          await diagramImage.waitFor({ state: "attached", timeout: 10000 });
          await waitForDiagramImage(diagramImage);
          const rawCode = await editor.locator("pre code").textContent();
          if (kind === "hostile") check(rawCode?.includes("%%{init") && rawCode.includes("themeCSS") && rawCode.includes("Comic Sans MS"), `hostile diagram does not keep its raw init directive and source unchanged: ${JSON.stringify(rawCode)}`);
          else check(rawCode?.includes("themeCSS") && rawCode.includes("---"), `Mermaid frontmatter source was changed: ${JSON.stringify(rawCode)}`);
          const safeSvg = await imageSource(diagramImage);
          check(!safeSvg.includes("body{display:none") && !safeSvg.includes("Comic Sans MS"), "Mermaid config changed rendered theme CSS or font family");
          check((await diagramImage.getAttribute("src"))?.startsWith("data:image/svg+xml"), "diagram is not isolated in an SVG image");
          const actualOutside = await outsideSnapshot();
          check(actualOutside.body?.display !== "none" && actualOutside.body?.visibility !== "hidden", "hostile Mermaid CSS hid the document body");
          check(JSON.stringify(actualOutside) === JSON.stringify(expectedOutside), `hostile Mermaid CSS changed computed style or size outside the diagram box: expected ${JSON.stringify(expectedOutside)}, got ${JSON.stringify(actualOutside)}`);
        } else await editor.locator(".mermaid-diagram img").waitFor();
        if (kind !== "broken") await waitForDiagramImage(editor.locator(".mermaid-diagram img"));
        if (kind === "hostile") {
          const rendered = editor.locator(".mermaid-code-block");
          const activeNodes = await rendered.evaluate((root) => [...root.querySelectorAll("script, a, iframe, object, embed, [onclick], [onerror]")].map((node) => node.outerHTML.slice(0, 240)));
          check(activeNodes.length === 0, `hostile Mermaid source created an active DOM element: ${activeNodes.join(" | ")}`);
          check(await rendered.evaluate((root) => [...root.querySelectorAll("img:not(.ProseMirror-separator)")].filter((image) => !image.closest(".mermaid-diagram")).length) === 0, "hostile Mermaid created a remote image outside its isolated output");
          check(externalRequests.length === 0, `diagram flow made an external request: ${externalRequests.join(", ")}`);
          check(await page.evaluate(() => (window as unknown as { __diagramExecuted?: number }).__diagramExecuted) === undefined, "hostile Mermaid script or click handler executed");
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.screenshot({ path: `${captureDir}/08-${kind}-1280-${locale}-${theme}.png`, fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${kind} diagram caused horizontal page scrolling at phone width`);
        const diagramBounds = await page.evaluate(() => {
          const box = document.querySelector<HTMLElement>('[data-testid="description-editor"] .mermaid-diagram');
          const image = box?.querySelector("img");
          const editor = document.querySelector<HTMLElement>('[data-testid="description-editor"] .ProseMirror');
          const rect = (element?: Element | null) => { const value = element?.getBoundingClientRect(); return value ? { left: value.left, right: value.right, width: value.width } : null; };
          const ancestors = [] as Array<Record<string, unknown>>;
          for (let element: HTMLElement | null = editor; element && ancestors.length < 8; element = element.parentElement) {
            const style = getComputedStyle(element);
            ancestors.push({ tag: element.tagName, className: element.className, display: style.display, minWidth: style.minWidth, width: style.width, maxWidth: style.maxWidth, overflow: style.overflow, rect: rect(element) });
          }
          return { viewport: window.innerWidth, box: rect(box), image: rect(image), editor: rect(editor), pageWidth: document.documentElement.scrollWidth, ancestors };
        });
        check(!diagramBounds.box || (diagramBounds.box.right <= diagramBounds.viewport + 1 && (!diagramBounds.image || diagramBounds.image.right <= diagramBounds.box.right + 1)), `${kind} diagram image is clipped at phone width: ${JSON.stringify(diagramBounds)}`);
        check(await page.evaluate(() => { const toolbar = document.querySelector('[data-testid="description-toolbar"]'); return !toolbar || [...toolbar.children].every((button) => button.getBoundingClientRect().right <= toolbar.getBoundingClientRect().right + 1); }), `${kind} diagram toolbar is clipped at phone width`);
        await page.screenshot({ path: `${captureDir}/08-${kind}-390-${locale}-${theme}.png`, fullPage: true });
      }
    }
  }
  const activeHostile = '```mermaid\nflowchart LR\n  A[Safe] --> B["<script>alert(1)</script><img src=\'https://example.invalid/diagram.png\' onerror=\'window.__diagramExecuted=2\'>"]\n  click A "javascript:window.__diagramExecuted=3"\n```';
  const hostileUpdate = await page.request.post(`${api}/actions/update_work_item`, { data: { workItemId: item.id, descriptionMarkdown: activeHostile } });
  check(hostileUpdate.ok(), `hostile script/image fixture did not save: ${await hostileUpdate.text()}`);
  await page.goto(`${web}/${slug}/browse/DIA-1`);
  const hostileEditor = page.getByTestId("description-editor").locator(".ProseMirror");
  const hostileImage = hostileEditor.locator(".mermaid-diagram img");
  await hostileImage.waitFor({ state: "attached" });
  await waitForDiagramImage(hostileImage);
  const hostileSource = await hostileEditor.locator("pre code").textContent();
  check(hostileSource?.includes("javascript:") && hostileSource.includes("<script>") && hostileSource.includes("https://example.invalid"), "hostile raw source is missing from the code block");
  const hostileSvg = await imageSource(hostileImage);
  const unsafeSvgParts = await page.evaluate((source) => {
    const root = new DOMParser().parseFromString(source, "image/svg+xml");
    const activeTags = [...root.querySelectorAll("script, a, image, foreignObject")].map((element) => element.localName);
    const activeAttributes = [...root.querySelectorAll("*")].flatMap((element) => [...element.attributes].filter((attribute) => attribute.name !== "xmlns" && (/^on/i.test(attribute.name) || /^(?:href|src|xlink:href)$/i.test(attribute.name) || /(?:javascript:|https?:|url\s*\(\s*(?!#))/i.test(attribute.value))).map((attribute) => `${element.localName}.${attribute.name}=${attribute.value}`));
    return { activeTags, activeAttributes };
  }, hostileSvg);
  check(unsafeSvgParts.activeTags.length === 0 && unsafeSvgParts.activeAttributes.length === 0, `isolated hostile SVG retained active content: ${JSON.stringify(unsafeSvgParts)}`);
  check(externalRequests.length === 0, `hostile SVG made an external request: ${externalRequests.join(", ")}`);
  check(await page.evaluate(() => (window as unknown as { __diagramExecuted?: number }).__diagramExecuted) === undefined, "hostile SVG executed script or click content");
  const validDiagram = "```mermaid\nflowchart LR\n  A[Request] --> B[Review]\n```";
  const resetLocale = await page.request.post(`${api}/actions/set_my_locale`, { data: { locale: "en" } });
  check(resetLocale.ok(), "could not reset locale for shared-surface checks");
  const commentResponse = await page.request.post(`${api}/actions/create_comment`, { data: { workItemId: item.id, bodyMarkdown: validDiagram } });
  check(commentResponse.ok(), `could not create Mermaid comment: ${await commentResponse.text()}`);
  await page.goto(`${web}/${slug}/browse/DIA-1`);
  const comment = page.locator(".comment-body .ProseMirror").last();
  const commentDiagram = comment.locator(".mermaid-diagram img");
  await commentDiagram.waitFor();
  await waitForDiagramImage(commentDiagram);
  check((await imageSource(commentDiagram)).includes("Request"), "Mermaid diagram did not render in Comments");
  for (const locale of ["en", "th"] as const) {
    const response = await page.request.post(`${api}/actions/set_my_locale`, { data: { locale } });
    check(response.ok(), `could not set ${locale} for comment capture`);
    await page.goto(`${web}/${slug}/browse/DIA-1`);
    const visibleCommentDiagram = page.locator(".comment-body .ProseMirror .mermaid-diagram img").last();
    await visibleCommentDiagram.waitFor();
    await waitForDiagramImage(visibleCommentDiagram);
    for (const width of [1280, 390] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (width === 390) check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "comment diagram caused horizontal page scrolling at phone width");
      await page.screenshot({ path: `${captureDir}/08-comment-valid-${width}-${locale}.png`, fullPage: true });
    }
  }
  const pageResponse = await page.request.post(`${api}/actions/create_wiki_page`, { data: { workspaceId, projectId: project.id, title: "Page diagram", contentMarkdown: validDiagram } });
  check(pageResponse.ok(), `could not create Page diagram: ${await pageResponse.text()}`);
  const pageRecord = await pageResponse.json() as { id: string };
  const wikiResponse = await page.request.post(`${api}/actions/create_wiki_page`, { data: { workspaceId, title: "Wiki diagram", contentMarkdown: validDiagram } });
  check(wikiResponse.ok(), `could not create Wiki diagram: ${await wikiResponse.text()}`);
  const wikiRecord = await wikiResponse.json() as { id: string };
  for (const [kind, route, screen] of [["page", `/projects/DIA/pages/${pageRecord.id}`, "Page"], ["wiki", `/wiki/${wikiRecord.id}`, "Wiki page"]] as const) {
    for (const locale of ["en", "th"] as const) {
      const response = await page.request.post(`${api}/actions/set_my_locale`, { data: { locale } });
      check(response.ok(), `could not set ${locale} for ${screen} capture`);
      await page.goto(`${web}/${slug}${route}`);
      const editor = page.locator(".wiki-editor .ProseMirror");
      const diagram = editor.locator(".mermaid-diagram img");
      await diagram.waitFor();
      await waitForDiagramImage(diagram);
      check((await imageSource(diagram)).includes("Request"), `Mermaid diagram did not render in ${screen}`);
      for (const width of [1280, 390] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        if (width === 390) check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${screen} diagram caused horizontal page scrolling at phone width`);
        await page.screenshot({ path: `${captureDir}/08-${kind}-valid-${width}-${locale}.png`, fullPage: true });
      }
    }
  }
  console.log("mermaid diagrams: valid diagram renders in a description");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  servers.forEach((server) => server.kill());
  await client.end();
}
