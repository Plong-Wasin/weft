import React from "react";
import { translate, type MessageKey } from "@weft/shared";
import { action, actionResult } from "../../api";
import { useProject } from "../../layouts/project-layout";
import { categoryStarter, estimateLimits, estimateTemplateKeys, estimateTemplates, type EstimateTemplate } from "../../estimate-templates";
import type { Estimate } from "../../types";
import { SortableList } from "../../sortable-list";
import { dangerButton, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type Draft = { id?: string; value: string };

/** Role null means a workspace Admin who is no project member; the server decides. */
const canAdminOf = (role: string | null) => role === "Admin" || role === null;

/** The editable ordered list of values (2 to 6): rename, move, add, remove. */
function ValueList({ values, onChange, disabled, numeric }: { values: Draft[]; onChange: (values: Draft[]) => void; disabled: boolean; numeric: boolean }) {
  // A row keeps its key while it is edited or moved, so the focus follows the row it was on.
  const keys = React.useRef(new WeakMap<Draft, string>());
  const counter = React.useRef(0);
  const keyOf = (entry: Draft) => { let key = keys.current.get(entry); if (!key) { key = `row-${counter.current++}`; keys.current.set(entry, key); } return key; };
  const ids = values.map(keyOf);
  const set = (index: number, value: string) => {
    const next = { ...values[index]!, value };
    keys.current.set(next, ids[index]!);
    onChange(values.map((entry, at) => at === index ? next : entry));
  };
  return <div className="grid gap-2">
    <SortableList ids={ids} disabled={disabled} label={(id) => values[ids.indexOf(id)]?.value || `${translate("estimates.value")} ${ids.indexOf(id) + 1}`}
      onReorder={(order) => onChange(order.map((id) => values[ids.indexOf(id)]!))}
      renderRow={(id, grip) => {
        const index = ids.indexOf(id);
        const entry = values[index]!;
        return <>
          {!disabled && grip}
          <input className="min-w-0 flex-1" required inputMode={numeric ? "decimal" : "text"} maxLength={20} disabled={disabled} aria-label={`${translate("estimates.value")} ${index + 1}`} value={entry.value} onChange={(event) => set(index, event.target.value)} />
          {!disabled && <button type="button" className="secondary hover:!text-danger-text" disabled={values.length <= estimateLimits.min} onClick={() => onChange(values.filter((_, at) => at !== index))}>{translate("estimates.removeValue")}</button>}
        </>;
      }} />
    {!disabled && <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="secondary" disabled={values.length >= estimateLimits.max} onClick={() => onChange([...values, { value: "" }])}>{translate("estimates.addValue")}</button>
      <span className="text-13 text-secondary">{translate("estimates.rangeHint")}</span>
    </div>}
  </div>;
}

export function ProjectEstimates() {
  const { project } = useProject();
  const canAdmin = canAdminOf(project.role);
  const [estimate, setEstimate] = React.useState<Estimate | null | undefined>(undefined);
  const [note, setNote] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [values, setValues] = React.useState<Draft[]>([]);
  const [type, setType] = React.useState<"points" | "categories">("points");
  const [template, setTemplate] = React.useState<EstimateTemplate>("fibonacci");

  const adopt = (loaded: Estimate | null) => {
    setEstimate(loaded);
    if (loaded) { setName(loaded.name); setValues(loaded.points.map((point) => ({ id: point.id, value: point.value }))); }
  };
  const load = React.useCallback(async () => adopt(await action<Estimate | null>("get_estimate", { projectId: project.id })), [project.id]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { if (estimate === null) setValues((type === "points" ? estimateTemplates[template] : categoryStarter).map((value) => ({ value }))); }, [estimate, type, template]);

  const send = async (name_: string, body: Record<string, unknown>) => {
    const result = await actionResult<Estimate>(name_, { projectId: project.id, ...body });
    if ("error" in result) { setNote(`${translate("estimates.failed")} ${result.error}`); return false; }
    setNote(null);
    adopt(result.data);
    return true;
  };

  if (estimate === undefined) return null;
  const header = <SettingsHeader title={translate("estimates.title")} description={translate("settings.estimatesDesc")} />;

  if (estimate === null) {
    if (!canAdmin) return <section>{header}<p className="text-14 text-secondary">{translate("estimates.none")}</p></section>;
    return <section>
      {header}
      <form className="grid gap-4" onSubmit={async (event) => { event.preventDefault(); await send("create_estimate", { name: name.trim() || undefined, type, values: values.map((entry) => entry.value) }); }}>
        <SettingsBlock title={translate("estimates.create")} description={translate("estimates.createDesc")}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-[200px] flex-1">{translate("estimates.name")}<input maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>{translate("estimates.type")}<select value={type} onChange={(event) => setType(event.target.value as "points" | "categories")}>
              <option value="points">{translate("estimates.type.points")}</option>
              <option value="categories">{translate("estimates.type.categories")}</option>
            </select></label>
            {type === "points" && <label>{translate("estimates.template")}<select value={template} onChange={(event) => setTemplate(event.target.value as EstimateTemplate)}>
              {estimateTemplateKeys.map((key) => <option key={key} value={key}>{translate(`estimates.template.${key}` as MessageKey)}</option>)}
            </select></label>}
          </div>
          <ValueList values={values} onChange={setValues} disabled={false} numeric={type === "points"} />
        </SettingsBlock>
        <div><button>{translate("estimates.createButton")}</button></div>
      </form>
      <Note note={note} error />
    </section>;
  }

  /** Switching or deleting clears every Estimate point: ask first, naming how many work items are affected. */
  const clearing = async (key: "estimates.switchConfirm" | "estimates.deleteConfirm", run: () => Promise<boolean>, to?: string) => {
    const usage = await actionResult<{ workItems: number }>("get_estimate_usage", { projectId: project.id });
    if ("error" in usage) { setNote(`${translate("estimates.failed")} ${usage.error}`); return; }
    if (!window.confirm(translate(key).replace("{count}", String(usage.data.workItems)).replace("{type}", to ?? ""))) return;
    await run();
  };
  const other = estimate.type === "points" ? "categories" : "points";
  const readOnly = !canAdmin || !estimate.enabled;
  return <section>
    {header}
    <SettingsBlock>
      <Row>
        <span className="grid flex-1"><span className="font-medium">{translate("estimates.enabled")}</span><span className="text-13 text-secondary">{translate("estimates.enabledDesc")}</span></span>
        <label className="flex-row items-center gap-2"><input type="checkbox" role="switch" disabled={!canAdmin} checked={estimate.enabled} aria-label={translate("estimates.enabled")} onChange={(event) => void send("update_estimate", { enabled: event.target.checked })} /></label>
      </Row>
    </SettingsBlock>
    {!estimate.enabled && <p className="mb-3 text-13 text-secondary">{translate("estimates.offHint")}</p>}
    <form className="grid gap-4" onSubmit={async (event) => { event.preventDefault(); await send("update_estimate", { name: name.trim() || undefined, points: values.map((entry) => ({ ...(entry.id ? { id: entry.id } : {}), value: entry.value })) }); }}>
      <SettingsBlock title={translate(`estimates.type.${estimate.type}` as MessageKey)}>
        <label className="max-w-[420px]">{translate("estimates.name")}<input required maxLength={100} disabled={readOnly} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <ValueList values={values} onChange={setValues} disabled={readOnly} numeric={estimate.type === "points"} />
      </SettingsBlock>
      {!readOnly && <div><button>{translate("labels.save")}</button></div>}
    </form>
    {canAdmin && <SettingsBlock title={translate("estimates.danger")} description={translate("estimates.dangerDesc")}>
      <div className="flex flex-wrap gap-3">
        {estimate.enabled && <button type="button" className="secondary" onClick={() => void clearing("estimates.switchConfirm", () => send("switch_estimate_type", { type: other, values: other === "points" ? estimateTemplates.fibonacci : categoryStarter }), translate(`estimates.type.${other}` as MessageKey))}>{translate(`estimates.switchTo.${other}` as MessageKey)}</button>}
        <button type="button" className={dangerButton} onClick={() => void clearing("estimates.deleteConfirm", async () => {
          const result = await actionResult("delete_estimate", { projectId: project.id });
          if ("error" in result) { setNote(`${translate("estimates.failed")} ${result.error}`); return false; }
          setNote(null); adopt(null); setEstimate(null);
          return true;
        })}>{translate("estimates.delete")}</button>
      </div>
    </SettingsBlock>}
    <Note note={note} error />
  </section>;
}
