import type { Locator } from "playwright";
import { translate } from "../packages/shared/src";

/**
 * Picks a day in a shadcn DatePicker trigger (a button labelled "<field>: <day>") the way a person does: open it,
 * move the calendar to the month, click the day. It fails unless the trigger then shows that exact day
 * (`data-date-value`), so every call also asserts the value it stored.
 */
export async function chooseDate(trigger: Locator, value: string) {
  const page = trigger.page();
  await trigger.click();
  const panel = page.locator('[data-popover-panel][role="dialog"]').filter({ has: page.locator("[data-date-picker]") }).last();
  await panel.waitFor();
  await panel.getByRole("spinbutton", { name: "Year" }).fill(value.slice(0, 4));
  for (let turn = 0; turn < 120; turn++) {
    const month = await panel.locator("[data-month]").getAttribute("data-month");
    if (month === value.slice(0, 7)) break;
    await panel.getByRole("button", { name: month! < value.slice(0, 7) ? translate("datePicker.nextMonth") : translate("datePicker.previousMonth") }).click();
  }
  await panel.locator(`[data-date="${value}"]`).click();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await trigger.locator("[data-date-value]").getAttribute("data-date-value") === value) return;
    await Bun.sleep(100);
  }
  throw new Error(`${await trigger.getAttribute("aria-label")} did not retain ${value}`);
}
