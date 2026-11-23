import { useQuery } from "@tanstack/react-query";
import { action } from "./api";
import type { Member } from "./types";
import { useWorkspace } from "./layouts/workspace-layout";

export function workspaceMembersQuery(workspaceId: string) {
  return {
    queryKey: ["workspace-members", workspaceId] as const,
    queryFn: async () => await action<Member[]>("list_members", { workspaceId }) ?? [],
  };
}

export function useWorkspaceRole() {
  const { workspace, selfId } = useWorkspace();
  const { data: members } = useQuery(workspaceMembersQuery(workspace.id));
  return members?.find((member) => member.userId === selfId)?.role ?? null;
}
