import { expect, test } from "bun:test";
import { checkInlineImage, uploadAsset, UploadError } from "../src/asset-upload";

const owner = { ownerType: "work_item" as const, ownerId: "w1" };
const asset = { id: "a1", filename: "a.png", inline: true };

function fakeFetch(handlers: Record<string, () => Response>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body });
    const key = Object.keys(handlers).find((name) => url.endsWith(name))!;
    return handlers[key]!();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("uploads through the presigned flow: ticket, storage POST with file last, complete", async () => {
  const { impl, calls } = fakeFetch({
    "/actions/request_asset_upload": () => Response.json({ assetId: "a1", url: "http://storage.test/bucket", fields: { key: "k", policy: "p" } }),
    "/bucket": () => new Response(null, { status: 204 }),
    "/actions/complete_asset_upload": () => Response.json(asset),
  });
  const result = await uploadAsset({ api: "http://api.test", fetch: impl }, owner, new File(["x"], "a.png", { type: "image/png" }));
  expect(result).toEqual(asset as never);
  expect(calls.map((call) => call.url)).toEqual(["http://api.test/actions/request_asset_upload", "http://storage.test/bucket", "http://api.test/actions/complete_asset_upload"]);
  expect([...(calls[1]!.body as FormData).keys()]).toEqual(["key", "policy", "file"]);
});

test("oversize file maps to the too-large message, from the Action or from storage", async () => {
  const file = new File(["x"], "big.bin", { type: "application/pdf" });
  const refused = fakeFetch({ "/actions/request_asset_upload": () => Response.json({ error: "x" }, { status: 413 }) });
  await expect(uploadAsset({ api: "http://api.test", fetch: refused.impl }, owner, file)).rejects.toMatchObject({ key: "assets.tooLarge" });
  const storage = fakeFetch({
    "/actions/request_asset_upload": () => Response.json({ assetId: "a1", url: "http://storage.test/bucket", fields: {} }),
    "/bucket": () => new Response("<Code>EntityTooLarge</Code>", { status: 400 }),
  });
  await expect(uploadAsset({ api: "http://api.test", fetch: storage.impl }, owner, file)).rejects.toMatchObject({ key: "assets.tooLarge" });
  const other = fakeFetch({ "/actions/request_asset_upload": () => Response.json({ error: "x" }, { status: 403 }) });
  await expect(uploadAsset({ api: "http://api.test", fetch: other.impl }, owner, file)).rejects.toMatchObject({ key: "assets.uploadFailed" });
});

test("only png, jpeg, gif and webp pass the inline check", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG; x=y"]) expect(() => checkInlineImage({ type })).not.toThrow();
  for (const type of ["image/svg+xml", "text/html", "application/pdf", ""]) expect(() => checkInlineImage({ type })).toThrow(UploadError);
});
