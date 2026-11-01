/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { handleNavigation } from "./navigation-handler";

declare const self: ServiceWorkerGlobalScope;

// A new worker takes over open tabs as soon as it activates, instead of waiting for them to close.
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(new NavigationRoute(({ request }) => handleNavigation({
  fetch: () => fetch(request),
  offlinePage: () => matchPrecache("offline.html"),
})));

self.addEventListener("message", (event) => { if (event.data?.type === "SKIP_WAITING") void self.skipWaiting(); });
