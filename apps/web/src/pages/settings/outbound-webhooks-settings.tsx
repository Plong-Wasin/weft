import React from "react";
import { formatDate, translate, type MessageKey } from "@weft/shared";
import { action, actionResult } from "../../api";
import { copyText } from "../../toast";
import { useWorkspace } from "../../layouts/workspace-layout";
import { Navigate } from "react-router";
import { useOutboundWebhooksEnabled } from "../../outbound-webhooks-flag";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type Webhook = { id: string; name: string; displayUrl: string; disabledReason: string | null; events: string[]; enabled: boolean; includePrivateProjects: boolean; createdAt: string };
type Delivery = {
  id: string; eventId: string; eventType: string; status: string; attempts: number; responseStatus: number | null; responseExcerpt: string | null;
  lastError: string | null; createdAt: string; lastAttemptAt: string | null; nextAttemptAt: string | null; deliveredAt: string | null;
};
type Created = Webhook & { secret: string };

/** A format example for the address input, not user-facing text, so it is not translated. */
const urlExample = ["https", "://"].join("");
const eventTypes = ["work_item.created", "work_item.updated", "comment.created", "run.finished"] as const;
type EventType = (typeof eventTypes)[number];

const when = (value: string | null) => (value ? formatDate(value) : "–");
/** The label of an event type; the test event has its own label, and an unknown type is shown as it is. */
const eventLabel = (type: string) => (eventTypes.includes(type as EventType) || type === "webhook.test" ? translate(`outboundWebhooks.event.${type}` as MessageKey) : type);

/** The answer column: the receiver's status code, or the reason the send failed in plain words. */
function answerOf(delivery: Delivery) {
  if (delivery.responseStatus !== null) return `${delivery.responseStatus}`;
  return delivery.lastError ?? "–";
}

/** Events, enable switch, test, secret and the delivery log of one webhook. */
function WebhookBlock({ webhook, secret, onSecret, onChanged, say }: {
  webhook: Webhook; secret: string | null; onSecret: (value: string | null) => void; onChanged: () => Promise<void>; say: (message: string | null, error?: boolean) => void;
}) {
  const [deliveries, setDeliveries] = React.useState<Delivery[] | null>(null);
  const [redelivering, setRedelivering] = React.useState<Set<string>>(new Set());
  const [fullUrl, setFullUrl] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    setDeliveries(await action<Delivery[]>("list_outbound_webhook_deliveries", { webhookId: webhook.id, limit: 20 }) ?? []);
  }, [webhook.id]);
  React.useEffect(() => { void load(); }, [load]);

  return <SettingsBlock title={webhook.name} description={webhook.displayUrl}>
    {webhook.disabledReason === "failures" && <div role="status" className="grid gap-2 rounded-lg border border-subtle p-3">
      <p className="m-0 text-13 text-primary">{translate("outboundWebhooks.disabledByFailures")}</p>
      <button type="button" className="secondary w-fit" onClick={async () => {
        const result = await action("update_outbound_webhook", { webhookId: webhook.id, enabled: true });
        say(result === null ? translate("outboundWebhooks.failed") : translate("outboundWebhooks.saved"), result === null);
        await onChanged();
      }}>{translate("outboundWebhooks.reEnable")}</button>
    </div>}
    <label className="flex items-center gap-2"><input type="checkbox" checked={webhook.enabled} onChange={async (event) => {
      const result = await action("update_outbound_webhook", { webhookId: webhook.id, enabled: event.target.checked });
      say(result === null ? translate("outboundWebhooks.failed") : translate("outboundWebhooks.saved"), result === null);
      await onChanged();
    }} />{translate("outboundWebhooks.enabled")}</label>
    <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.enabledHelp")}</p>
    <label className="flex items-center gap-2"><input type="checkbox" checked={webhook.includePrivateProjects} onChange={async (event) => {
      const result = await action("update_outbound_webhook", { webhookId: webhook.id, includePrivateProjects: event.target.checked });
      say(result === null ? translate("outboundWebhooks.failed") : translate("outboundWebhooks.saved"), result === null);
      await onChanged();
    }} />{translate("outboundWebhooks.includePrivate")}</label>
    <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.includePrivateHelp")}</p>
    <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.sends")} {webhook.events.map(eventLabel).join(" · ")}</p>
    <button type="button" className="secondary w-fit" onClick={async () => {
      if (fullUrl !== null) { setFullUrl(null); return; }
      const result = await action<{ url: string }>("get_outbound_webhook_url", { webhookId: webhook.id });
      if (!result) { say(translate("outboundWebhooks.failed"), true); return; }
      setFullUrl(result.url);
    }}>{fullUrl === null ? translate("outboundWebhooks.revealUrl") : translate("outboundWebhooks.hideUrl")}</button>
    {fullUrl !== null && <p className="m-0 break-all text-13 text-secondary">{fullUrl}</p>}

    {secret && <div className="grid gap-2 rounded-lg border border-subtle p-3">
      <span className="text-14 font-medium">{translate("outboundWebhooks.secretTitle")}</span>
      <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.secretOnce")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input readOnly value={secret} aria-label={translate("outboundWebhooks.secretTitle")} onFocus={(event) => event.target.select()} className="min-w-0 flex-1 bg-layer-1" />
        <button type="button" className="secondary" onClick={async () => { if (await copyText(secret, translate("outboundWebhooks.copySecret"), translate("comments.copyFailed"))) say(translate("outboundWebhooks.copySecret")); }}>{translate("outboundWebhooks.copySecret")}</button>
      </div>
    </div>}

    <div className="flex flex-wrap items-start gap-3">
      <div className="grid gap-1">
        <button type="button" className="secondary w-fit" onClick={async () => {
          const result = await actionResult<{ status: string; message: string }>("test_outbound_webhook", { webhookId: webhook.id });
          if ("error" in result) { say(translate("outboundWebhooks.failed"), true); return; }
          say(result.data.message, result.data.status !== "succeeded");
          await load();
        }}>{translate("outboundWebhooks.test")}</button>
        <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.testHelp")}</p>
      </div>
      <button type="button" className="secondary w-fit" onClick={async () => {
        if (!window.confirm(translate("outboundWebhooks.rotateConfirm"))) return;
        const result = await action<{ secret: string }>("rotate_outbound_webhook_secret", { webhookId: webhook.id });
        if (!result) { say(translate("outboundWebhooks.failed"), true); return; }
        onSecret(result.secret);
        say(null);
      }}>{translate("outboundWebhooks.rotate")}</button>
      <button type="button" className="secondary w-fit" onClick={async () => {
        if (!window.confirm(translate("outboundWebhooks.deleteConfirm"))) return;
        const result = await action("delete_outbound_webhook", { webhookId: webhook.id });
        if (!result) { say(translate("outboundWebhooks.failed"), true); return; }
        say(translate("outboundWebhooks.deleted"));
        await onChanged();
      }}>{translate("outboundWebhooks.delete")}</button>
    </div>

    <div className="grid min-w-0 gap-2">
      <h3 className="m-0 text-14 font-medium text-primary">{translate("outboundWebhooks.log")}</h3>
      <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.logHelp")}</p>
      {deliveries === null ? null : deliveries.length === 0
        ? <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.logEmpty")}</p>
        : <div className="relative w-0 min-w-full overflow-x-auto">
          <table className="w-full min-w-[560px] text-13">
            <thead><tr className="text-left text-secondary">
              <th scope="col">{translate("outboundWebhooks.col.when")}</th>
              <th scope="col">{translate("outboundWebhooks.col.event")}</th>
              <th scope="col">{translate("outboundWebhooks.col.status")}</th>
              <th scope="col">{translate("outboundWebhooks.col.answer")}</th>
              <th scope="col">{translate("outboundWebhooks.col.tries")}</th>
              <th scope="col"><span className="sr-only">{translate("outboundWebhooks.redeliver")}</span></th>
            </tr></thead>
            <tbody>{deliveries.map((delivery) => <tr key={delivery.id}>
              <td>{when(delivery.lastAttemptAt ?? delivery.createdAt)}</td>
              <td>{eventLabel(delivery.eventType)}</td>
              <td>{translate(`outboundWebhooks.status.${delivery.status}` as MessageKey)}</td>
              <td className="break-words">{answerOf(delivery)}</td>
              <td>{delivery.attempts}</td>
              <td><button type="button" className="secondary" disabled={delivery.status === "retrying" || redelivering.has(delivery.id)} title={delivery.status === "retrying" ? translate("outboundWebhooks.stillRetrying") : undefined} aria-label={`${translate("outboundWebhooks.redeliver")}: ${eventLabel(delivery.eventType)}`} onClick={async () => {
                if (redelivering.has(delivery.id)) return;
                setRedelivering((current) => new Set(current).add(delivery.id));
                const result = await action("redeliver_outbound_webhook_delivery", { deliveryId: delivery.id });
                say(result === null ? translate("outboundWebhooks.failed") : translate("outboundWebhooks.saved"), result === null);
                await load();
                setRedelivering((current) => { const next = new Set(current); next.delete(delivery.id); return next; });
              }}>{translate("outboundWebhooks.redeliver")}</button></td>
            </tr>)}</tbody>
          </table>
        </div>}
    </div>
  </SettingsBlock>;
}

/** Form to add a webhook: name, https address and the events it receives. The secret is shown by the caller after creation. */
function AddWebhook({ workspaceId, onCreated, say }: { workspaceId: string; onCreated: (created: Created) => void; say: (message: string | null, error?: boolean) => void }) {
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState<EventType[]>(["work_item.created"]);
  const [includePrivate, setIncludePrivate] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const toggle = (event: EventType) => setEvents((current) => current.includes(event) ? current.filter((value) => value !== event) : [...current, event]);

  return <SettingsBlock title={translate("outboundWebhooks.addTitle")}>
    <form className="grid max-w-[560px] gap-3" onSubmit={async (event) => {
      event.preventDefault();
      if (!name.trim()) { say(translate("outboundWebhooks.needName"), true); return; }
      if (!url.trim()) { say(translate("outboundWebhooks.needUrl"), true); return; }
      if (events.length === 0) { say(translate("outboundWebhooks.needEvent"), true); return; }
      setBusy(true);
      const result = await actionResult<Created>("create_outbound_webhook", { workspaceId, name: name.trim(), url: url.trim(), events, includePrivateProjects: includePrivate });
      setBusy(false);
      if ("error" in result) { say(result.error, true); return; }
      setName(""); setUrl("");
      onCreated(result.data);
      say(translate("outboundWebhooks.created"));
    }}>
      <label className="grid gap-1 text-13 text-secondary">{translate("outboundWebhooks.name")}
        <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
      </label>
      <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.nameHelp")}</p>
      <label className="grid gap-1 text-13 text-secondary">{translate("outboundWebhooks.url")}
        <input type="url" value={url} placeholder={urlExample} onChange={(event) => setUrl(event.target.value)} />
      </label>
      <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.urlHelp")}</p>
      <fieldset className="grid gap-2 border-0 p-0">
        <legend className="mb-1 text-13 text-secondary">{translate("outboundWebhooks.events")}</legend>
        {eventTypes.map((type) => <label key={type} className="flex items-center gap-2 text-14">
          <input type="checkbox" checked={events.includes(type)} onChange={() => toggle(type)} />{translate(`outboundWebhooks.event.${type}` as MessageKey)}
        </label>)}
        <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.eventsHelp")}</p>
      </fieldset>
      <label className="flex items-center gap-2 text-14">
        <input type="checkbox" checked={includePrivate} onChange={(event) => setIncludePrivate(event.target.checked)} />{translate("outboundWebhooks.includePrivate")}
      </label>
      <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.includePrivateHelp")}</p>
      <button type="submit" className="primary w-fit" disabled={busy}>{translate("outboundWebhooks.create")}</button>
    </form>
  </SettingsBlock>;
}

/** Workspace Admin page for outbound webhooks. Nothing is sent until a webhook is created and turned on. */
export function WorkspaceOutboundWebhooks() {
  const { workspace } = useWorkspace();
  const [rows, setRows] = React.useState<Webhook[] | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [secrets, setSecrets] = React.useState<Partial<Record<string, string>>>({});
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const say = (message: string | null, error = false) => { setNote(message); setFailed(error); };
  const load = React.useCallback(async () => {
    setRows(await action<Webhook[]>("list_outbound_webhooks", { workspaceId: workspace.id }));
    setLoaded(true);
  }, [workspace.id]);
  React.useEffect(() => { void load(); }, [load]);

  if (loaded && rows === null) return <section>
    <SettingsHeader title={translate("outboundWebhooks.title")} description={translate("outboundWebhooks.desc")} />
    <p role="status" className="text-secondary">{translate("settings.adminOnly")}</p>
  </section>;

  return <section>
    <SettingsHeader title={translate("outboundWebhooks.title")} description={translate("outboundWebhooks.desc")} />
    <SettingsBlock>
      <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.scope")}</p>
      <p className="m-0 text-13 text-secondary">{translate("outboundWebhooks.howItWorks")}</p>
    </SettingsBlock>
    {rows !== null && rows.length === 0 && <SettingsBlock><RowList><Row><span className="flex-1 text-secondary">{translate("outboundWebhooks.none")}</span></Row></RowList></SettingsBlock>}
    {rows?.map((webhook) => <WebhookBlock key={webhook.id} webhook={webhook} secret={secrets[webhook.id] ?? null}
      onSecret={(value) => setSecrets((current) => ({ ...current, [webhook.id]: value ?? undefined }))} say={say} onChanged={load} />)}
    <AddWebhook workspaceId={workspace.id} say={say} onCreated={(created) => {
      setSecrets((current) => ({ ...current, [created.id]: created.secret }));
      void load();
    }} />
    <Note note={note} error={failed} />
  </section>;
}

/** The route is reachable only while WEFT_OUTBOUND_WEBHOOKS_ENABLED is on; otherwise it sends the visitor to General settings. */
export function OutboundWebhooksRoute() {
  const enabled = useOutboundWebhooksEnabled();
  return enabled ? <WorkspaceOutboundWebhooks /> : <Navigate to="../" replace />;
}
