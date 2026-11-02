import { action, actionResult } from "../api";
import { AnalyticsPage } from "../analytics";
import { useWorkspace } from "../layouts/workspace-layout";

export function AnalyticsRoute() { const { workspace } = useWorkspace(); return <AnalyticsPage workspaceId={workspace.id} action={action} run={actionResult} />; }
