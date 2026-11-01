import React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** Exponential backoff with jitter: attempt 0 waits about 1 s, capped at 30 s. */
export function backoffDelay(attempt: number, random: () => number = Math.random) {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling * (0.75 + random() * 0.25));
}

interface Source {
  addEventListener(name: string, listener: (event: { data: string }) => void): void;
  close(): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
}

interface Options {
  url: string;
  createSource?: (url: string) => Source;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * Opens the SSE stream. Signals carry no data: they only invalidate TanStack Query caches, and the
 * refetch goes through the Actions, which enforce permissions. Reconnects with backoff and refetches
 * on every reopen, because signals sent while disconnected are lost.
 */
export function connectLiveUpdates(client: QueryClient, options: Options) {
  const createSource = options.createSource ?? ((url) => new EventSource(url, { withCredentials: true }) as unknown as Source);
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id));
  let source: Source | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;
  let reconnected = false;

  function open() {
    timer = null;
    const current = createSource(options.url);
    source = current;
    current.addEventListener("notification", (event) => {
      const { workspaceId } = JSON.parse(event.data) as { workspaceId: string };
      void client.invalidateQueries({ queryKey: ["inbox", workspaceId] });
    });
    current.addEventListener("change", () => { void client.invalidateQueries(); });
    current.onopen = () => {
      attempt = 0;
      if (reconnected) void client.invalidateQueries();
    };
    current.onerror = () => {
      current.close();
      if (closed) return;
      reconnected = true;
      timer = setTimer(open, backoffDelay(attempt++));
    };
  }

  open();
  return {
    close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      source?.close();
    },
  };
}

/** Keeps the SSE stream open while someone is signed in. */
export function useLiveUpdates(enabled: boolean, apiUrl: string) {
  const client = useQueryClient();
  React.useEffect(() => {
    if (!enabled) return;
    const connection = connectLiveUpdates(client, { url: `${apiUrl}/api/events` });
    return () => connection.close();
  }, [client, enabled, apiUrl]);
}
