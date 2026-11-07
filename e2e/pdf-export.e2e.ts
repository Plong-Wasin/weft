// Browser acceptance cases: PDF dialog choices, image switch, downloadable PDF page size, rich blocks, and Markdown compatibility.
import { chromium } from "playwright";
import { eq } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31181);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52181);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31182);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];
const { client, db } = createDatabase();
let slug = "";
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(`http://localhost:${livePort}`)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") console.error(`browser console: ${message.text()}`); });
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()} ${await response.text()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  slug = `pdf-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel(translate("auth.name")).fill("PDF Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("PDF team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const content = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "PDF heading" }] },
    { type: "paragraph", content: [{ type: "text", text: "PDF paragraph and " }, { type: "mention", attrs: { id: "member", label: "PDF Tester" } }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "PDF list item" }] }] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Column" }] }] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }] }] }] },
    { type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "PDF callout" }] }] },
    { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const pdf = true;" }] },
  ] };
  const wiki = await call<{ id: string }>("create_wiki_page", { workspaceId, title: "PDF Acceptance", content });
  await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("PDF heading").waitFor();
  const exportMenu = page.getByRole("button", { name: translate("wiki.exports") });
  await exportMenu.click();
  await page.getByRole("menuitem", { name: translate("wiki.exportPdf"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: translate("wiki.pdfTitle") });
  const paper = dialog.getByRole("combobox", { name: translate("wiki.pdfPaperSize") });
  for (const [value, label] of [["a4", "a4"], ["a3", "a3"], ["a2", "a2"], ["letter", "letter"], ["legal", "legal"], ["tabloid", "tabloid"]]) {
    check(await paper.locator(`option[value="${value}"]`).count() === 1, `paper choice ${label} is missing`);
  }
  const images = dialog.getByRole("checkbox", { name: translate("wiki.pdfIncludeImages") });
  check(await images.isChecked(), "include images should be on by default");
  const imageLoaded = await page.getByTestId("wiki-editor").locator(".ProseMirror").evaluate((editor) => {
    const image = document.createElement("img");
    image.alt = "PDF image fixture"; image.width = 120; image.height = 80;
    const canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 80;
    const context = canvas.getContext("2d")!; context.fillStyle = "#dc2626"; context.fillRect(0, 0, canvas.width, canvas.height);
    image.src = canvas.toDataURL("image/png");
    editor.append(image);
    return new Promise<boolean>((resolve) => { image.onload = () => resolve(true); image.onerror = () => resolve(false); });
  });
  check(imageLoaded, "image fixture must load before PDF export");
  await paper.selectOption("legal");
  const downloadResult = page.waitForEvent("download");
  await dialog.getByRole("button", { name: translate("wiki.exportPdf"), exact: true }).click();
  const [download] = await Promise.race([
    downloadResult.then((download) => [download] as const),
    dialog.getByRole("alert").waitFor().then(async () => { throw new Error(`PDF export error: ${await dialog.getByRole("alert").innerText()}`); }),
  ]);
  const path = `/tmp/${slug}.pdf`;
  await download.saveAs(path);
  const pdf = new TextDecoder("latin1").decode(await Bun.file(path).arrayBuffer());
  check(pdf.startsWith("%PDF-"), "download must be a real PDF file");
  check(/\/MediaBox\s*\[\s*0\s+0\s+612(?:\.\d*)?\s+1008(?:\.\d*)?\s*\]/.test(pdf), "downloaded PDF must use the selected Legal page size");
  check(pdf.includes("/Subtype /Image"), "rendered PDF must contain a page image with the visible rich-text blocks");
  const withImageSize = (await Bun.file(path).arrayBuffer()).byteLength;

  await exportMenu.click();
  await page.getByRole("menuitem", { name: translate("wiki.exportPdf"), exact: true }).click();
  const omitDialog = page.getByRole("dialog", { name: translate("wiki.pdfTitle") });
  const omitImages = omitDialog.getByRole("checkbox", { name: translate("wiki.pdfIncludeImages") });
  await omitImages.uncheck();
  check(!(await omitImages.isChecked()), "include-images switch must turn images off");
  const [withoutImage] = await Promise.all([
    page.waitForEvent("download"),
    omitDialog.getByRole("button", { name: translate("wiki.exportPdf"), exact: true }).click(),
  ]);
  const omittedPath = `/tmp/${slug}-no-images.pdf`;
  await withoutImage.saveAs(omittedPath);
  check((await Bun.file(omittedPath).arrayBuffer()).byteLength < withImageSize, "PDF with images omitted must render a smaller page image");

  await exportMenu.click();
  const [markdown] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: translate("wiki.exportMarkdown"), exact: true }).click(),
  ]);
  const markdownPath = `/tmp/${slug}.md`;
  await markdown.saveAs(markdownPath);
  const markdownText = await Bun.file(markdownPath).text();
  check(markdownText.includes("# PDF Acceptance") && markdownText.includes("PDF list item") && markdownText.includes("const pdf = true;"), "Markdown export must remain available and preserve existing content");
  console.log("pdf-export acceptance cases passed: six paper options, include-images switch, real Legal PDF with rendered Wiki blocks, and Markdown compatibility");
} finally {
  await browser?.close();
  if (slug) {
    await db.delete(workspaces).where(eq(workspaces.slug, slug));
    await db.delete(users).where(eq(users.email, `${slug}@example.test`));
  }
  await client.end();
  for (const server of servers) server.kill();
}
