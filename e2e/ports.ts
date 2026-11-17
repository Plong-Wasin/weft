// Port rules for the browser flows, shared by run-all.ts and ports.test.ts.
// A flow's API port is the base plus twice its worker number; its web port is that plus 20000. Nothing here kills a process.

/** The web port is the API port plus this offset. */
export const webPortOffset = 20_000;
/** Lowest base accepted: ports below 1024 need root. */
export const minPortBase = 1024;
/** Highest base accepted: the web port (base + 20000) must stay below 65535, so the base is at most 45534. */
export const maxPortBase = 65_534 - webPortOffset;

/** The default base comes from the checkout's directory name, so two checkouts on one machine rarely share ports. The range is 30000 to 39999. */
export function defaultPortBase(directoryName: string): number {
  return 30_000 + Number(Bun.hash(directoryName) % 10_000n);
}

/** `E2E_PORT_BASE` when set, otherwise the directory's default. A base that would push a web port to 65535 or more is refused with a message, before any flow starts. */
export function resolvePortBase(value: string | undefined, directoryName: string): number {
  if (value === undefined || value.trim() === "") return defaultPortBase(directoryName);
  const base = Number(value);
  if (!Number.isInteger(base) || base < minPortBase || base > maxPortBase) {
    throw new Error(`E2E_PORT_BASE=${value} refused: it must be a whole number from ${minPortBase} to ${maxPortBase}, because the web port is base + ${webPortOffset} and must stay below 65535`);
  }
  return base;
}

/** The API and web ports of the flow that runs on one worker. */
export function workerPorts(base: number, worker: number): { api: number; web: number } {
  return { api: base + worker * 2, web: base + webPortOffset + worker * 2 };
}

/** The process listening on a TCP port, as `command (pid N)`, or undefined when the port is free. Read-only: it never signals anything. */
export function listenerOn(port: number): string | undefined {
  // lsof -F prints one field per line: p<pid>, then c<command>. It exits 1 when nothing listens.
  const { stdout } = Bun.spawnSync(["lsof", "-nP", "-Fpc", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" });
  let pid = "";
  for (const line of stdout.toString().split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("c") && pid) return `${line.slice(1)} (pid ${pid})`;
  }
  return undefined;
}
