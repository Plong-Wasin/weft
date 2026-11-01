/// <reference lib="webworker" />
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { handleNavigation } from "./navigation-handler";

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(new NavigationRoute(({ request }) => handleNavigation({
  fetch: () => fetch(request),
  offlinePage: () => matchPrecache("offline.html"),
})));

self.addEventListener("message", (event) => { if (event.data?.type === "SKIP_WAITING") void self.skipWaiting(); });
