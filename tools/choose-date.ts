import type { Locator } from "playwright";
import { translate, type Locale } from "../packages/shared/src";

/** The day a DatePicker trigger holds (`data-date-value`, YYYY-MM-DD, "" when empty). */
export async function dateValue(trigger: Locator): Promise<string> {
  return await trigger.locator("[data-date-value]").getAttribute("data-date-value") ?? "";
}

/** Waits up to 5s for a DatePicker trigger to hold `expected`, then fails with what it holds. */
export async function expectDate(trigger: Locator, expected: string, what = "date") {
  let actual = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    actual = await dateValue(trigger);
    if (actual === expected) return;
    await Bun.sleep(100);
  }
  throw new Error(`${what}: ${await trigger.getAttribute("aria-label")} holds "${actual}", expected "${expected}"`);
}

/**
 * Picks a day in a DatePicker trigger (a button labelled "<field>: <day>") the way a person does: open it, type the
 * year as the calendar shows it (Buddhist era in Thai), step to the month, click the day. `""` clicks "No date".
 * `locale` is the app language the panel is shown in. It fails when the trigger already holds `value` (the pick would prove nothing) and unless the trigger then holds
 * exactly `value`, so every call asserts the change it made.
 */
export async function chooseDate(trigger: Locator, value: string, { locale = "en" }: { locale?: Locale } = {}) {
  const page = trigger.page();
  const before = await dateValue(trigger);
  if (before === value) throw new Error(`${await trigger.getAttribute("aria-label")} already holds "${value}"; choose a different day so the pick is proven`);
  await trigger.click();
  const panel = page.locator('[data-popover-panel][role="dialog"]').filter({ has: page.locator("[data-date-picker]") }).last();
  await panel.waitFor();
  if (!value) {
    await panel.getByRole("button", { name: translate("datePicker.noDate", locale), exact: true }).click();
  } else {
    // The year box shows the locale's year; the offset from the Gregorian month keeps this working in every language.
    const year = panel.getByRole("spinbutton");
    const shown = Number(await year.inputValue());
    const current = Number((await panel.locator("[data-month]").getAttribute("data-month"))!.slice(0, 4));
    await year.fill(String(shown + Number(value.slice(0, 4)) - current));
    for (let turn = 0; turn < 12; turn++) {
      const month = await panel.locator("[data-month]").getAttribute("data-month");
      if (month === value.slice(0, 7)) break;
      await panel.getByRole("button", { name: month! < value.slice(0, 7) ? translate("datePicker.nextMonth", locale) : translate("datePicker.previousMonth", locale) }).click();
    }
    const month = await panel.locator("[data-month]").getAttribute("data-month");
    if (month !== value.slice(0, 7)) throw new Error(`calendar shows ${month}, could not reach ${value.slice(0, 7)}`);
    await panel.locator(`[data-date="${value}"]`).click();
  }
  await expectDate(trigger, value, `chooseDate from "${before}"`);
}
