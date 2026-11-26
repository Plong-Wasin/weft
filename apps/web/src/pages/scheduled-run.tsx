import { Card } from "@/ui/card";
import React from "react";
import { Link, useParams } from "react-router";
import { formatDate, translate, translateDynamic } from "@weft/shared";
import { action } from "../api";
import { useInboxNotificationOpen } from "../notification-open";
import { useWorkspace } from "../layouts/workspace-layout";
import { paths } from "../routes";
import { runFailureText } from "../run-failure";

type ScheduledRun = { id: string; workItemId: string | null; status: string; createdAt: string; failureReason: string | null; failureMessage: string | null };

/** A project-permission-checked destination for notifications about Runs without a work item. */
export function ScheduledRunPage() {
  const { runId = "" } = useParams();
  const { workspace } = useWorkspace();
  const [run, setRun] = React.useState<ScheduledRun | null | undefined>();
  const { markLoaded, markUnavailable } = useInboxNotificationOpen();
  React.useEffect(() => {
    let active = true;
    void action<ScheduledRun>("get_run", { runId }).then((result) => {
      if (!active) return;
      if (!result || result.workItemId !== null) { setRun(null); markUnavailable(); return; }
      setRun(result);
      markLoaded();
    });
    return () => { active = false; };
  }, [runId, markLoaded, markUnavailable]);

  return <Card as="section" className="mx-auto grid max-w-3xl gap-4 rounded-xl p-5 sm:p-6">
    <Link to={paths.notifications(workspace.slug)} className="text-13 text-muted-foreground">{translate("inbox.title")}</Link>
    <h1 className="m-0 text-20 font-semibold">{translate("runs.scheduled")}</h1>
    {run === undefined ? <p role="status">{translate("runs.scheduledLoading")}</p> : !run ? <p role="status">{translate("runs.scheduledUnavailable")}</p> : <>
      <p className="m-0 text-14 text-muted-foreground">{translateDynamic(`runs.status.${run.status}`) ?? run.status} · {formatDate(run.createdAt)}</p>
      {run.failureReason && <p className="m-0" role="status">{runFailureText(run.failureReason) ?? run.failureMessage ?? translate("runs.scheduledUnavailable")}</p>}
      {run.failureMessage && run.failureReason && run.failureReason !== "runtime_capability_missing" && <p className="m-0 text-13 text-muted-foreground">{translate("runs.failureDetail").replace("{detail}", run.failureMessage)}</p>}
    </>}
  </Card>;
}
