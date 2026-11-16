import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test("the MCP address route reports the public origin the operator set, or null, without sign-in", async () => {
  const app = createApp(undefined, db);
  const previous = Bun.env.WEFT_PUBLIC_URL;
  const read = async () => (await app.handle(new Request("http://localhost/api/mcp/address"))).json();
  try {
    delete Bun.env.WEFT_PUBLIC_URL;
    expect(await read()).toEqual({ publicUrl: null });
    Bun.env.WEFT_PUBLIC_URL = "  https://weft.example/  ";
    expect(await read()).toEqual({ publicUrl: "https://weft.example" });
    Bun.env.WEFT_PUBLIC_URL = "not a url";
    expect(await read()).toEqual({ publicUrl: null });
  } finally {
    if (previous === undefined) delete Bun.env.WEFT_PUBLIC_URL; else Bun.env.WEFT_PUBLIC_URL = previous;
  }
});
