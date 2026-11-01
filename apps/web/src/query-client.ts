import { QueryClient } from "@tanstack/react-query";

/** Memory-only cache: never wire a persister here; data must not reach the device. */
export function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });
}
