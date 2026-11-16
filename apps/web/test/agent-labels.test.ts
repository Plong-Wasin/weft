import { expect, test } from "bun:test";
import { profileSummary, runtimeParts } from "../src/agent-labels";

test("a Runtime shows its computer and tool from the separate fields", () => {
  expect(runtimeParts({ runtimeName: "a · b", runtimeHostname: "my · laptop", runtimeCli: "claude" })).toEqual({ computer: "my · laptop", tool: "claude" });
});

test("an older combined name is split defensively and a name without separator keeps the whole text", () => {
  expect(runtimeParts({ runtimeName: "dev-box · codex" })).toEqual({ computer: "dev-box", tool: "codex" });
  expect(runtimeParts({ runtimeName: "dev-box" })).toEqual({ computer: "dev-box", tool: null });
  expect(runtimeParts({ runtimeName: null })).toBeNull();
});

test("no profile chosen says Default, not a contradictory Full access with Sandbox on", () => {
  expect(profileSummary({ runtimeProfileName: null, runtimeProfileSandbox: null }, "en")).toEqual(["Default"]);
  expect(profileSummary({ runtimeProfileName: "Full access", runtimeProfileSandbox: "full" }, "en")).toEqual(["Permissions: Full access", "Full access: can change files on this computer"]);
  expect(profileSummary({ runtimeProfileName: "Run folder only", runtimeProfileSandbox: "run-folder" }, "en")).toEqual(["Permissions: Run folder only", "Sandbox on"]);
});
