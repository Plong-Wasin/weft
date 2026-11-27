// Browser cases for the table grips: dragging a row and a column by their grip reorders the document, a plain click still opens the
// menu, the Move row and Move column menu items reorder from the keyboard, and a drop that would split a merged cell is refused.
import { check, createSignedInContext, launchBrowser, startApi, startLive, startWeb, waitFor } from "./harness";
import { type Browser, type Locator } from "playwright";
import { eq } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
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
let slug = "";
let browser: Browser | null = null;

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const cell = (type: "tableCell" | "tableHeader", text: string, attrs?: Record<string, number>) => ({ type, ...(attrs ? { attrs } : {}), content: [paragraph(text)] });
/** A 3 x 3 table whose cells read R<row>C<column>; row 0 is the header row. */
const grid = () => ({ type: "table", content: [0, 1, 2].map((row) => ({ type: "tableRow", content: [0, 1, 2].map((column) => cell(row === 0 ? "tableHeader" : "tableCell", `R${row}C${column}`)) })) });

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web), waitFor(liveHttp)]);
  browser = await launchBrowser();
  slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US" }, api, web, {
    account: { name: "Table Drag Tester", email: `${slug}@example.test` },
    workspace: { name: "Table drag team", slug },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(15_000);
  const browserErrors = new Set<string>();
  page.on("pageerror", (error) => { if (!browserErrors.has(error.message)) { browserErrors.add(error.message); console.log(`[browser pageerror] ${error.stack ?? error.message}`); } });
  const call = async <T>(name: string, body: unknown) => {
    const response = await context.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };

  await page.goto(`${web}/${slug}`);
  await page.waitForURL(new RegExp(`/${slug}(/|$)`));
  const me = await (await context.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;

  // Each case gets its own page, so one case's moves never shift another's positions.
  let caseCount = 0;
  const openPage = async (title: string, content: unknown) => {
    caseCount += 1;
    const name = `${title} ${caseCount}`;
    await call("create_wiki_page", { workspaceId, title: name, content: { type: "doc", content: [content] } });
    const pages = await call<Array<{ id: string; title: string }>>("list_wiki_pages", { workspaceId });
    const wiki = pages.find((item) => item.title === name)!;
    await page.goto(`${web}/${slug}/wiki/${wiki.id}`);
    const editor = page.getByTestId("wiki-editor").locator(".ProseMirror");
    await editor.locator(":scope > *").first().waitFor();
    return editor;
  };
  /** The text of every cell, row by row, as the editor shows the table now. */
  const rowTexts = (editor: Locator) => editor.locator("table").first().evaluate((table: HTMLTableElement) =>
    Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => (cell.textContent ?? "").trim())));
  const waitForRows = async (editor: Locator, expected: string[][]) => {
    await page.waitForFunction(
      (wanted) => {
        const table = document.querySelector<HTMLTableElement>('[data-testid="wiki-editor"] .ProseMirror table');
        return !!table && JSON.stringify(Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => (cell.textContent ?? "").trim()))) === JSON.stringify(wanted);
      },
      expected,
      { timeout: 5_000 },
    ).catch(async () => {
      throw new Error(`table is ${JSON.stringify(await rowTexts(editor))}, expected ${JSON.stringify(expected)}`);
    });
  };
  const cellAt = (editor: Locator, row: number, column: number) => editor.locator("table").first().locator("tr").nth(row).locator("td, th").nth(column);
  const grip = (id: string) => page.locator(`[data-table-grip="${id}"]`);
  /** Holds a grip's button down, moves the pointer to `point`, and reports whether a drop line is drawn at that point. */
  const dragGrip = async (id: string, point: (box: { x: number; y: number; width: number; height: number }) => { x: number; y: number }) => {
    const gripBox = await grip(id).boundingBox();
    if (!gripBox) throw new Error(`no grip ${id}`);
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    const target = point(gripBox);
    await page.mouse.move(target.x, target.y, { steps: 12 });
    const line = page.getByTestId("table-drop-line");
    const shown = await line.waitFor({ timeout: 1_000 }).then(() => true, () => false);
    return { shown, release: () => page.mouse.up() };
  };
  const bodyBox = async (editor: Locator, row: number, column: number) => {
    const box = await cellAt(editor, row, column).boundingBox();
    if (!box) throw new Error(`cell ${row},${column} is not visible`);
    return box;
  };

  // 1. Drag a row, then a column, by their grips. The document reads back in the new order, and the order persists after a reload.
  let editor = await openPage("Table drag", grid());
  await cellAt(editor, 0, 0).click();
  const rowTarget = await bodyBox(editor, 2, 1);
  const rowDrag = await dragGrip("row-0", () => ({ x: rowTarget.x + rowTarget.width / 2, y: rowTarget.y + rowTarget.height * 0.8 }));
  check(rowDrag.shown, "no drop line was drawn while the row grip was held over the lower part of the last row");
  await rowDrag.release();
  await waitForRows(editor, [["R1C0", "R1C1", "R1C2"], ["R2C0", "R2C1", "R2C2"], ["R0C0", "R0C1", "R0C2"]]);
  console.log("PASS dragging a row grip below the last row moves the row to the end");

  await cellAt(editor, 0, 0).click();
  const columnTarget = await bodyBox(editor, 0, 2);
  const columnDrag = await dragGrip("column-0", () => ({ x: columnTarget.x + columnTarget.width * 0.8, y: columnTarget.y + columnTarget.height / 2 }));
  check(columnDrag.shown, "no drop line was drawn while the column grip was held over the right part of the last column");
  await columnDrag.release();
  await waitForRows(editor, [["R1C1", "R1C2", "R1C0"], ["R2C1", "R2C2", "R2C0"], ["R0C1", "R0C2", "R0C0"]]);
  console.log("PASS dragging a column grip past the last column moves the column to the end");

  await page.getByText(translate("wiki.saved")).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(2_000); // the body reaches the server over the live socket (Y.js, debounced); no response to wait on
  await page.reload();
  editor = page.getByTestId("wiki-editor").locator(".ProseMirror");
  await editor.locator("table").first().waitFor();
  await waitForRows(editor, [["R1C1", "R1C2", "R1C0"], ["R2C1", "R2C2", "R2C0"], ["R0C1", "R0C2", "R0C0"]]);
  console.log("PASS the reordered rows and columns persist after a reload");

  // 2. A plain click on a grip still opens its menu; the keyboard Move items reorder the row and the column.
  await cellAt(editor, 1, 0).click();
  await grip("row-1").click();
  const rowMenu = page.getByRole("menu", { name: translate("table.rowMenu") });
  await rowMenu.waitFor();
  check(await rowMenu.isVisible(), "a plain click on the row grip did not open the row menu");
  await page.keyboard.press("Escape");
  await rowMenu.waitFor({ state: "detached", timeout: 3_000 });
  console.log("PASS a plain click on a row grip opens the row menu, and Escape closes it");

  await cellAt(editor, 1, 0).click();
  await grip("row-1").click();
  await page.getByRole("menuitem", { name: translate("table.moveRowDown"), exact: true }).focus();
  await page.keyboard.press("Enter");
  await waitForRows(editor, [["R1C1", "R1C2", "R1C0"], ["R0C1", "R0C2", "R0C0"], ["R2C1", "R2C2", "R2C0"]]);
  console.log("PASS the Move row down menu item moves the row from the keyboard");

  await cellAt(editor, 0, 1).click();
  await grip("column-1").click();
  await page.getByRole("menuitem", { name: translate("table.moveColumnLeft"), exact: true }).focus();
  await page.keyboard.press("Enter");
  await waitForRows(editor, [["R1C2", "R1C1", "R1C0"], ["R0C2", "R0C1", "R0C0"], ["R2C2", "R2C1", "R2C0"]]);
  console.log("PASS the Move column left menu item moves the column from the keyboard");

  // 3. A column that is part of a merged cell cannot be dragged out of it: no drop line, and the table stays as it was.
  // The editor has no merge command; a merged cell comes in with pasted HTML, as it does from another application.
  editor = await openPage("Table merged", paragraph("Merge host"));
  await editor.getByText("Merge host", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const mergedHtml = "<table><tr><th>A0</th><th>A1</th><th>A2</th></tr><tr><td>B0</td><td>B1</td><td>B2</td></tr><tr><td colspan=\"2\">MERGED</td><td>N</td></tr></table>";
  await page.evaluate((html) => {
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", "A0 A1 A2");
    document.querySelector<HTMLElement>('[data-testid="wiki-editor"] .ProseMirror')?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, mergedHtml);
  await editor.locator("table").first().waitFor();
  check(await cellAt(editor, 2, 0).getAttribute("colspan") === "2", "the pasted merged cell did not keep its colspan");
  const before = await rowTexts(editor);
  await cellAt(editor, 0, 0).click();
  const mergedTarget = await bodyBox(editor, 0, 2);
  const refused = await dragGrip("column-0", () => ({ x: mergedTarget.x + mergedTarget.width * 0.8, y: mergedTarget.y + mergedTarget.height / 2 }));
  check(!refused.shown, "a drop that would split the merged cell still draws a drop line");
  await refused.release();
  await page.waitForTimeout(300);
  check(JSON.stringify(await rowTexts(editor)) === JSON.stringify(before), `the refused drop changed the table to ${JSON.stringify(await rowTexts(editor))}`);
  await cellAt(editor, 0, 0).click();
  await grip("column-0").click();
  const moveRight = page.getByRole("menuitem", { name: translate("table.moveColumnRight"), exact: true });
  check(await moveRight.isDisabled(), "Move column right is enabled for a column that is part of a merged cell");
  await page.keyboard.press("Escape");
  console.log("PASS a drop that would split a merged cell is refused: no drop line, the table is unchanged, and Move is disabled");

  await browser.close();
  browser = null;
} finally {
  await browser?.close();
  if (slug) {
    const { client, db } = createDatabase();
    await db.delete(workspaces).where(eq(workspaces.slug, slug));
    await db.delete(users).where(eq(users.email, `${slug}@example.test`));
    await client.end();
  }
  for (const server of servers) server.kill();
}
