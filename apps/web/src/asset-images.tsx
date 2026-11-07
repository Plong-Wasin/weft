import { api } from "./api";
import { Download, Paperclip, Trash2 } from "lucide-react";
import React from "react";
import { Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { translate, type MessageKey } from "@weft/shared";
import { assetImageAttributes } from "../../../packages/actions/src/wiki-editor-extensions";
import { checkInlineImage, formatSize, uploadAsset, UploadError, type AssetRow, type OwnerRef } from "./asset-upload";

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
  addAttributes: assetImageAttributes,
  parseHTML() { return [{ tag: "img[data-asset-id]" }]; },
  renderHTML({ node }) { return ["img", { "data-asset-id": node.attrs.assetId, ...(node.attrs.width ? { "data-width": node.attrs.width } : {}), "data-alignment": node.attrs.alignment }]; },
  addNodeView() {
    return ({ node, view, getPos }) => {
      let currentNode = node;
      const dom = document.createElement("figure");
      dom.className = "asset-image-node";
      dom.dataset.alignment = String(node.attrs.alignment ?? "center");
      const image = document.createElement("img");
      image.alt = translate("assets.inlineImage");
      image.dataset.testid = "inline-image";
      image.dataset.assetId = String(node.attrs.assetId);
      image.style.maxWidth = "100%";
      if (node.attrs.width) image.style.width = `${node.attrs.width}px`;
      dom.append(image);
      const controls = document.createElement("figcaption"); controls.className = "asset-image-controls";
      const action = (label: string, text: string, run: () => void) => { const button = document.createElement("button"); button.type = "button"; button.setAttribute("aria-label", label); button.textContent = text; button.onmousedown = (event) => event.preventDefault(); button.onclick = run; controls.append(button); return button; };
      let resolvedUrl = "";
      const update = (attrs: Record<string, unknown>) => { const pos = getPos(); if (typeof pos === "number") view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...currentNode.attrs, ...attrs })); };
      for (const [alignment, key] of [["left", "assets.alignLeft"], ["center", "assets.alignCenter"], ["right", "assets.alignRight"]] as const) action(translate(key), translate(key), () => update({ alignment }));
      action(translate("assets.downloadImage"), translate("assets.download"), () => { if (!resolvedUrl) return; const link = document.createElement("a"); link.href = resolvedUrl; link.download = "image"; link.rel = "noopener"; link.click(); });
      action(translate("assets.fullScreen"), translate("assets.fullScreen"), () => {
        if (!resolvedUrl) return;
        const dialog = document.createElement("dialog"); dialog.className = "asset-image-viewer";
        const large = document.createElement("img"); large.src = resolvedUrl; large.alt = image.alt; large.style.transformOrigin = "center";
        let zoom = 1;
        const button = (label: string, text: string, run: () => void) => { const item = document.createElement("button"); item.type = "button"; item.setAttribute("aria-label", label); item.textContent = text; item.onclick = run; dialog.append(item); };
        button(translate("assets.zoomOut"), "−", () => { zoom = Math.max(.25, zoom - .25); large.style.transform = `scale(${zoom})`; });
        button(translate("assets.zoomIn"), "+", () => { zoom = Math.min(4, zoom + .25); large.style.transform = `scale(${zoom})`; });
        button(translate("assets.closeViewer"), "×", () => dialog.close()); dialog.append(large); document.body.append(dialog);
        dialog.onclose = () => dialog.remove(); dialog.showModal();
      });
      const handle = document.createElement("button"); handle.type = "button"; handle.className = "asset-image-resize"; handle.setAttribute("aria-label", translate("assets.resizeImage")); handle.title = translate("assets.resizeImage");
      handle.onmousedown = (event) => { event.preventDefault(); const startX = event.clientX; const startWidth = image.getBoundingClientRect().width; const move = (next: MouseEvent) => { image.style.width = `${Math.max(80, Math.min(1200, startWidth + next.clientX - startX))}px`; }; const up = (next: MouseEvent) => { move(next); update({ width: Math.round(Math.max(80, Math.min(1200, startWidth + next.clientX - startX))) }); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", move); window.addEventListener("mouseup", up, { once: true }); };
      controls.append(handle);
      dom.append(controls);
      void resolveAsset(String(node.attrs.assetId)).then((resolved) => { if (resolved?.inline) { resolvedUrl = resolved.url; image.src = resolved.url; } else image.remove(); });
      return { dom, update: (next) => { currentNode = next; dom.dataset.alignment = String(next.attrs.alignment ?? "center"); image.style.width = next.attrs.width ? `${next.attrs.width}px` : ""; return true; } };
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
  const uploadFile = React.useCallback(async (file: File) => {
    try {
      checkInlineImage(file);
      const target = ownerRef.current;
      if (!target) return null;
      const asset = await uploadAsset(deps, target, file); setError(null); return asset.id;
    } catch (failure) { setError(translate(failure instanceof UploadError ? failure.key : "assets.uploadFailed")); return null; }
  }, []);
  const extension = React.useMemo(() => AssetImage.configure({
    upload: uploadFile,
    onReject: (key) => setError(translate(key)),
  }), [uploadFile]);
  return { extension, error, uploadFile };
}

/** Display-only variant for rendering stored documents. */
export const readOnlyImages = AssetImage.configure({ upload: null });

type Action = <T>(name: string, body: unknown) => Promise<T | null>;

export function AttachmentsPanel({ workItemId, canWrite, action, onChange, showForm, onCount, pickerRef }: { workItemId: string; canWrite: boolean; action: Action; onChange?: () => void; showForm: boolean; onCount: (count: number) => void; pickerRef?: React.RefObject<HTMLInputElement | null> }) {
  const owner: OwnerRef = { ownerType: "work_item", ownerId: workItemId };
  const [rows, setRows] = React.useState<AssetRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const load = React.useCallback(async () => setRows(await action<AssetRow[]>("list_assets", { ownerType: "work_item", ownerId: workItemId }) ?? []), [action, workItemId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { onCount(rows.length); }, [onCount, rows.length]);

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
    onDragEnter={(event) => { if (canWrite) { event.preventDefault(); setDragging(true); } }}
    onDragOver={(event) => { if (canWrite) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={(event) => { if (!(event.relatedTarget instanceof Element) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
    onDrop={(event) => { if (!canWrite) return; event.preventDefault(); setDragging(false); void attach([...event.dataTransfer.files]); }}>
    {/* Files are only ever listed with a download link: nothing here is rendered inline. */}
    <ul className="m-0 grid list-none gap-1.5 !pl-0">{rows.map((row) => <li key={row.id} className="flex items-center gap-2 rounded-md bg-layer-1 px-2.5 py-1.5 text-13">
      <Paperclip aria-hidden size={13} className="shrink-0 text-tertiary" />
      <span className="min-w-0 truncate text-primary" title={row.filename}>{row.filename}</span>
      <small className="shrink-0 text-12 text-tertiary">{formatSize(row.size)}</small>
      <span className="ml-auto flex shrink-0 gap-0.5">
        <button type="button" className="grid size-7 place-items-center rounded-md !bg-transparent !p-0 text-secondary hover:!bg-layer-transparent-hover hover:text-primary" aria-label={`${translate("assets.download")} ${row.filename}`} title={translate("assets.download")} onClick={() => void download(row)}><Download aria-hidden size={13} /></button>
        {canWrite && <button type="button" className="grid size-7 place-items-center rounded-md !bg-transparent !p-0 text-secondary hover:!bg-layer-transparent-hover hover:!text-danger-text" aria-label={`${translate("assets.delete")} ${row.filename}`} title={translate("assets.delete")} onClick={() => void remove(row)}><Trash2 aria-hidden size={13} /></button>}
      </span>
    </li>)}</ul>
    {canWrite && <input ref={pickerRef} hidden type="file" multiple data-testid="attach-input" onChange={(event) => { void attach([...(event.target.files ?? [])]); event.target.value = ""; }} />}
    {canWrite && showForm && <div data-testid="attachment-dropzone" role="button" tabIndex={0}
      aria-label={translate("assets.dropHint")}
      className={`my-3 grid min-h-20 cursor-pointer place-items-center rounded border border-dashed p-4 text-center text-13 text-secondary ${dragging ? "border-accent bg-accent/10" : "border-subtle"}`}
      onClick={() => pickerRef?.current?.click()}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pickerRef?.current?.click(); } }}>
      {translate("assets.dropHint")}
    </div>}
    {busy && <p role="status">{translate("assets.uploading")}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
