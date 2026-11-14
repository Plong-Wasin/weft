import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test("the CLI version route reports the newest version the operator set, or null, without sign-in", async () => {
  const app = createApp(undefined, db);
  const previous = Bun.env.WEFT_CLI_LATEST_VERSION;
  const read = async () => (await app.handle(new Request("http://localhost/api/cli/version"))).json();
  try {
    delete Bun.env.WEFT_CLI_LATEST_VERSION;
    expect(await read()).toEqual({ latest: null });
    Bun.env.WEFT_CLI_LATEST_VERSION = " 1.2.0 ";
    expect(await read()).toEqual({ latest: "1.2.0" });
  } finally {
    if (previous === undefined) delete Bun.env.WEFT_CLI_LATEST_VERSION; else Bun.env.WEFT_CLI_LATEST_VERSION = previous;
  }
});
