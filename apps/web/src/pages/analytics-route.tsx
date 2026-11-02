import { action, actionResult } from "../api";
import { AnalyticsOverviewPage, AnalyticsPage } from "../analytics";
import { useWorkspace } from "../layouts/workspace-layout";

export function AnalyticsRoute() { const { workspace } = useWorkspace(); return <AnalyticsPage workspaceId={workspace.id} workspaceSlug={workspace.slug} action={action} run={actionResult} />; }
export function AnalyticsOverviewRoute() { const { workspace } = useWorkspace(); return <AnalyticsOverviewPage workspaceId={workspace.id} workspaceSlug={workspace.slug} run={actionResult} />; }
