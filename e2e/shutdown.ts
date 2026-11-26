class DeadlineError extends Error {}

/** Bound async teardown and discard the timer when the operation settles. */
export async function withDeadline<T>(operation: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(`${label} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Child = { readonly exited: Promise<number>; kill(signal: "SIGTERM" | "SIGKILL"): void };

export async function stopProcess(child: Child, graceMs = 5_000) {
  child.kill("SIGTERM");
  try {
    await withDeadline(child.exited, graceMs, "child exit");
  } catch (error) {
    if (!(error instanceof DeadlineError)) throw error;
    child.kill("SIGKILL");
    await withDeadline(child.exited, graceMs, "forced child exit");
  }
}

/** Attempt every step even if an earlier one fails. A caller handling a primary error can log secondary errors. */
export async function cleanUp(steps: Array<() => PromiseLike<unknown>>, onError?: (error: unknown) => void) {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { await step(); }
    catch (error) { errors.push(error); }
  }
  if (onError) { errors.forEach(onError); return; }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "e2e cleanup failed");
}
