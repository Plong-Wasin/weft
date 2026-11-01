import type { MessageKey } from "@weft/shared";

export type OwnerType = "work_item" | "comment" | "wiki_page";
export type OwnerRef = { ownerType: OwnerType; ownerId: string };
export type AssetRow = { id: string; ownerType: OwnerType; ownerId: string; uploaderId: string; filename: string; contentType: string; size: number; inline: boolean; createdAt: string };

/** Mirrors the server's inline list (packages/actions/src/storage.ts); the server stays the authority and also reports `inline` per asset. */
export const inlineImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export class UploadError extends Error {
  constructor(readonly key: MessageKey) { super(key); }
}

export type UploadDeps = { api: string; fetch?: typeof fetch };

async function post(deps: UploadDeps, name: string, body: unknown) {
  return (deps.fetch ?? fetch)(`${deps.api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Presigned flow: request a ticket, POST the bytes straight to storage (file field last), then complete. */
export async function uploadAsset(deps: UploadDeps, owner: OwnerRef, file: File): Promise<AssetRow> {
  const contentType = file.type || "application/octet-stream";
  const ticketResponse = await post(deps, "request_asset_upload", { ...owner, filename: file.name || "file", contentType, size: file.size });
  if (!ticketResponse.ok) throw new UploadError(ticketResponse.status === 413 ? "assets.tooLarge" : "assets.uploadFailed");
  const ticket = await ticketResponse.json() as { assetId: string; url: string; fields: Record<string, string> };
  const form = new FormData();
  for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
  form.append("file", file);
  const stored = await (deps.fetch ?? fetch)(ticket.url, { method: "POST", body: form });
  if (!stored.ok) {
    const text = await stored.text().catch(() => "");
    throw new UploadError(stored.status === 413 || text.includes("EntityTooLarge") ? "assets.tooLarge" : "assets.uploadFailed");
  }
  const done = await post(deps, "complete_asset_upload", { assetId: ticket.assetId });
  if (!done.ok) throw new UploadError(done.status === 413 ? "assets.tooLarge" : "assets.uploadFailed");
  return await done.json() as AssetRow;
}

/** Editors only embed png, jpeg, gif and webp; anything else (SVG included) must be attached as a download instead. */
export function checkInlineImage(file: { type: string }) {
  if (!inlineImageTypes.includes(file.type.split(";")[0]!.trim().toLowerCase())) throw new UploadError("assets.imageTypeNotAllowed");
}

export function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
