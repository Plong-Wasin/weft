import { expect, test } from "bun:test";
import { serveWeb, waitFor } from "./harness";
import { stopProcess } from "./shutdown";

test("readiness rejects a foreign responder on the port of an exiting web server", async () => {
  const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other run") });
  const url = `http://127.0.0.1:${foreign.port}/`;
  const web = serveWeb(foreign.port, import.meta.dir, "127.0.0.1");
  try {
    await expect(waitFor(url)).rejects.toThrow(/did not start.*(?:exited|owned)/);
    expect(await (await fetch(url)).text()).toBe("other run");
  } finally {
    await stopProcess(web);
    foreign.stop(true);
  }
});
