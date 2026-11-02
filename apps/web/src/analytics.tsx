import React from "react";
import { NavLink } from "react-router";
import { ChartColumn, Check, ChevronDown } from "lucide-react";
import { formatNumber, getLocale, translate, type MessageKey } from "@weft/shared";
import { Popover } from "./shell/popover";
import { paths } from "./routes";
import type { Project } from "./types";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Run = <T>(name: string, body: unknown) => Promise<{ data: T } | { error: string }>;
const t = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), translate(key as MessageKey));

export const axes = ["state", "stateGroup", "priority", "label", "assignee", "cycle", "module", "createdDate", "dueDate", "startDate", "completedDate", "estimatePoint"] as const;
export type Axis = (typeof axes)[number];
type Summary = { total: number; open: number; completed: number; overdue: number };
type Bucket = { key: string | null; label: string | null; count: number };
type OverviewProject = { id: string; key: string; name: string; archived: boolean; total: number; open: number; completed: number };
type Overview = { summary: Summary; projects: OverviewProject[] };
type Month = { month: string; created: number; resolved: number };
type Insights = { x: Axis; groupBy: Axis | null; buckets: Array<Bucket & { groups: Bucket[] }> };

const selectClass = "min-w-0 max-w-full rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-14 text-primary";
const palette = ["#3f76ff", "#f59e0b", "#16a34a", "#e11d48", "#8b5cf6", "#0ea5e9", "#f97316", "#14b8a6", "#a3a3a3", "#d946ef"];
const colorOf = (index: number) => palette[index % palette.length]!;

/** The text of a bucket: enums and months are formatted here, names come from the data, and a null key is "none". */
export function bucketLabel(axis: Axis, bucket: Bucket): string {
  if (bucket.key === null) return t("analytics.none");
  if (axis === "priority") return t(`workItems.priority.${bucket.key}`);
  if (axis === "stateGroup") return t(`states.group.${bucket.key}`);
  if (axis.endsWith("Date")) return new Intl.DateTimeFormat(getLocale() === "th" ? "th-TH" : "en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${bucket.key}-01T00:00:00Z`));
  return bucket.label ?? bucket.key;
}

function SummaryCards({ summary }: { summary: Summary }) {
  const cards: Array<[string, number]> = [["analytics.total", summary.total], ["analytics.open", summary.open], ["analytics.completed", summary.completed], ["analytics.overdue", summary.overdue]];
  return <ul className="m-0 grid list-none grid-cols-4 gap-3 p-0 max-md:grid-cols-2">
    {cards.map(([label, value]) => <li key={label} className="rounded-lg border border-subtle bg-surface-1 p-3">
      <p className="m-0 text-12 text-secondary">{t(label)}</p><p className="m-0 mt-1 text-20 font-semibold text-primary">{formatNumber(value)}</p>
    </li>)}
  </ul>;
}

function ProjectFilter({ projects, selected, onChange }: { projects: Project[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = React.useState("");
  const shown = projects.filter((project) => `${project.key} ${project.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return <Popover label={t("analytics.projects")} panelRole="dialog" panelClassName="w-72 max-w-[85vw]" className="border border-subtle px-2.5 py-1.5 text-14"
    trigger={<><span className="truncate">{selected.length === 0 ? t("analytics.allProjects") : t("analytics.projectsSelected", { count: selected.length })}</span><ChevronDown aria-hidden size={14} /></>}>
    {() => <div className="grid gap-1">
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("analytics.searchProjects")} aria-label={t("analytics.searchProjects")} className="rounded-md border border-subtle px-2 py-1 text-14" />
      <ul className="m-0 grid max-h-64 list-none gap-0.5 overflow-y-auto p-0">
        {shown.map((project) => <li key={project.id}><label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-14 hover:bg-layer-transparent-hover">
          <input type="checkbox" checked={selected.includes(project.id)} onChange={() => toggle(project.id)} />
          <span className="rounded-md bg-layer-1 px-1.5 text-12 text-secondary">{project.key}</span><span className="truncate">{project.name}</span>
          {selected.includes(project.id) && <Check aria-hidden size={12} className="ml-auto shrink-0" />}
        </label></li>)}
      </ul>
      {selected.length > 0 && <button type="button" onClick={() => onChange([])} className="text-left text-13">{t("analytics.clearProjects")}</button>}
    </div>}
  </Popover>;
}

/** Horizontal bars, one per X value; with a Group-by each bar is split into coloured segments with a shared legend. Plain HTML, so it shrinks to 390px. */
function Chart({ insights }: { insights: Insights }) {
  const max = Math.max(1, ...insights.buckets.map((bucket) => bucket.count));
  const groupKeys: Array<Bucket> = [];
  for (const bucket of insights.buckets) for (const group of bucket.groups) if (!groupKeys.some((known) => known.key === group.key)) groupKeys.push(group);
  const groupIndex = (key: string | null) => groupKeys.findIndex((known) => known.key === key);
  return <figure className="m-0 grid gap-3" aria-label={t("analytics.chart", { axis: t(`analytics.axis.${insights.x}`) })}>
    {insights.groupBy && <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-12 text-secondary">
      {groupKeys.map((group, index) => <li key={group.key ?? "none"} className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm" style={{ background: colorOf(index) }} />{bucketLabel(insights.groupBy!, group)}</li>)}
    </ul>}
    <ul className="m-0 grid list-none gap-2 p-0">
      {insights.buckets.map((bucket) => <li key={bucket.key ?? "none"} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-13 max-md:grid-cols-[minmax(0,6rem)_minmax(0,1fr)_auto]">
        <span className="truncate text-secondary" title={bucketLabel(insights.x, bucket)}>{bucketLabel(insights.x, bucket)}</span>
        <span className="flex h-5 overflow-hidden rounded-sm bg-layer-1" role="img" aria-label={`${bucketLabel(insights.x, bucket)}: ${bucket.count}`}>
          {insights.groupBy
            ? bucket.groups.map((group) => <span key={group.key ?? "none"} title={`${bucketLabel(insights.groupBy!, group)}: ${group.count}`} style={{ width: `${(group.count / max) * 100}%`, background: colorOf(groupIndex(group.key)) }} />)
            : <span style={{ width: `${(bucket.count / max) * 100}%`, background: colorOf(0) }} />}
        </span>
        <span className="tabular-nums text-primary">{formatNumber(bucket.count)}</span>
      </li>)}
    </ul>
  </figure>;
}

const monthText = (month: string) => new Intl.DateTimeFormat(getLocale() === "th" ? "th-TH" : "en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

/** Created vs Resolved by month: two bars per month row on a shared scale. Plain HTML, so it shrinks to 390px. */
function CreatedVsResolved({ months }: { months: Month[] }) {
  const max = Math.max(1, ...months.flatMap((row) => [row.created, row.resolved]));
  const series: Array<[keyof Omit<Month, "month">, string, string]> = [["created", "analytics.created", colorOf(0)], ["resolved", "analytics.resolved", colorOf(2)]];
  return <figure className="m-0 grid gap-3" aria-label={t("analytics.createdVsResolved")}>
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-12 text-secondary">
      {series.map(([key, label, color]) => <li key={key} className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm" style={{ background: color }} />{t(label)}</li>)}
    </ul>
    <ul className="m-0 grid list-none gap-2.5 p-0">
      {months.map((row) => <li key={row.month} className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] items-center gap-3 text-13 max-md:grid-cols-[minmax(0,4.5rem)_minmax(0,1fr)]">
        <span className="truncate text-secondary">{monthText(row.month)}</span>
        <span className="grid gap-1">
          {series.map(([key, label, color]) => <span key={key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <span className="flex h-3.5 overflow-hidden rounded-sm bg-layer-1" role="img" aria-label={`${monthText(row.month)}, ${t(label)}: ${row[key]}`}><span style={{ width: `${(row[key] / max) * 100}%`, background: color }} /></span>
            <span className="tabular-nums text-primary">{formatNumber(row[key])}</span>
          </span>)}
        </span>
      </li>)}
    </ul>
  </figure>;
}

function Tabs({ workspaceSlug, active }: { workspaceSlug: string; active: "overview" | "workItems" }) {
  const tab = (isActive: boolean) => `border-b-2 px-3 py-1.5 text-14 font-medium no-underline ${isActive ? "border-accent-primary text-primary" : "border-transparent text-secondary"}`;
  return <div role="tablist" className="flex gap-1 border-b border-subtle">
    <NavLink to={paths.analyticsOverview(workspaceSlug)} role="tab" aria-selected={active === "overview"} className={tab(active === "overview")}>{t("analytics.tabOverview")}</NavLink>
    <NavLink to={paths.analyticsWorkItems(workspaceSlug)} role="tab" aria-selected={active === "workItems"} className={tab(active === "workItems")}>{t("analytics.tabWorkItems")}</NavLink>
  </div>;
}

/** Workspace Analytics, Overview tab: summary cards and the caller's projects with their counts. */
export function AnalyticsOverviewPage({ workspaceId, workspaceSlug, run }: { workspaceId: string; workspaceSlug: string; run: Run }) {
  const [state, setState] = React.useState<Overview | "forbidden" | "failed" | null>(null);
  React.useEffect(() => {
    let current = true;
    void run<Overview>("get_analytics_overview", { workspaceId }).then((result) => {
      if (!current) return;
      if ("error" in result) setState(result.error === "Forbidden" ? "forbidden" : "failed"); else setState(result.data);
    });
    return () => { current = false; };
  }, [run, workspaceId]);
  return <section className="grid min-w-0 gap-4 p-4">
    <h2 className="m-0 flex items-center gap-2 text-18 font-semibold"><ChartColumn aria-hidden size={18} />{t("analytics.title")}</h2>
    <Tabs workspaceSlug={workspaceSlug} active="overview" />
    {state === "forbidden" && <p role="alert" className="m-0 text-secondary">{t("analytics.forbidden")}</p>}
    {state === "failed" && <p role="alert" className="m-0 text-danger-text">{t("analytics.failed")}</p>}
    {typeof state === "object" && state !== null && <>
      <SummaryCards summary={state.summary} />
      {state.projects.length === 0 ? <p className="m-0 text-secondary">{t("analytics.noProjects")}</p> : <div className="grid min-w-0 gap-3 rounded-lg border border-subtle p-3">
        <h3 className="m-0 text-16 font-semibold">{t("analytics.projectList")}</h3>
        <ul className="m-0 grid list-none gap-1 p-0">
          <li aria-hidden className="grid grid-cols-[minmax(0,1fr)_4rem_4rem_5rem] gap-3 text-12 text-secondary max-md:grid-cols-[minmax(0,1fr)_3rem_3rem_3.5rem]"><span>{t("analytics.projects")}</span><span className="text-right">{t("analytics.total")}</span><span className="text-right">{t("analytics.open")}</span><span className="text-right">{t("analytics.completed")}</span></li>
          {state.projects.map((project) => <li key={project.id} className="grid grid-cols-[minmax(0,1fr)_4rem_4rem_5rem] items-center gap-3 border-t border-subtle pt-1 text-14 max-md:grid-cols-[minmax(0,1fr)_3rem_3rem_3.5rem]">
            <span className="flex min-w-0 items-center gap-2"><span className="shrink-0 rounded-md bg-layer-1 px-1.5 text-12 text-secondary">{project.key}</span><span className="truncate" title={project.name}>{project.name}</span></span>
            <span className="text-right tabular-nums" aria-label={`${t("analytics.total")}: ${project.total}`}>{formatNumber(project.total)}</span>
            <span className="text-right tabular-nums" aria-label={`${t("analytics.open")}: ${project.open}`}>{formatNumber(project.open)}</span>
            <span className="text-right tabular-nums" aria-label={`${t("analytics.completed")}: ${project.completed}`}>{formatNumber(project.completed)}</span>
          </li>)}
        </ul>
      </div>}
    </>}
  </section>;
}

/** Workspace Analytics, Work items tab: summary cards, Created vs Resolved and Customized insights (X axis, optional Group-by, project filter). */
export function AnalyticsPage({ workspaceId, workspaceSlug, action, run }: { workspaceId: string; workspaceSlug: string; action: Call; run: Run }) {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [x, setX] = React.useState<Axis>("state");
  const [groupBy, setGroupBy] = React.useState<Axis | "">("");
  const [state, setState] = React.useState<{ summary: Summary; insights: Insights; months: Month[] } | "forbidden" | "failed" | null>(null);
  React.useEffect(() => { void action<Project[]>("list_projects", { workspaceId, archived: false }).then((rows) => setProjects(rows ?? [])); }, [action, workspaceId]);
  React.useEffect(() => {
    let current = true;
    const filter = selected.length > 0 ? { projectIds: selected } : {};
    void Promise.all([
      run<Summary>("get_analytics_summary", { workspaceId, ...filter }),
      run<Insights>("get_analytics_insights", { workspaceId, x, ...(groupBy ? { groupBy } : {}), ...filter }),
      run<{ months: Month[] }>("get_created_vs_resolved", { workspaceId, ...filter }),
    ]).then(([summary, insights, months]) => {
      if (!current) return;
      const failure = [summary, insights, months].find((result) => "error" in result);
      if (failure) setState((failure as { error: string }).error === "Forbidden" ? "forbidden" : "failed");
      else setState({ summary: (summary as { data: Summary }).data, insights: (insights as { data: Insights }).data, months: (months as { data: { months: Month[] } }).data.months });
    });
    return () => { current = false; };
  }, [run, workspaceId, selected, x, groupBy]);
  const pickX = (axis: Axis) => { setX(axis); if (groupBy === axis) setGroupBy(""); };
  const empty = typeof state === "object" && state !== null && state.summary.total === 0 && selected.length === 0;
  return <section className="grid min-w-0 gap-4 p-4">
    <h2 className="m-0 flex items-center gap-2 text-18 font-semibold"><ChartColumn aria-hidden size={18} />{t("analytics.title")}</h2>
    <Tabs workspaceSlug={workspaceSlug} active="workItems" />
    {state === "forbidden" && <p role="alert" className="m-0 text-secondary">{t("analytics.forbidden")}</p>}
    {state === "failed" && <p role="alert" className="m-0 text-danger-text">{t("analytics.failed")}</p>}
    {typeof state === "object" && state !== null && <>
      <SummaryCards summary={state.summary} />
      {empty ? <p className="m-0 text-secondary">{t("analytics.empty")}</p> : <>
      <div className="grid min-w-0 gap-3 rounded-lg border border-subtle p-3">
        <h3 className="m-0 text-16 font-semibold">{t("analytics.createdVsResolved")}</h3>
        {state.months.length === 0 ? <p className="m-0 text-secondary">{t("analytics.noData")}</p> : <CreatedVsResolved months={state.months} />}
      </div>
      <div className="grid min-w-0 gap-3 rounded-lg border border-subtle p-3">
        <h3 className="m-0 text-16 font-semibold">{t("analytics.insights")}</h3>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-13 text-secondary">{t("analytics.xAxis")}
            <select value={x} onChange={(event) => pickX(event.target.value as Axis)} className={selectClass}>{axes.map((axis) => <option key={axis} value={axis}>{t(`analytics.axis.${axis}`)}</option>)}</select></label>
          <label className="flex items-center gap-2 text-13 text-secondary">{t("analytics.groupBy")}
            <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as Axis | "")} className={selectClass}>
              <option value="">{t("analytics.groupNone")}</option>{axes.filter((axis) => axis !== x).map((axis) => <option key={axis} value={axis}>{t(`analytics.axis.${axis}`)}</option>)}</select></label>
          <ProjectFilter projects={projects} selected={selected} onChange={setSelected} />
        </div>
        {state.insights.buckets.length === 0 ? <p className="m-0 text-secondary">{t("analytics.noData")}</p> : <Chart insights={state.insights} />}
      </div></>}
    </>}
  </section>;
}
