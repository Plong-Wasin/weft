import { expect, test } from "bun:test";
import { resources, type MessageKey } from "@weft/shared";
import { autoRuleReasonText, undoableAutoRuleIds } from "../src/auto-rule-reason";

const stored = JSON.stringify({ autoRule: "idle_close", days: 30, from: "In Progress", to: "Done" });
const inLocale = (locale: "en" | "th") => (key: MessageKey) => resources[locale][key];

test("a structured reason is written in the reader's language", () => {
  expect(autoRuleReasonText(stored, inLocale("en"))).toBe("No activity for 30 days in In Progress, so it moved to Done");
  expect(autoRuleReasonText(stored, inLocale("th"))).toBe("ไม่มีความเคลื่อนไหวเป็นเวลา 30 วันในสถานะ In Progress จึงย้ายไปเป็น Done");
  expect(autoRuleReasonText(JSON.stringify({ autoRule: "done_archive", days: 7 }), inLocale("th"))).toBe("เสร็จแล้วเป็นเวลา 7 วัน จึงเก็บเข้าคลัง");
  expect(autoRuleReasonText(JSON.stringify({ autoRule: "idle_close", days: 3, from: null, to: null }), inLocale("en"))).toBe("No activity for 3 days in its state, so it moved to a closed state");
});

test("an old row that stored an English sentence is shown as stored, and no reason stays null", () => {
  const old = "Done for 30 days, so it was archived";
  expect(autoRuleReasonText(old, inLocale("th"))).toBe(old);
  expect(autoRuleReasonText("123", inLocale("th"))).toBe("123");
  expect(autoRuleReasonText(null, inLocale("th"))).toBeNull();
});

test("only the latest automatic change to a field can be undone; an archive and its restore are one field", () => {
  const rows = [
    { id: "a1", field: "state", source: "auto_rule" },
    { id: "a2", field: "state", source: "user" },
    { id: "a3", field: "state", source: "auto_rule" },
    { id: "b1", field: "archived", source: "auto_rule" },
    { id: "b2", field: "restored", source: "user" },
    { id: "c1", field: "archived", source: "auto_rule" },
  ];
  expect([...undoableAutoRuleIds(rows)].sort()).toEqual(["a3", "c1"]);
  expect([...undoableAutoRuleIds(rows.slice(0, 5))]).toEqual(["a3"]);
});
