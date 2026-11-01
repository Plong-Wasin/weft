import { useParams } from "react-router";
import { useWorkspace } from "../layouts/workspace-layout";
import { WorkspaceViewPage } from "../workspace-views";

export function WorkspaceViewRoute() { const { workspace, selfId } = useWorkspace(); const { viewId = "" } = useParams(); return <WorkspaceViewPage key={`${workspace.id}:${viewId}`} workspace={workspace} selfId={selfId} viewId={viewId} />; }
