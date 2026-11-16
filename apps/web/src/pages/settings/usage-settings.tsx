import React from "react";
import { formatNumber, translate } from "@weft/shared";
import { action, actionResult } from "../../api";
import { useWorkspace } from "../../layouts/workspace-layout";
import { formatDuration, formatUsd, tokensOf, totalsBy, usageCsv, type UsageRow, type UsageTotal } from "../../usage-format";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type Summary = { from: string; to: string; rows: UsageRow[]; unpricedModels: Array<{ model: string; runs: number }>; totals: Omit<UsageRow, "day" | "agentId" | "agentName" | "personId" | "personName"> };
type Price = { id: string; model: string; inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion: number | null; updatedAt: string };

const monthRange = () => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
};
/** Fills `{name}` placeholders of a translated string. */
const fill = (text: string, values: Record<string, string | number>) => Object.entries(values).reduce((result, [name, value]) => result.replace(`{${name}}`, String(value)), text);
const durationText = (ms: number | null) => formatDuration(ms, (unit, values) => fill(translate(`usage.duration.${unit}`), values));
const download = (name: string, text: string) => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
};

/** Shows what one number of usage means, with plain words; an unknown value reads "Unknown", never 0. */
function Figure({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return <div className="grid gap-0.5 rounded-lg border border-subtle bg-surface-1 px-4 py-3" title={hint}>
    <span className="text-12 text-secondary">{label}</span>
    <strong className="text-18 font-semibold text-primary">{value ?? translate("usage.unknown")}</strong>
  </div>;
}

function TotalsTable({ title, totals, label }: { title: string; totals: UsageTotal[]; label: string }) {
  return <SettingsBlock title={title}>
    <div className="overflow-x-auto">
      <table className="w-full text-13">
        <thead><tr className="text-left text-secondary"><th className="whitespace-nowrap py-1 pr-3 font-medium">{label}</th><th className="whitespace-nowrap py-1 pr-3 font-medium">{translate("usage.col.runs")}</th><th className="whitespace-nowrap py-1 pr-3 font-medium">{translate("usage.col.tokens")}</th><th className="whitespace-nowrap py-1 pr-3 font-medium">{translate("usage.col.time")}</th><th className="whitespace-nowrap py-1 font-medium">{translate("usage.col.cost")}</th></tr></thead>
        <tbody>{totals.map((total) => {
          const tokens = tokensOf(total);
          return <tr key={total.key} className="border-t border-subtle">
            <td className="py-1.5 pr-3 text-primary">{total.label}</td>
            <td className="whitespace-nowrap py-1.5 pr-3">{formatNumber(total.runs)}</td>
            <td className="whitespace-nowrap py-1.5 pr-3">{tokens === null ? translate("usage.unknown") : fill(translate("usage.tokens"), { count: formatNumber(tokens) })}</td>
            <td className="whitespace-nowrap py-1.5 pr-3">{durationText(total.elapsedMs) ?? translate("usage.unknown")}</td>
            <td className="whitespace-nowrap py-1.5">{formatUsd(total.estimatedCostUsd) ?? translate("usage.unknown")}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </SettingsBlock>;
}

/** Workspace usage for Admins: totals by Agent, person and day, a CSV of every line, and the price table that turns tokens into an estimated cost. */
export function WorkspaceUsage() {
  const { workspace } = useWorkspace();
  const initial = React.useMemo(monthRange, []);
  const [from, setFrom] = React.useState(initial.from);
  const [to, setTo] = React.useState(initial.to);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const [noteFailed, setNoteFailed] = React.useState(false);
  const [prices, setPrices] = React.useState<Price[]>([]);
  const [draft, setDraft] = React.useState({ model: "", input: "", output: "", cached: "" });
  const range = from <= to;
  const load = React.useCallback(async () => {
    if (!range) return;
    const result = await actionResult<Summary>("get_usage_summary", { workspaceId: workspace.id, from, to });
    if ("error" in result) { setFailed(true); setSummary(null); return; }
    setFailed(false);
    setSummary(result.data);
  }, [workspace.id, from, to, range]);
  const loadPrices = React.useCallback(async () => {
    const rows = await action<Price[]>("list_model_prices", { workspaceId: workspace.id });
    setPrices(rows ?? []);
  }, [workspace.id]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { void loadPrices(); }, [loadPrices]);

  const rows = summary?.rows ?? [];
  const agentLabel = (row: UsageRow) => row.agentName ?? translate("usage.deletedAgent");
  const byAgent = totalsBy(rows, (row) => ({ key: row.agentId ?? "", label: agentLabel(row) }));
  const byPerson = totalsBy(rows, (row) => ({ key: row.personId, label: row.personName }));
  const byDay = totalsBy(rows, (row) => ({ key: row.day, label: row.day }));
  const totals = summary?.totals;
  const tokens = totals ? tokensOf(totals) : null;
  const duration = durationText(totals?.elapsedMs ?? null);

  const savePrice = async () => {
    const input = Number(draft.input), output = Number(draft.output);
    const result = await actionResult<Price>("set_model_price", { workspaceId: workspace.id, model: draft.model.trim(), inputUsdPerMillion: input, outputUsdPerMillion: output, cachedInputUsdPerMillion: draft.cached === "" ? null : Number(draft.cached) });
    if ("error" in result) { setNoteFailed(true); setNote(translate("usage.priceFailed")); return; }
    setNoteFailed(false); setNote(translate("usage.priceSaved"));
    setDraft({ model: "", input: "", output: "", cached: "" });
    await Promise.all([loadPrices(), load()]);
  };
  const removePrice = async (price: Price) => {
    const result = await action("delete_model_price", { workspaceId: workspace.id, priceId: price.id });
    if (result === null) { setNoteFailed(true); setNote(translate("usage.priceFailed")); return; }
    setNoteFailed(false); setNote(translate("usage.priceRemoved"));
    await Promise.all([loadPrices(), load()]);
  };

  return <section>
    <SettingsHeader title={translate("usage.title")} description={translate("usage.description")} />
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <label>{translate("usage.from")}<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>{translate("usage.to")}<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button type="button" className="secondary" disabled={!summary || rows.length === 0} onClick={() => download(`usage-${from}-${to}.csv`, usageCsv(rows, agentLabel, (row) => row.personName))}>{translate("usage.exportCsv")}</button>
    </div>
    <Note note={!range ? translate("usage.invalidRange") : failed ? translate("usage.loadFailed") : null} error />
    {totals && <>
      <div className="mb-2 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Figure label={translate("usage.col.runs")} value={formatNumber(totals.runs)} />
        <Figure label={translate("usage.col.tokens")} value={tokens === null ? null : fill(translate("usage.tokens"), { count: formatNumber(tokens) })} hint={translate("usage.cacheNote")} />
        <Figure label={translate("usage.col.time")} value={duration} />
        <Figure label={translate("usage.col.cost")} value={formatUsd(totals.estimatedCostUsd)} hint={translate("runs.costHelp")} />
      </div>
      <p className="mb-6 text-13 text-secondary">{totals.unknownUsageRuns > 0 && <>{fill(translate("usage.unknownUsageNote"), { count: totals.unknownUsageRuns })} </>}{totals.unknownCostRuns > 0 && <>{fill(translate("usage.unknownCostNote"), { count: totals.unknownCostRuns })} </>}{totals.reportedCostRuns > 0 && fill(translate("usage.reportedNote"), { count: totals.reportedCostRuns })}</p>
      {rows.length === 0 && <p className="text-13 text-secondary">{translate("usage.noRows")}</p>}
      {rows.length > 0 && <>
        <TotalsTable title={translate("usage.byAgent")} totals={byAgent} label={translate("usage.col.agent")} />
        <TotalsTable title={translate("usage.byPerson")} totals={byPerson} label={translate("usage.col.person")} />
        <TotalsTable title={translate("usage.byDay")} totals={byDay} label={translate("usage.col.day")} />
      </>}
    </>}
    <SettingsBlock title={translate("usage.prices")} description={translate("usage.pricesDesc")}>
      {prices.length === 0 ? <p className="text-13 text-secondary">{translate("usage.pricesEmpty")}</p> : <RowList>
        {prices.map((price) => <Row key={price.id}>
          <span className="min-w-40 flex-1 font-medium text-primary">{price.model}</span>
          <span className="text-13 text-secondary">{formatUsd(price.inputUsdPerMillion)} / {formatUsd(price.outputUsdPerMillion)}{price.cachedInputUsdPerMillion !== null && ` · ${fill(translate("usage.priceCachedShown"), { price: formatUsd(price.cachedInputUsdPerMillion) ?? "" })}`}</span>
          <button type="button" className="secondary" onClick={() => setDraft({ model: price.model, input: String(price.inputUsdPerMillion), output: String(price.outputUsdPerMillion), cached: price.cachedInputUsdPerMillion === null ? "" : String(price.cachedInputUsdPerMillion) })}>{translate("agents.edit")}</button>
          <button type="button" className="secondary" onClick={() => void removePrice(price)}>{translate("usage.priceRemove")}</button>
        </Row>)}
      </RowList>}
      <div className="grid gap-3 md:grid-cols-4">
        <label>{translate("usage.priceModel")}<input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
        <label>{translate("usage.priceInput")}<input type="number" min={0} step="0.0001" value={draft.input} onChange={(event) => setDraft({ ...draft, input: event.target.value })} /></label>
        <label>{translate("usage.priceOutput")}<input type="number" min={0} step="0.0001" value={draft.output} onChange={(event) => setDraft({ ...draft, output: event.target.value })} /></label>
        <label title={translate("usage.priceCachedHint")}>{translate("usage.priceCached")}<input type="number" min={0} step="0.0001" value={draft.cached} onChange={(event) => setDraft({ ...draft, cached: event.target.value })} /></label>
      </div>
      <button type="button" className="w-fit" disabled={!draft.model.trim() || draft.input === "" || draft.output === ""} onClick={() => void savePrice()}>{translate("usage.priceSave")}</button>
      <Note note={note} error={noteFailed} />
    </SettingsBlock>
    {(summary?.unpricedModels.length ?? 0) > 0 && <SettingsBlock title={translate("usage.unpricedTitle")} description={translate("usage.unpricedDesc")}>
      <ul data-testid="unpriced-models" className="m-0 grid list-none gap-1 !pl-0 text-13">{summary!.unpricedModels.map((entry) => <li key={entry.model}>{entry.model === "__model_not_reported__" ? fill(translate("usage.modelNotReported"), { count: entry.runs }) : fill(translate("usage.unpricedRow"), { model: entry.model, count: entry.runs })}</li>)}</ul>
    </SettingsBlock>}
  </section>;
}
