import React from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { History, Maximize2, Sparkles, SquarePen, X } from "lucide-react";
import { translate } from "@weft/shared";
import type { UIMessage } from "ai";
import { chatsKey, Conversation, post, type ChatMode, type Recent, type SidecarContext, type Workspace } from "./ai-chat";
import { paths } from "./routes";
import { Popover, menuItemClass } from "./shell/popover";

export const SIDECAR_MIN = 320;
export const SIDECAR_MAX = 720;
export const SIDECAR_DEFAULT = 420;
const widthKey = (userId: string) => `weft.sidecar.width.${userId}`;

export function clampWidth(width: number, viewport: number = window.innerWidth) {
  return Math.round(Math.min(Math.max(width, SIDECAR_MIN), Math.max(SIDECAR_MIN, Math.min(SIDECAR_MAX, viewport - 320))));
}

/** The panel width is a per-user, per-browser preference. */
export function readWidth(userId: string): number {
  try { const stored = Number(localStorage.getItem(widthKey(userId))); if (Number.isFinite(stored) && stored > 0) return clampWidth(stored); } catch { /* storage unavailable: use the default */ }
  return SIDECAR_DEFAULT;
}

type Chat = { id: string; initial: UIMessage[]; mode: ChatMode };
const freshChat = (): Chat => ({ id: crypto.randomUUID(), initial: [], mode: "build" });

type SidecarState = { open: boolean; show: () => void; hide: () => void; toggle: () => void; setContext: (context: SidecarContext | undefined) => void };
const SidecarContextValue = React.createContext<SidecarState | null>(null);

export function useSidecar(): SidecarState {
  const value = React.useContext(SidecarContextValue);
  if (!value) throw new Error("useSidecar needs a SidecarProvider");
  return value;
}

/** Holds whether the Sidecar is open and which entity the current page offers as context. The panel itself (SidecarPanel) keeps the chat mounted while closed, so closing never loses it. */
export function SidecarProvider({ workspace, userId, children }: { workspace: Workspace; userId: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [context, setContext] = React.useState<SidecarContext | undefined>();
  const state = React.useMemo<SidecarState>(() => ({ open, show: () => setOpen(true), hide: () => setOpen(false), toggle: () => setOpen((value) => !value), setContext }), [open]);
  return <SidecarContextValue.Provider value={state}>
    {children}
    <PanelSlot workspace={workspace} userId={userId} open={open} context={context} onClose={() => setOpen(false)} />
  </SidecarContextValue.Provider>;
}

const slot = { current: null as HTMLElement | null };
const listeners = new Set<() => void>();
/** The shell places the panel to the right of the routed screen by rendering <SidecarDock /> there; the provider portals into it. */
export function SidecarDock() {
  const ref = React.useCallback((node: HTMLDivElement | null) => { slot.current = node; listeners.forEach((listener) => listener()); }, []);
  return <div ref={ref} className="contents" />;
}
function useDock() {
  return React.useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => slot.current);
}


function PanelSlot(props: { workspace: Workspace; userId: string; open: boolean; context: SidecarContext | undefined; onClose: () => void }) {
  const dock = useDock();
  // Mount lazily on first open, then keep it (hidden) so the conversation survives close.
  const [everOpened, setEverOpened] = React.useState(false);
  React.useEffect(() => { if (props.open) setEverOpened(true); }, [props.open]);
  if (!dock || !everOpened) return null;
  return createPortal(<SidecarPanel key={props.workspace.id} {...props} />, dock);
}

function SidecarPanel({ workspace, userId, open, context, onClose }: { workspace: Workspace; userId: string; open: boolean; context: SidecarContext | undefined; onClose: () => void }) {
  const [width, setWidth] = React.useState(() => readWidth(userId));
  const [chat, setChat] = React.useState<Chat>(freshChat);
  const [started, setStarted] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const { data: recents = [] } = useQuery({ queryKey: chatsKey(workspace.id), queryFn: async () => await post<Recent[]>("/api/ai/chats", { workspaceId: workspace.id }) ?? [] });
  React.useEffect(() => setWidth(readWidth(userId)), [userId]);
  const save = (next: number) => { try { localStorage.setItem(widthKey(userId), String(next)); } catch { /* the width still applies until reload */ } };
  React.useEffect(() => {
    const onResize = () => setWidth((current) => clampWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && window.innerWidth < 768) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function drag(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setWidth(clampWidth(window.innerWidth - event.clientX));
  }
  function endDrag() { if (dragging) { setDragging(false); save(width); } }
  function key(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = clampWidth(width + step);
    setWidth(next);
    save(next);
  }
  async function pick(id: string) {
    const loaded = await post<{ messages: UIMessage[]; mode?: ChatMode }>("/api/ai/chats/get", { chatId: id });
    if (loaded) { setChat({ id, initial: loaded.messages, mode: loaded.mode ?? "build" }); setStarted(true); }
  }
  return <aside aria-label={translate("sidecar.title")} hidden={!open} data-sidecar-width={width} style={{ "--sidecar-w": `${width}px` } as React.CSSProperties}
    className={`relative z-40 shrink-0 flex-col border-l border-subtle bg-surface-1 max-md:fixed max-md:inset-0 max-md:w-full md:w-[var(--sidecar-w)] ${open ? "flex" : "hidden"} ${dragging ? "select-none" : ""}`}>
    <div role="separator" aria-orientation="vertical" aria-label={translate("sidecar.resize")} aria-valuemin={SIDECAR_MIN} aria-valuemax={SIDECAR_MAX} aria-valuenow={width} tabIndex={0}
      onPointerDown={startDrag} onPointerMove={drag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={key}
      className={`absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-accent-primary/30 focus-visible:bg-accent-primary/40 max-md:hidden ${dragging ? "bg-accent-primary/40" : ""}`} />
    <header className="flex shrink-0 items-center gap-1 border-b border-subtle px-3 py-2">
      <Sparkles aria-hidden size={16} className="text-secondary" />
      <h2 className="m-0 mr-auto text-14 font-medium text-primary">{translate("sidecar.title")}</h2>
      <button type="button" className={headerButton} aria-label={translate("ai.new")} title={translate("ai.new")} onClick={() => { setChat(freshChat()); setStarted(false); }}><SquarePen aria-hidden size={15} /></button>
      <Popover label={translate("sidecar.history")} align="right" trigger={<History aria-hidden size={15} />} className="p-1.5" panelClassName="max-h-72 w-64 overflow-y-auto">
        {(close) => recents.length === 0 ? <p className="m-0 px-2.5 py-1.5 text-14 text-tertiary">{translate("sidecar.noHistory")}</p>
          : recents.map((recent) => <button key={recent.id} type="button" role="menuitem" className={`${menuItemClass} truncate`} onClick={() => { close(); void pick(recent.id); }}>{recent.title}</button>)}
      </Popover>
      {started && <Link to={paths.aiChat(workspace.slug, chat.id)} onClick={onClose} className={headerButton} aria-label={translate("sidecar.openPage")} title={translate("sidecar.openPage")}><Maximize2 aria-hidden size={15} /></Link>}
      <button type="button" className={headerButton} aria-label={translate("sidecar.close")} title={translate("sidecar.close")} onClick={onClose}><X aria-hidden size={16} /></button>
    </header>
    <Conversation key={chat.id} workspace={workspace} chatId={chat.id} initial={chat.initial} initialMode={chat.mode} context={context} onSent={() => setStarted(true)} />
  </aside>;
}

const headerButton = "inline-flex size-7 items-center justify-center rounded-md border-0 bg-transparent p-0 text-secondary hover:bg-layer-transparent-hover hover:text-primary";

/** Header button for a work item or wiki page: offers that entity as the Sidecar's context while the page is shown, and opens the panel. */
export function SidecarTrigger({ context }: { context: SidecarContext }) {
  const { setContext, show } = useSidecar();
  React.useEffect(() => { setContext(context); return () => setContext(undefined); }, [context.type, context.id, context.title]);
  return <button type="button" className="secondary inline-flex items-center gap-1.5 whitespace-nowrap" onClick={show}><Sparkles aria-hidden size={14} />{translate("sidecar.open")}</button>;
}

/** Top bar button: opens or closes the Sidecar with whatever the current page offers as context. */
export function SidecarToggle() {
  const { open, toggle } = useSidecar();
  return <button type="button" aria-label={translate("sidecar.open")} title={translate("sidecar.open")} aria-expanded={open} onClick={toggle}
    className={`rounded-md border-0 p-1.5 hover:bg-layer-transparent-hover hover:text-primary ${open ? "bg-layer-1-selected text-primary" : "bg-transparent text-secondary"}`}><Sparkles aria-hidden size={18} /></button>;
}
