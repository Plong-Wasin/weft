import React from "react";
import { Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { translate, type MessageKey } from "@weft/shared";
import { checkInlineImage, formatSize, uploadAsset, UploadError, type AssetRow, type OwnerRef } from "./asset-upload";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const deps = { api };

type Resolved = { url: string; inline: boolean } | null;
const cache = new Map<string, { at: number; value: Promise<Resolved> }>();
const cacheMs = 4 * 60_000; // presigned GET URLs last 5 minutes

/** Resolves an asset id to a short-lived storage URL. Only assets the server marks inline are ever shown as images. */
function resolveAsset(assetId: string): Promise<Resolved> {
  const hit = cache.get(assetId);
  if (hit && Date.now() - hit.at < cacheMs) return hit.value;
  const value = fetch(`${api}/actions/get_asset_download_url`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetId }) })
    .then(async (response) => (response.ok ? await response.json() as { url: string; inline: boolean } : null)).catch(() => null);
  cache.set(assetId, { at: Date.now(), value });
  return value;
}

type ImageOptions = { upload: ((file: File) => Promise<string | null>) | null; onReject: (key: MessageKey) => void };

/** Block node that references an asset by id; the document never stores a storage URL. */
export const AssetImage = Node.create<ImageOptions>({
  name: "assetImage",
  group: "block",
  atom: true,
  draggable: true,
  addOptions() { return { upload: null, onReject: () => {} }; },
  addAttributes() { return { assetId: { default: null } }; },
  parseHTML() { return [{ tag: "img[data-asset-id]" }]; },
  renderHTML({ node }) { return ["img", { "data-asset-id": node.attrs.assetId }]; },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      const image = document.createElement("img");
      image.alt = translate("assets.inlineImage");
      image.dataset.testid = "inline-image";
      image.dataset.assetId = String(node.attrs.assetId);
      image.style.maxWidth = "100%";
      dom.append(image);
      void resolveAsset(String(node.attrs.assetId)).then((resolved) => { if (resolved?.inline) image.src = resolved.url; else image.remove(); });
      return { dom };
    };
  },
  addProseMirrorPlugins() {
    const { editor, options } = this;
    async function insertAll(files: File[], at?: number) {
      if (!options.upload) return;
      for (const file of files) {
        try { checkInlineImage(file); } catch (error) { options.onReject((error as UploadError).key); continue; }
        const assetId = await options.upload(file);
        if (!assetId) continue;
        const chain = editor.chain().focus();
        if (at !== undefined) chain.setTextSelection(Math.min(at, editor.state.doc.content.size));
        chain.insertContent({ type: "assetImage", attrs: { assetId } }).run();
      }
    }
    return [new Plugin({
      props: {
        handlePaste: (_view, event) => {
          const files = [...(event.clipboardData?.files ?? [])];
          if (!files.length || !editor.isEditable) return false;
          event.preventDefault(); void insertAll(files); return true;
        },
        handleDrop: (view, event) => {
          const files = [...(event.dataTransfer?.files ?? [])];
          if (!files.length || !editor.isEditable) return false;
          event.preventDefault();
          void insertAll(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
          return true;
        },
      },
    })];
  },
});

/** An AssetImage extension that uploads pasted or dropped images to `owner`; `owner` null makes the editor display-only. */
export function useAssetImages(owner: OwnerRef | null) {
  const ownerRef = React.useRef(owner);
  ownerRef.current = owner;
  const [error, setError] = React.useState<string | null>(null);
  const extension = React.useMemo(() => AssetImage.configure({
    upload: async (file) => {
      const target = ownerRef.current;
      if (!target) return null;
      try { const asset = await uploadAsset(deps, target, file); setError(null); return asset.id; }
      catch (failure) { setError(translate(failure instanceof UploadError ? failure.key : "assets.uploadFailed")); return null; }
    },
    onReject: (key) => setError(translate(key)),
  }), []);
  return { extension, error };
}

/** Display-only variant for rendering stored documents. */
export const readOnlyImages = AssetImage.configure({ upload: null });

type Action = <T>(name: string, body: unknown) => Promise<T | null>;

export function AttachmentsPanel({ workItemId, canWrite, action, onChange }: { workItemId: string; canWrite: boolean; action: Action; onChange?: () => void }) {
  const owner: OwnerRef = { ownerType: "work_item", ownerId: workItemId };
  const [rows, setRows] = React.useState<AssetRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setRows(await action<AssetRow[]>("list_assets", { ownerType: "work_item", ownerId: workItemId }) ?? []), [action, workItemId]);
  React.useEffect(() => { void load(); }, [load]);

  async function attach(files: File[]) {
    if (!files.length) return;
    setBusy(true); setError(null);
    for (const file of files) {
      try { await uploadAsset(deps, owner, file); } catch (failure) { setError(translate(failure instanceof UploadError ? failure.key : "assets.uploadFailed")); }
    }
    setBusy(false); await load(); onChange?.();
  }
  async function download(row: AssetRow) {
    const result = await action<{ url: string; filename: string }>("get_asset_download_url", { assetId: row.id });
    if (!result) { setError(translate("assets.actionFailed")); return; }
    const link = document.createElement("a");
    link.href = result.url; link.download = result.filename; link.rel = "noopener";
    document.body.append(link); link.click(); link.remove();
  }
  async function remove(row: AssetRow) {
    setError((await action("delete_asset", { assetId: row.id })) === null ? translate("assets.actionFailed") : null);
    await load(); onChange?.();
  }

  return <section aria-label={translate("assets.title")} data-testid="attachments"
    onDragOver={(event) => { if (canWrite) event.preventDefault(); }}
    onDrop={(event) => { if (!canWrite) return; event.preventDefault(); void attach([...event.dataTransfer.files]); }}>
    <h3>{translate("assets.title")}</h3>
    {rows.length === 0 && <p>{translate("assets.empty")}</p>}
    {/* Files are only ever listed with a download link: nothing here is rendered inline. */}
    <ul>{rows.map((row) => <li key={row.id}>
      <button type="button" className="secondary" onClick={() => void download(row)}>{translate("assets.download")}</button>{" "}
      <span>{row.filename}</span> <small>{formatSize(row.size)}</small>
      {canWrite && <button type="button" className="secondary" aria-label={`${translate("assets.delete")} ${row.filename}`} onClick={() => void remove(row)}>{translate("assets.delete")}</button>}
    </li>)}</ul>
    {canWrite && <>
      <label>{translate("assets.attach")}<input type="file" multiple data-testid="attach-input" onChange={(event) => { void attach([...(event.target.files ?? [])]); event.target.value = ""; }} /></label>
      <p><small>{translate("assets.dropHint")}</small></p>
    </>}
    {busy && <p role="status">{translate("assets.uploading")}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
