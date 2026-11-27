// Port rules for the browser flows, shared by run-all.ts and ports.test.ts.
// A flow's API port is the base plus twice its worker number; its web port is that plus 20000 and its live (Wiki collaboration) port that plus 10000. Nothing here kills a process.

/** The web port is the API port plus this offset. */
export const webPortOffset = 20_000;
/** The live server port is the API port plus this offset: the Wiki flows start their own live server, and two on one fixed port made the second one talk to the first one's server. */
export const livePortOffset = 10_000;
/** Lowest base accepted: ports below 1024 need root. */
export const minPortBase = 1024;
/** Lowest port of the Linux ephemeral range (`net.ipv4.ip_local_port_range`, 32768-60999). The kernel hands these to outbound connections (Chromium, fetch, database clients), so a server bound there can lose the port before it starts and fail with EADDRINUSE. Every derived port stays below this. */
export const ephemeralPortFloor = 32_768;

/** Highest base accepted for a run with this many workers: the last worker's web port (the highest of the three) must stay below the ephemeral range. */
export function maxPortBase(workers = 1): number {
  return ephemeralPortFloor - 1 - webPortOffset - (workers - 1) * 2;
}

/** The default base comes from the checkout's directory name, so two checkouts on one machine rarely share ports. The range is 2000 to 9999, which keeps every port below the ephemeral range for up to 100 workers. */
export function defaultPortBase(directoryName: string): number {
  return 2_000 + Number(Bun.hash(directoryName) % 8_000n);
}

/** `E2E_PORT_BASE` when set, otherwise the directory's default. A base that would put any port of any worker into the ephemeral range is refused with a message, before any flow starts. */
export function resolvePortBase(value: string | undefined, directoryName: string, workers = 1): number {
  const base = value?.trim() ? Number(value) : defaultPortBase(directoryName);
  const limit = maxPortBase(workers);
  if (!Number.isInteger(base) || base < minPortBase || base > limit) {
    throw new Error(`E2E_PORT_BASE=${value?.trim() || base} refused: use a whole number from ${minPortBase} to ${limit} with ${workers} worker(s). The web port (base + ${webPortOffset}) must stay below ${ephemeralPortFloor}, the ephemeral range, where the OS hands out ports to outbound connections and a flow's server can lose its port (EADDRINUSE)`);
  }
  return base;
}

/** The API, web and live ports of the flow that runs on one worker. */
export function workerPorts(base: number, worker: number): { api: number; web: number; live: number } {
  return { api: base + worker * 2, web: base + webPortOffset + worker * 2, live: base + livePortOffset + worker * 2 };
}

/** The processes listening on a TCP port, with an empty list when the port is free. */
export function listenersOn(port: number): { pid: number; command: string }[] {
  // lsof -F prints one field per line: p<pid>, then c<command>. It exits 1 when nothing listens.
  const { stdout, exitCode } = Bun.spawnSync(["lsof", "-nP", "-Fpc", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" });
  if (exitCode !== 0 && exitCode !== 1) throw new Error(`could not inspect listeners on port ${port}`);
  const listeners: { pid: number; command: string }[] = [];
  let pid = 0;
  for (const line of stdout.toString().split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c") && pid) listeners.push({ pid, command: line.slice(1) });
  }
  return listeners;
}

/** The first listener formatted for diagnostics. */
export function listenerOn(port: number): string | undefined {
  const listener = listenersOn(port)[0];
  return listener && `${listener.command} (pid ${listener.pid})`;
}
