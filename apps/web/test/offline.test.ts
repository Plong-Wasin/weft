import { expect, test } from "bun:test";
import { handleNavigation } from "../src/navigation-handler";

test("online navigation returns the network response", async () => {
  const network = new Response("app");
  const response = await handleNavigation({ fetch: async () => network, offlinePage: async () => new Response("offline") });
  expect(response).toBe(network);
});

test("offline navigation returns the offline page", async () => {
  const response = await handleNavigation({
    fetch: async () => { throw new TypeError("Failed to fetch"); },
    offlinePage: async () => new Response("offline page"),
  });
  expect(await response.text()).toBe("offline page");
});

test("offline navigation without a cached offline page still answers 503", async () => {
  const response = await handleNavigation({
    fetch: async () => { throw new TypeError("Failed to fetch"); },
    offlinePage: async () => undefined,
  });
  expect(response.status).toBe(503);
});
