/** The shared policy for AI initiated Write actions. */
export type WriteDecision = "run" | "confirmation" | "refused";
const neverOffered = new Set(["delete_project", "delete_workspace"]);
export function writeDecision(action: string, autopilot: boolean): WriteDecision {
  if (neverOffered.has(action)) return "refused";
  if (action.startsWith("delete_") || !autopilot) return "confirmation";
  return "run";
}
