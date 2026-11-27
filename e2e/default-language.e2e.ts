// Signed-out language follows the optional instance default and remains changeable.
import { launchBrowser, newContext, newPage, startApi, startWeb, waitFor, waitUntil } from "./harness";
import { mkdir } from "node:fs/promises";
import { reviewShots } from "../tools/visual/paths";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3118);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5218);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("18-default-language");
// The dev server, not a build served by `vite preview`: a build writes apps/web/dist, which flows running side by side would overwrite under each other.
const servers = [
  startApi(apiPort, web, { env: { ...Bun.env, DEFAULT_LANGUAGE: "th" } }),
  startWeb(webPort, { api }),
];

let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
try {
  await Promise.all([waitFor(`${api}/api/config`), waitFor(web)]);
  browser = await launchBrowser();
  const page = await newPage(browser, { locale: "en-US" });
  await page.goto(web);
  // The language control is a shadcn Select (combobox trigger + listbox), not a native select.
  const language = page.getByRole("combobox", { name: "Language" }).or(page.getByRole("combobox", { name: "ภาษา" }));
  await language.waitFor();
  const initialLanguage = (await language.textContent())?.trim();
  if (!initialLanguage?.includes("ไทย")) throw new Error(`the signed-out language must start with the configured Thai default; got ${JSON.stringify(initialLanguage)}`);
  await page.getByText("ภาษาเริ่มต้นขณะนี้: ไทย คุณเปลี่ยนได้").waitFor();
  await saveShot(page, { path: `${shots}/signed-out-thai-default.png` });
  const evidence = `${process.cwd()}/.local/shots/shadcn-02/after`;
  await mkdir(evidence, { recursive: true });
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 1180], [768, 1024], [844, 390], [667, 375], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const box = await language.boundingBox();
      if (!box || box.left < 0 || box.right > width || box.top < 0 || box.bottom > height) throw new Error(`Language Select is clipped at ${width}x${height} (${theme}): ${JSON.stringify(box)}`);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error(`The signed-out language screen scrolls horizontally at ${width}x${height} (${theme})`);
      await saveShot(page, { path: `${evidence}/language-${width}x${height}-${theme}.png`, fullPage: true });
    }
  }
  const touchContext = await newContext(browser, { locale: "en-US", viewport: { width: 667, height: 375 }, isMobile: true, hasTouch: true });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(web);
  const touchLanguage = touchPage.getByRole("combobox").first();
  await touchLanguage.waitFor();
  const touchTarget = await touchLanguage.boundingBox();
  if (!touchTarget || touchTarget.width < 44 || touchTarget.height < 44) throw new Error(`The touch Language Select must be at least 44x44px: ${JSON.stringify(touchTarget)}`);
  await touchContext.close();
  await page.setViewportSize({ width: 667, height: 375 });
  await language.focus();
  await page.keyboard.press("Shift");
  const focusRing = await language.evaluate((element) => getComputedStyle(element).boxShadow);
  if (focusRing === "none") throw new Error("Keyboard focus should draw a ring around the Language Select");
  await page.keyboard.press("Enter");
  await waitUntil(async () => await language.getAttribute("aria-expanded") === "true", "Enter should open the Language Select");
  const popup = page.getByRole("listbox");
  // The list takes focus after it opens; keys sent before that are lost.
  await page.locator('[role="option"]:focus').waitFor();
  const popupBox = await popup.boundingBox();
  if (!popupBox || popupBox.top < 0 || popupBox.bottom > 375) throw new Error(`Language options should fit the short landscape viewport: ${JSON.stringify(popupBox)}`);
  await page.keyboard.press("Escape");
  await waitUntil(async () => await language.getAttribute("aria-expanded") === "false" && await language.evaluate((element) => document.activeElement === element), "Escape should close the Language Select and restore trigger focus");
  await page.keyboard.press("Enter");
  // The list takes focus after it opens; keys sent before that are lost.
  await page.locator('[role="option"]:focus').waitFor();
  await page.keyboard.press("ArrowUp");
  await page.getByRole("option", { name: "English" }).and(page.locator(":focus")).waitFor();
  await page.keyboard.press("Enter");
  const englishLanguage = page.getByRole("combobox", { name: "Language" });
  if (!(await englishLanguage.textContent())?.includes("English")) throw new Error("ArrowUp and Enter should select English from the Language Select");
  await page.keyboard.press("Tab");
  await englishLanguage.and(page.locator(":not(:focus)")).waitFor();
  if (await englishLanguage.evaluate((element) => document.activeElement === element)) throw new Error("Tab should move focus away from the Language Select");
  await englishLanguage.click();
  await page.getByRole("option", { name: "ไทย" }).click();
  if (!(await page.getByRole("combobox", { name: "ภาษา" }).textContent())?.includes("ไทย")) throw new Error("the signed-out user must be able to change the language to Thai");
  const thaiLanguage = page.getByRole("combobox", { name: "ภาษา" });
  await thaiLanguage.click();
  await page.getByRole("option", { name: "English" }).click();
  const selectedLanguage = (await englishLanguage.textContent())?.trim();
  if (!selectedLanguage?.includes("English")) throw new Error(`the signed-out user must be able to change the language; got ${JSON.stringify(selectedLanguage)}`);
  await page.getByText("Current default: ไทย. You can change it.").waitFor();
  console.log("e2e default-language: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
