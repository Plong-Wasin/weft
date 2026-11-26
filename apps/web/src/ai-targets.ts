import { useQuery } from "@tanstack/react-query";
import { action } from "./api";
import type { Target, TargetRef } from "./ai-results";
import { useWorkspace } from "./layouts/workspace-layout";

/** The most references, and the most display ids, that one resolve_targets request accepts. */
const batchSize = 200;

export async function fetchTargets(workspaceId: string | undefined, refs: TargetRef[], displayIds: string[]): Promise<Target[]> {
  const batches = Math.ceil(Math.max(refs.length, displayIds.length) / batchSize);
  const found = await Promise.all(Array.from({ length: batches }, async (_, index) => {
    const from = index * batchSize;
    const batch = await action<Target[]>("resolve_targets", { workspaceId, refs: refs.slice(from, from + batchSize), displayIds: displayIds.slice(from, from + batchSize) });
    if (!batch) throw new Error("resolve_targets failed");
    return batch;
  }));
  return found.flat();
}

/** Resolves references for the signed-in viewer. Undefined until the first answer, and after a failed request. */
export function useTargets(workspaceId: string | undefined, { refs = [], displayIds = [] }: { refs?: TargetRef[]; displayIds?: string[] }): Target[] | undefined {
  const { selfId } = useWorkspace();
  const empty = refs.length === 0 && displayIds.length === 0;
  const { data, isError } = useQuery({
    queryKey: ["ai-targets", workspaceId, selfId, refs.map((ref) => `${ref.kind}:${ref.id}`).join(","), displayIds.join(",")],
    queryFn: () => fetchTargets(workspaceId, refs, displayIds),
    enabled: workspaceId !== undefined && !empty,
    placeholderData: (previous, query) => query && query.queryKey[1] === workspaceId && query.queryKey[2] === selfId ? previous : undefined,
    refetchOnMount: "always",
  });
  return empty ? [] : isError ? undefined : data;
}
