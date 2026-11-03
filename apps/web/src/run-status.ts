import type { MessageKey } from "@weft/shared";

export type RunLike = { id: string; status: string; createdAt: string };

const active = new Set(["queued", "dispatched", "running", "waiting_confirmation", "awaiting_input", "stopping"]);

/** A Run that has not reached a final status yet. */
export const isActiveRun = (run: RunLike) => active.has(run.status);

/** Mirrors the `cancel_run` Action: any active Run, unless it is already stopping. */
export const canCancelRun = (run: RunLike) => isActiveRun(run) && run.status !== "stopping";

/** Mirrors the `rerun_run` Action. */
export const canRerunRun = (run: RunLike) => ["failed", "cancelled", "stale"].includes(run.status);

export const latestRun = <T extends RunLike>(runs: T[]): T | null => runs.reduce<T | null>((best, run) => !best || run.createdAt > best.createdAt ? run : best, null);

export const runStatusKey = (status: string) => `runs.status.${status}` as MessageKey;
