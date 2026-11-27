import { readFileSync } from "node:fs";

/** MemAvailable a run needs before it starts three flows at once; see "Default workers" in docs/agents/testing.md. */
export const threeWorkerMiB = 10 * 1024;

export function memAvailableMiB(meminfo: string): number | undefined {
  const kib = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo)?.[1];
  return kib === undefined ? undefined : Math.floor(Number(kib) / 1024);
}

export function defaultWorkers(availableMiB: number | undefined): number {
  return availableMiB !== undefined && availableMiB >= threeWorkerMiB ? 3 : 2;
}

/** The default for this host now. Without /proc/meminfo it is two. */
export function hostDefaultWorkers(): number {
  try {
    return defaultWorkers(memAvailableMiB(readFileSync("/proc/meminfo", "utf8")));
  } catch {
    return 2;
  }
}
