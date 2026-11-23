import { translate } from "@weft/shared";

export function cliDeviceApprovalErrorMessage(kind: "load" | "decision", _reason: unknown): string {
  return translate(kind === "load" ? "cliDevice.loadFailed" : "cliDevice.decisionFailed");
}
