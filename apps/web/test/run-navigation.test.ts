import { describe, expect, test } from "bun:test";
import { runFocusHref } from "../src/routes";

describe("opening a Run from its work item", () => {
  test("keeps the current route and peek query while selecting the Run", () => {
    expect(runFocusHref("run-123", "https://weft.test/team/projects/MOB/issues?peek=MOB-1&layout=board"))
      .toBe("/team/projects/MOB/issues?peek=MOB-1&layout=board&run=run-123");
  });

  test("supports a direct work item URL and replaces an earlier Run selection", () => {
    expect(runFocusHref("run-456", "https://weft.test/team/browse/MOB-1?run=run-old#comments"))
      .toBe("/team/browse/MOB-1?run=run-456#comments");
  });
});
