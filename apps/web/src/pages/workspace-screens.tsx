import { useParams, Navigate } from "react-router";
import { AiChatPage } from "../ai-chat";
import { useWorkspace } from "../layouts/workspace-layout";
import { InboxPanel } from "../inbox";
import { WikiListPage, WikiPageScreen } from "../wiki";
import { paths } from "../routes";
import { ProjectsPanel } from "./projects";

export function WorkspaceHome() {
  const { workspace } = useWorkspace();
  return <ProjectsPanel key={workspace.id} />;
}
export const ProjectsRoute = ProjectsPanel;
export function NotificationsRoute() { return <InboxPanel workspace={useWorkspace().workspace} />; }
export function AiRoute() { const { workspace } = useWorkspace(); const { chatId = "" } = useParams(); return <AiChatPage workspace={workspace} chatId={chatId} />; }
export function WikiRoute() { const { workspace, selfId } = useWorkspace(); const { pageId } = useParams(); return pageId ? <WikiPageScreen workspace={workspace} self={selfId} pageId={pageId} /> : <WikiListPage workspace={workspace} />; }

/** Old URL shapes (before Plane-style routes) keep working: they redirect to the new location. */
export function LegacyRedirect({ to }: { to: (workspace: string, params: Record<string, string | undefined>) => string }) {
  const { workspace } = useWorkspace();
  const params = useParams();
  return <Navigate replace to={`${to(workspace.slug, params)}${window.location.search}${window.location.hash}`} />;
}
