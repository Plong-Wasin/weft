import React from "react";
import { translate } from "@weft/shared";
import { Conversation, type SidecarContext } from "./ai-chat";

/** The Sidecar: the AI chat as a side panel. Only the entity id and title are passed; the AI reads the content through Read actions. Chats use the same store as the AI chat page, so they appear in its recents. */
export function Sidecar({ workspace, context }: { workspace: { id: string; slug: string }; context: SidecarContext }) {
  const [open, setOpen] = React.useState(false);
  const [chatId, setChatId] = React.useState(() => crypto.randomUUID());
  const [started, setStarted] = React.useState(false);
  return <>
    <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{translate("sidecar.open")}</button>
    {open && <aside aria-label={translate("sidecar.title")} style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "24rem", maxWidth: "100vw", overflow: "auto", padding: "1rem", background: "Canvas", color: "CanvasText", borderLeft: "1px solid currentColor", zIndex: 10 }}>
      <h2>{translate("sidecar.title")}</h2>
      <p><small>{context.id} · {context.title}</small></p>
      <button type="button" className="secondary" onClick={() => setOpen(false)}>{translate("sidecar.close")}</button>
      {started && <> <button type="button" className="secondary" onClick={() => { setChatId(crypto.randomUUID()); setStarted(false); }}>{translate("ai.new")}</button> <a href={`/${workspace.slug}/ai/${chatId}`}>{translate("sidecar.openPage")}</a></>}
      <Conversation key={chatId} workspace={workspace} chatId={chatId} initial={[]} context={context} onSent={() => setStarted(true)} />
    </aside>}
  </>;
}
