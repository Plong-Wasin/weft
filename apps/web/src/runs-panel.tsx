import React from "react";
import { formatDate, translate } from "@weft/shared";
import { ProposalSet } from "./ai-chat";
import { runFailureText } from "./run-failure";
import { runFocusHref } from "./routes";
import { canCancelRun, canRerunRun, isActiveRun, runStatusKey } from "./run-status";
import { formatDuration, formatUsd, tokensOf } from "./usage-format";

type Run = { id: string; originatorId: string; status: string; attempt: number; rerunOfId: string | null; sessionMode: "resumed" | "new" | null; sessionReason: string | null; wokenBy: { runId: string | null; agentName: string; depth: number } | null; agentName: string | null; runtimeLabel: string | null; inputTokens: number; outputTokens: number; usageReported: boolean; model: string | null; elapsedMs: number | null; estimatedCostUsd: number | null; costReported: boolean; cacheReadTokens: number; cacheCreationTokens: number; createdAt: string; startedAt: string | null; finishedAt: string | null; failureMessage: string | null; failureReason: string | null };
type Step =
  | { seq: number; kind: "thought" | "answer" | "question" | "error"; text: string }
  | { seq: number; kind: "person"; author: string; text: string }
  | { seq: number; kind: "tool_call"; toolName: string; input: unknown; result: unknown; failed: boolean };
type Transcript = { steps: Step[]; runtimeProfile: { name: string; sandbox: string; enforceSandbox: boolean } | null; failureMessage: string | null; failureReason: string | null; confirmations: Array<{ id: string; status: string }> };
type Action = <T>(name: string, body: unknown) => Promise<T | null>;

const pollMs = 2_000;
const stepLabel = { thought: "runs.thought", answer: "runs.answer", question: "runs.question", error: "runs.error" } as const;
const pretty = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

function StepView({ step }: { step: Step }) {
  if (step.kind === "tool_call") return <li data-step="tool_call" className="grid gap-1">
    <span className="font-medium">{translate("runs.tool")}: {step.toolName}{step.failed ? ` (${translate("runs.toolFailed")})` : ""}</span>
    <details className="text-12 text-tertiary"><summary className="cursor-pointer">{translate("ai.details")}</summary>
      {step.input === null && step.result === null ? <p className="m-0">{translate("runs.hidden")}</p> : <><pre className="whitespace-pre-wrap">{pretty(step.input)}</pre>{step.result !== null && <pre className="whitespace-pre-wrap">{pretty(step.result)}</pre>}</>}</details>
  </li>;
  if (step.kind === "person") return <li data-step="person"><span className="font-medium">{translate("runs.personMessage").replace("{name}", () => step.author)}: </span>{step.text}</li>;
  return <li data-step={step.kind}><span className="font-medium">{translate(stepLabel[step.kind])}: </span>{step.text}</li>;
}

/** The text of each session reason code the Daemon or the server can give. */
const sessionReasonKeys = {
  first: "runs.session.reason.first", runtime_changed: "runs.session.reason.runtime_changed", previous_failed: "runs.session.reason.previous_failed", previous_active: "runs.session.reason.previous_active",
  no_session_id: "runs.session.reason.no_session_id", rerun_as_new: "runs.session.reason.rerun_as_new", folder_missing: "runs.session.reason.folder_missing", runtime_environment_changed: "runs.session.reason.runtime_environment_changed",
  cli_rejected_resume: "runs.session.reason.cli_rejected_resume", cli_without_resume: "runs.session.reason.cli_without_resume", no_work_item: "runs.session.reason.no_work_item",
} as const;
/** Whether the Run resumed its CLI Session or started a new one, and why. Nothing is shown for a server Run or a Run that has not started. */
function RunSession({ run }: { run: Run }) {
  if (!run.sessionMode) return null;
  const reason = run.sessionReason && run.sessionReason in sessionReasonKeys ? translate(sessionReasonKeys[run.sessionReason as keyof typeof sessionReasonKeys]) : null;
  return <span className="text-12 text-tertiary" data-testid="run-session" data-session-mode={run.sessionMode}>
    {translate(run.sessionMode === "resumed" ? "runs.session.resumed" : "runs.session.new")}{reason ? ` (${reason})` : ""}
  </span>;
}

/** The Agent and the Runtime a Run ran as and on: the names and labels it kept when it was created, or the live ones. Nothing is shown when neither is known. */
function RunLabels({ run }: { run: Run }) {
  if (!run.agentName && !run.runtimeLabel) return null;
  return <span className="flex flex-wrap gap-x-2 text-12 text-tertiary" data-testid="run-labels">
    {run.agentName && <span data-testid="run-agent">{translate("runs.ranAs").replace("{agent}", () => run.agentName!)}</span>}
    {run.runtimeLabel && <span data-testid="run-runtime">{translate("runs.onRuntime").replace("{runtime}", () => run.runtimeLabel!)}</span>}
  </span>;
}

/** The Run that woke this Run and its depth in the Wake chain, with a link to that Run when the viewer may open it. Nothing is shown for a Run a person or schedule started. */
function RunWokenBy({ run }: { run: Run }) {
  if (!run.wokenBy) return null;
  const { runId, agentName, depth } = run.wokenBy;
  return <span className="flex flex-wrap items-baseline gap-x-1 text-12 text-tertiary" data-testid="run-woken-by">
    {runId ? <a href={runFocusHref(runId)}>{translate("runs.wokenBy").replace("{agent}", () => agentName)}</a> : <span>{translate("runs.wokenBy").replace("{agent}", () => agentName)}</span>}
    <span>· {translate("runs.wokenByDepth").replace("{depth}", String(depth))}</span>
  </span>;
}

/** Tokens, time and estimated cost of one Run. A value the CLI did not report reads "unknown", never zero. */
function RunUsage({ run }: { run: Run }) {
  const tokens = run.usageReported ? tokensOf({ inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens, cacheCreationTokens: run.cacheCreationTokens }) : null;
  const time = formatDuration(run.elapsedMs, (unit, values) => unit === "seconds" ? translate("usage.duration.seconds").replace("{count}", String(values.count)) : translate("usage.duration.minutes").replace("{minutes}", String(values.minutes)).replace("{seconds}", String(values.seconds)));
  const cost = formatUsd(run.estimatedCostUsd);
  return <span className="flex flex-wrap gap-x-2 text-12 text-tertiary" data-testid="run-usage">
    <span data-usage="tokens">{tokens === null ? translate("runs.usageUnknown") : translate("runs.tokens").replace("{count}", String(tokens))}</span>
    <span data-usage="time">{time === null ? translate("runs.timeUnknown") : translate("runs.timeLabel").replace("{time}", time)}</span>
    <span data-usage="cost" title={translate(run.costReported ? "runs.costReportedHelp" : "runs.costHelp")}>{cost === null ? translate("runs.costUnknown") : translate(run.costReported ? "runs.costReportedLabel" : "runs.costLabel").replace("{cost}", cost)}</span>
  </span>;
}

function RunCard({ run, workspaceId, highlighted, canControl, action, tick, onChanged }: { run: Run; workspaceId: string; highlighted: boolean; canControl: boolean; action: Action; tick: number; onChanged: () => void }) {
  const [open, setOpen] = React.useState(highlighted);
  const [transcript, setTranscript] = React.useState<Transcript | null>(null);
  const [failed, setFailed] = React.useState(false);
  const failureText = runFailureText(run.failureReason);
  const waiting = run.status === "waiting_confirmation";
  const showTranscript = open || waiting;
  React.useEffect(() => { if (highlighted) document.getElementById(`run-${run.id}`)?.scrollIntoView({ block: "center" }); }, [highlighted, run.id]);
  React.useEffect(() => {
    if (!showTranscript) return;
    void action<Transcript>("get_run_transcript", { runId: run.id }).then((loaded) => { if (loaded) setTranscript(loaded); });
  }, [action, run.id, run.status, showTranscript, tick]);
  const control = async (name: "cancel_run" | "rerun_run", extra: { newSession?: boolean } = {}) => { setFailed(await action(name, { runId: run.id, ...extra }) === null); onChanged(); };
  const pending = (transcript?.confirmations ?? []).filter((card) => card.status === "pending").map((card) => card.id);
  return <li id={`run-${run.id}`} data-run-status={run.status} data-highlighted={highlighted || undefined} className={`grid gap-2 rounded-lg border bg-surface-1 px-4 py-3 ${highlighted ? "border-accent-strong" : "border-subtle"}`}>
    <div className="flex flex-wrap items-center gap-2 text-14">
      <strong data-testid="run-status">{translate(runStatusKey(run.status))}</strong>
      <small className="text-tertiary">{formatDate(run.createdAt)} · {translate("runs.attempt").replace("{attempt}", String(run.attempt + 1))}</small>
      <RunLabels run={run} />
      <RunUsage run={run} />
      <RunSession run={run} />
      <RunWokenBy run={run} />
      {canControl && canCancelRun(run) && <button type="button" className="secondary" onClick={() => void control("cancel_run")}>{translate("runs.cancel")}</button>}
      {canControl && canRerunRun(run) && <button type="button" className="secondary" onClick={() => void control("rerun_run")}>{translate("runs.rerun")}</button>}
      {canControl && canRerunRun(run) && <button type="button" className="secondary" onClick={() => void control("rerun_run", { newSession: true })}>{translate("runs.rerunNewSession")}</button>}
      {!waiting && <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{translate(open ? "runs.hideTranscript" : "runs.showTranscript")}</button>}
    </div>
    {(failureText || run.failureMessage) && <div role="alert" className="grid gap-0.5 text-13 text-danger-text">
      {failureText && <p className="m-0">{failureText}</p>}
      {run.failureMessage && <p className="m-0 text-secondary">{translate("runs.failureDetail").replace("{detail}", () => run.failureMessage!)}</p>}
    </div>}
    {failed && <p role="alert" className="text-13 text-danger-text">{translate("runs.failed")}</p>}
    {showTranscript && <div aria-label={translate("runs.transcript")} data-testid="run-transcript-content" className="[overflow-wrap:anywhere]">
      {transcript?.runtimeProfile && <div className="rounded-md bg-surface-2 px-3 py-2 text-12" data-testid="run-runtime-profile"><strong>{translate("runs.runtimeProfileHeader")}: {transcript.runtimeProfile.name}</strong> · {translate(transcript.runtimeProfile.sandbox === "full" ? "runtimes.fullAccessWarning" : "runtimes.sandboxEnabled")}</div>}
      {transcript && transcript.steps.length === 0 && <p className="text-13 text-secondary">{translate("runs.noSteps")}</p>}
      <ol className="m-0 grid list-none gap-1.5 p-0 text-13">{transcript?.steps.map((step) => <StepView key={step.seq} step={step} />)}</ol>
    </div>}
    {pending.length > 0 && <ProposalSet ids={pending} refreshKey={tick} onResolved={onChanged} workspaceId={workspaceId} />}
  </li>;
}

/** The Agent Runs of a work item: status, transcript, cancel and rerun, and the Originator's pending Confirmations. Polls while a Run is active. */
export function RunsPanel({ workItemId, workspaceId, canControl, selfId, isAdmin, action, onActivity }: { workItemId: string; workspaceId: string; canControl: boolean; selfId: string; isAdmin: boolean; action: Action; onActivity: () => void }) {
  const [runs, setRuns] = React.useState<Run[] | null>(null);
  const [tick, setTick] = React.useState(0);
  const statuses = React.useRef<Record<string, string>>({});
  const focused = React.useMemo(() => new URLSearchParams(window.location.search).get("run"), []);
  const load = React.useCallback(async () => {
    const loaded = await action<Run[]>("list_runs", { workItemId });
    if (loaded === null) return;
    // A Run reaching a final status may have posted an Agent comment or changed the item: tell the page.
    const before = statuses.current;
    if (loaded.some((run) => before[run.id] !== undefined && before[run.id] !== run.status && !isActiveRun(run))) onActivity();
    statuses.current = Object.fromEntries(loaded.map((run) => [run.id, run.status]));
    setRuns(loaded);
    setTick((value) => value + 1);
  }, [action, workItemId, onActivity]);
  React.useEffect(() => { void load(); }, [load]);
  const anyActive = runs?.some(isActiveRun) ?? false;
  React.useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [anyActive, load]);
  if (runs === null || (runs.length === 0 && !focused)) return null;
  return <section aria-labelledby="runs-title" data-testid="runs-panel" className="grid gap-2">
    <h3 id="runs-title" className="text-16 font-medium text-primary">{translate("runs.title")}</h3>
    {focused && !runs.some((run) => run.id === focused) && <p role="status" className="text-13 text-secondary">{translate("runs.empty")}</p>}
    <ul className="m-0 grid list-none gap-2 p-0">{runs.map((run) => <RunCard key={run.id} run={run} workspaceId={workspaceId} highlighted={run.id === focused} canControl={canControl && (isAdmin || run.originatorId === selfId)} action={action} tick={tick} onChanged={() => void load()} />)}</ul>
  </section>;
}
