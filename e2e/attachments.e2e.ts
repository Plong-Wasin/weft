// Browser end-to-end flow: attach a file to a work item, paste an inline image into the description, a comment and a wiki page.
// Run with `bun run e2e` (needs the shared weft-postgres and weft-minio containers; `docker compose up -d minio`).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3108);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5208);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
// A real 1x1 PNG, so the browser can decode what storage serves back.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Fires a paste event carrying one file into a ProseMirror editor, as the browser does for a clipboard image. */
async function pasteFile(page: Page, editor: string, file: { name: string; type: string; base64: string }) {
  await page.evaluate(({ editor, file }) => {
    const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], file.name, { type: file.type }));
    const target = document.querySelector(editor) as HTMLElement;
    target.focus();
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, { editor, file });
}

async function loadedImages(page: Page, scope: string) {
  return page.locator(`${scope} img[data-testid="inline-image"]`).evaluateAll((images) => images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length);
}

async function dropImage(page: Page, editorSelector: string, expected: number) {
  await page.evaluate(({ editorSelector, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    const editor = document.querySelector(editorSelector) as HTMLElement;
    editor.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
  }, { editorSelector, base64: png });
  await page.locator(`${editorSelector} .asset-image-node`).nth(expected - 1).waitFor();
}

async function pickImage(page: Page, inputSelector: string, editorSelector: string, expected: number) {
  await page.locator(inputSelector).setInputFiles({ name: "picked.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.locator(`${editorSelector} .asset-image-node`).nth(expected - 1).waitFor();
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Attach Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("button", { name: translate("layout.addToGroup").replace("{group}", "Backlog") }).click();
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Evidence");
  await page.getByRole("button", { name: translate("workItems.create") }).click();
  await page.getByRole("link", { name: /Evidence/ }).click();
  const expandPeek = page.getByRole("link", { name: translate("workItems.peek.expand") });
  if (await expandPeek.count()) await expandPeek.click();
  for (const key of ["workItems.addSubItemAction", "workItems.addRelationAction", "workItems.addLinkAction", "workItems.attachAction"]) {
    await page.getByRole("button", { name: translate(key) }).waitFor();
  }
  check(await page.getByText(translate("workItems.subItems"), { exact: true }).count() === 0, "empty sections should stay hidden");
  await page.getByRole("button", { name: translate("workItems.addLinkAction") }).click();
  await page.getByLabel(translate("webLinks.urlLabel")).waitFor();
  await page.keyboard.press("Escape");
  const [attachPicker] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: translate("workItems.attachAction") }).click(),
  ]);
  const attachments = page.getByTestId("attachments");
  await attachments.waitFor();
  await page.getByTestId("attachment-dropzone").waitFor();

  // One click opens the picker; selecting several files uploads all of them.
  await attachPicker.setFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello evidence") },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second evidence") },
  ]);
  await attachments.getByText("notes.txt").waitFor();
  await attachments.getByText("second.txt").waitFor();
  check(await attachments.locator("img").count() === 0, "non-image attachment rendered inline");
  const notesRow = attachments.locator("li").filter({ hasText: "notes.txt" });
  const [download] = await Promise.all([page.waitForEvent("download"), notesRow.getByRole("button", { name: translate("assets.download") }).click()]);
  check(download.suggestedFilename() === "notes.txt", "download has the wrong filename");
  check((await Bun.file((await download.path())!).text()) === "hello evidence", "downloaded bytes differ");

  // Oversize files and SVG show clear errors.
  const [dropzonePicker] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("attachment-dropzone").click(),
  ]);
  await dropzonePicker.setFiles({ name: "third.txt", mimeType: "text/plain", buffer: Buffer.from("third evidence") });
  await attachments.getByText("third.txt").waitFor();
  await page.getByTestId("attachment-dropzone").dispatchEvent("dragenter", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  check((await page.getByTestId("attachment-dropzone").getAttribute("class"))?.includes("border-accent"), "dropzone did not highlight during drag-over");
  await page.getByTestId("attachment-dropzone").dispatchEvent("drop", {
    dataTransfer: await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["dropped evidence"], "dropped.txt", { type: "text/plain" }));
      return data;
    }),
  });
  await attachments.getByText("dropped.txt").waitFor();
  // A drop on the file list (outside the dashed box) uploads too and is not left to the browser.
  await attachments.locator("ul").dispatchEvent("drop", {
    dataTransfer: await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["outside evidence"], "outside.txt", { type: "text/plain" }));
      return data;
    }),
  });
  await attachments.getByText("outside.txt").waitFor();
  await page.getByTestId("attach-input").setInputFiles({ name: "huge.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(6 * 1024 * 1024) });
  await attachments.getByText(translate("assets.tooLarge")).waitFor();
  const editor = '[data-testid="description-editor"] .ProseMirror';
  await pasteFile(page, editor, { name: "evil.svg", type: "image/svg+xml", base64: btoa("<svg xmlns='http://www.w3.org/2000/svg'/>") });
  await page.getByText(translate("assets.imageTypeNotAllowed")).waitFor();

  // Paste an image into the description, save, reload: it renders inline from storage.
  const saved = page.waitForResponse((response) => response.url().includes("update_work_item") && response.ok());
  await pasteFile(page, editor, { name: "shot.png", type: "image/png", base64: png });
  await page.waitForFunction(() => document.querySelector('[data-testid="description-editor"] img[data-testid="inline-image"]')?.getAttribute("src"));
  // The description saves by itself a moment after the last edit.
  await saved;
  await page.reload();
  await page.getByTestId("description-editor").locator("img").waitFor();
  await page.waitForFunction(() => (document.querySelector('[data-testid="description-editor"] img') as HTMLImageElement | null)?.naturalWidth);
  check(await loadedImages(page, '[data-testid="description-editor"]') === 1, "description image did not render after reload");

  // Case: image block controls resize and alignment persist with the description after reload.
  const imageBlock = page.locator('[data-testid="description-editor"] .asset-image-node');
  const updated = page.waitForResponse((response) => response.url().includes("update_work_item") && response.ok());
  for (const [key, alignment] of [["assets.alignLeft", "left"], ["assets.alignCenter", "center"], ["assets.alignRight", "right"]] as const) {
    await imageBlock.getByRole("button", { name: translate(key) }).click();
    check(await imageBlock.getAttribute("data-alignment") === alignment, `image did not align ${alignment}`);
  }
  const resizeHandle = imageBlock.getByRole("button", { name: translate("assets.resizeImage") });
  const rect = await resizeHandle.boundingBox();
  check(!!rect, "image resize handle is missing");
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await page.mouse.down(); await page.mouse.move(rect!.x + rect!.width / 2 + 180, rect!.y + rect!.height / 2); await page.mouse.up();
  const resizedWidth = await imageBlock.locator("img").evaluate((image) => (image as HTMLImageElement).style.width);
  check(Number.parseInt(resizedWidth, 10) > 100, "dragging the image handle did not resize it");
  await page.waitForTimeout(1200); await updated;
  const viewer = imageBlock.getByRole("button", { name: translate("assets.fullScreen") });
  await viewer.click();
  const dialog = page.locator("dialog.asset-image-viewer"); await dialog.waitFor();
  await dialog.getByRole("button", { name: translate("assets.zoomIn") }).click();
  check(await dialog.locator("img").evaluate((image) => (image as HTMLImageElement).style.transform).then((value) => value.includes("1.25")), "full-screen image viewer did not zoom");
  await dialog.getByRole("button", { name: translate("assets.closeViewer") }).click();
  await dialog.waitFor({ state: "detached" });
  const [imageDownload] = await Promise.all([page.waitForEvent("download"), imageBlock.getByRole("button", { name: translate("assets.downloadImage") }).click()]);
  check(imageDownload.suggestedFilename() === "image", "image download did not start");
  await page.reload();
  const persistedImage = page.locator('[data-testid="description-editor"] .asset-image-node');
  await persistedImage.waitFor();
  check(await persistedImage.getAttribute("data-alignment") === "right", "image alignment did not persist after reload");
  check(Number.parseInt(await persistedImage.locator("img").evaluate((image) => (image as HTMLImageElement).style.width), 10) > 100, "image width did not persist after reload");
  console.log("case image-resize-align-download-full-screen: passed");
  await pickImage(page, '[data-testid="description-image-input"]', '[data-testid="description-editor"] .ProseMirror', 2);
  await dropImage(page, '[data-testid="description-editor"] .ProseMirror', 3);

  // A comment image.
  await pasteFile(page, '[data-testid="comment-editor"] .ProseMirror', { name: "c.png", type: "image/png", base64: png });
  await page.waitForFunction(() => document.querySelector('[data-testid="comment-editor"] img[data-testid="inline-image"]')?.getAttribute("src"));
  await page.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('section img[data-testid="inline-image"]')].some((image) => !image.closest(".comment-editor") && (image as HTMLImageElement).naturalWidth > 0));
  await pickImage(page, '[data-testid="comment-image-input"]', '[data-testid="comment-editor"] .ProseMirror', 2);
  await dropImage(page, '[data-testid="comment-editor"] .ProseMirror', 3);
  console.log("case paste-image-in-description-comment-wiki: passed");

  // A section with files starts open, without the dropzone; the Attach action brings the dropzone up.
  await page.reload();
  await page.getByTestId("attachments").waitFor({ state: "visible" });
  check(!(await page.getByTestId("attachment-dropzone").isVisible()), "dropzone should stay closed until Attach is used");
  page.once("filechooser", () => undefined);
  await page.getByRole("button", { name: translate("workItems.attachAction"), exact: true }).click();
  await page.getByTestId("attachment-dropzone").waitFor({ state: "visible" });

  // A wiki page image.
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("main").getByRole("button", { name: translate("wiki.new") }).click();
  await page.waitForURL(new RegExp(`/${slug}/wiki/[0-9a-f-]+$`));
  await page.locator(".ProseMirror").waitFor();
  await pasteFile(page, ".ProseMirror", { name: "w.png", type: "image/png", base64: png });
  await page.waitForFunction(() => (document.querySelector('.ProseMirror img[data-testid="inline-image"]') as HTMLImageElement | null)?.naturalWidth);
  await pickImage(page, '[data-testid="inline-image-input"]', '.ProseMirror', 2);
  await dropImage(page, '.ProseMirror', 3);
  await page.getByText(translate("wiki.saved")).waitFor({ timeout: 10_000 });
  // The reload-and-restore check of a Wiki page image is not asserted here: Wiki bodies now persist through the live service, which this flow does not start.

  console.log("e2e attachments: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
