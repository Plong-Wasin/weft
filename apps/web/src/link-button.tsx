import React from "react";
import { Link2 } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { translate } from "@weft/shared";
import { normalizeLinkUrl } from "./link-url";
import { OPEN_LINK_EVENT, withShortcut } from "./shortcuts";

const DIALOG_WIDTH = 320;

/** The editor Link action: a labelled small form (URL, Save, Remove, Cancel) instead of the browser prompt. */
export function LinkButton({ editor, iconOnly = false, disabled = false }: { editor: Editor | null; iconOnly?: boolean; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [place, setPlace] = React.useState<{ top: number; left: number; width: number }>();
  const root = React.useRef<HTMLDivElement>(null);
  const form = React.useRef<HTMLFormElement>(null);
  const label = translate("wiki.tool.link");
  useCloseOnOutside(open, root, () => setOpen(false));
  const openForm = React.useCallback(() => {
    if (!editor || disabled || !editor.isEditable) return;
    setUrl(String(editor.getAttributes("link").href ?? ""));
    // Fixed to the viewport so the form never runs off a narrow screen; it closes if the page scrolls away from it.
    const bounds = root.current?.getBoundingClientRect();
    const width = Math.min(DIALOG_WIDTH, window.innerWidth - 16);
    setPlace({ top: (bounds?.bottom ?? 0) + 4, left: Math.max(8, Math.min(bounds?.left ?? 8, window.innerWidth - width - 8)), width });
    setOpen(true);
  }, [editor, disabled]);
  React.useEffect(() => {
    if (!open) return;
    // A mobile keyboard resizes the window while the field is focused: keep the form open then.
    const close = () => { if (form.current?.contains(document.activeElement)) return; setOpen(false); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [open]);
  React.useEffect(() => {
    const onShortcut = () => { if (editor?.isFocused && editor.isEditable && !disabled) openForm(); };
    document.addEventListener(OPEN_LINK_EVENT, onShortcut);
    return () => document.removeEventListener(OPEN_LINK_EVENT, onShortcut);
  }, [editor, openForm, disabled]);
  if (!editor) return null;
  const active = editor.isActive("link");
  const close = () => setOpen(false);
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const href = normalizeLinkUrl(url);
    if (!href) return;
    if (editor.state.selection.empty) editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    else editor.chain().focus().setLink({ href }).run();
    close();
  };
  return <div ref={root} className="relative inline-flex">
    <button type="button" aria-label={label} title={withShortcut(label, "K")} aria-haspopup="dialog" aria-expanded={open} aria-pressed={active} disabled={disabled}
      className={iconOnly ? `editor-tool${active ? " bg-layer-1-selected text-primary" : ""}` : "editor-tool-label"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { if (open) setOpen(false); else openForm(); }}>
      <Link2 aria-hidden size={14} />{iconOnly ? null : <span>{label}</span>}
    </button>
    {open && <form ref={form} role="dialog" aria-label={label} className="link-dialog m-0" style={place ? { position: "fixed", top: place.top, left: place.left, width: place.width } : undefined} onSubmit={save} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); editor.commands.focus(); } }}>
      <label>{translate("wiki.linkUrl")}<input autoFocus type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={url} placeholder={translate("wiki.linkPlaceholder")} onChange={(event) => setUrl(event.target.value)} /></label>
      <small className="text-12 text-tertiary">{translate("wiki.linkHelp")}</small>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="primary">{translate("wiki.linkSave")}</button>
        {active && <button type="button" className="secondary" onClick={() => { editor.chain().focus().unsetLink().run(); close(); }}>{translate("wiki.linkRemove")}</button>}
        <button type="button" className="secondary" onClick={() => { close(); editor.commands.focus(); }}>{translate("comments.cancel")}</button>
      </div>
    </form>}
  </div>;
}

function useCloseOnOutside(open: boolean, root: React.RefObject<HTMLElement | null>, close: () => void) {
  React.useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open, root, close]);
}
