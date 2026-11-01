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

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web);
  await page.getByLabel(translate("auth.name")).fill("Attach Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Evidence");
  await page.getByRole("button", { name: translate("workItems.create") }).click();
  await page.getByRole("link", { name: /Evidence/ }).click();
  const attachments = page.getByTestId("attachments");
  await attachments.waitFor();

  // Attach a non-image file: listed with download and delete, never rendered inline.
  await page.getByTestId("attach-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello evidence") });
  await attachments.getByText("notes.txt").waitFor();
  check(await attachments.locator("img").count() === 0, "non-image attachment rendered inline");
  const [download] = await Promise.all([page.waitForEvent("download"), attachments.getByRole("button", { name: translate("assets.download") }).click()]);
  check(download.suggestedFilename() === "notes.txt", "download has the wrong filename");
  check((await Bun.file((await download.path())!).text()) === "hello evidence", "downloaded bytes differ");

  // Oversize files and SVG show clear errors.
  await page.getByTestId("attach-input").setInputFiles({ name: "huge.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(6 * 1024 * 1024) });
  await attachments.getByText(translate("assets.tooLarge")).waitFor();
  const editor = '[data-testid="description-editor"] .ProseMirror';
  await pasteFile(page, editor, { name: "evil.svg", type: "image/svg+xml", base64: btoa("<svg xmlns='http://www.w3.org/2000/svg'/>") });
  await page.getByText(translate("assets.imageTypeNotAllowed")).waitFor();

  // Paste an image into the description, save, reload: it renders inline from storage.
  await pasteFile(page, editor, { name: "shot.png", type: "image/png", base64: png });
  await page.waitForFunction(() => document.querySelector('[data-testid="description-editor"] img[data-testid="inline-image"]')?.getAttribute("src"));
  await page.getByRole("button", { name: translate("workItems.save") }).click();
  await page.reload();
  await page.getByTestId("description-editor").locator("img").waitFor();
  await page.waitForFunction(() => (document.querySelector('[data-testid="description-editor"] img') as HTMLImageElement | null)?.naturalWidth);
  check(await loadedImages(page, '[data-testid="description-editor"]') === 1, "description image did not render after reload");

  // A comment image.
  await pasteFile(page, '.comment-editor:not([data-testid]) .ProseMirror', { name: "c.png", type: "image/png", base64: png });
  await page.waitForFunction(() => document.querySelector('.comment-editor:not([data-testid]) img[data-testid="inline-image"]')?.getAttribute("src"));
  await page.getByRole("button", { name: translate("comments.add"), exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('section img[data-testid="inline-image"]')].some((image) => !image.closest(".comment-editor") && (image as HTMLImageElement).naturalWidth > 0));

  // A wiki page image.
  await page.goto(`${web}/${slug}/wiki`);
  await page.getByRole("button", { name: translate("wiki.new") }).click();
  await page.locator(".ProseMirror").waitFor();
  await pasteFile(page, ".ProseMirror", { name: "w.png", type: "image/png", base64: png });
  await page.waitForFunction(() => (document.querySelector('.ProseMirror img[data-testid="inline-image"]') as HTMLImageElement | null)?.naturalWidth);
  await page.getByText(translate("wiki.saved")).waitFor({ timeout: 10_000 });
  await page.reload();
  await page.waitForFunction(() => (document.querySelector('.ProseMirror img[data-testid="inline-image"]') as HTMLImageElement | null)?.naturalWidth);

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
