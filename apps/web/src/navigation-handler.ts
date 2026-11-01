export type NavigationDeps = {
  fetch: () => Promise<Response>;
  offlinePage: () => Promise<Response | undefined>;
};

/** Network first; when the network fails, answer with the precached offline page. */
export async function handleNavigation(deps: NavigationDeps): Promise<Response> {
  try {
    return await deps.fetch();
  } catch {
    return (await deps.offlinePage()) ?? new Response("Offline", { status: 503 });
  }
}
