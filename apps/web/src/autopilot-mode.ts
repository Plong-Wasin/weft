/** Autopilot may only be downgraded once both facts that allow it are known; a cold load must not look like "not allowed". */
export function shouldDowngradeAutopilot(input: { mode: string; setting: { allowAutopilot: boolean } | undefined; members: Array<{ userId: string; role: string }> | undefined; selfId: string }) {
  if (input.mode !== "autopilot" || !input.setting || !input.members) return false;
  const role = input.members.find((member) => member.userId === input.selfId)?.role;
  return !(input.setting.allowAutopilot && role !== undefined && role !== "Guest");
}
