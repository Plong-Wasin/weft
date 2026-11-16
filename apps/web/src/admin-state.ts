import type { Member } from "./types";

export type AdminState = "loading" | "admin" | "other";

/** Whether the viewer administers the workspace; "loading" until the members list has arrived, so Admins never see the not-allowed message. */
export function adminState(members: Member[] | null, selfId: string): AdminState {
  if (members === null) return "loading";
  return members.find((member) => member.userId === selfId)?.role === "Admin" ? "admin" : "other";
}
