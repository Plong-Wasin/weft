import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { registerSW } from "virtual:pwa-register";
import { createQueryClient } from "./query-client";
import { initLocale } from "./locale";
import { initTheme } from "./theme";
import { paths } from "./routes";
import { HomeRedirect, RootLayout } from "./layouts/root-layout";
import { WorkspaceLayout } from "./layouts/workspace-layout";
import { ProjectLayout } from "./layouts/project-layout";
import { AiRoute, LegacyRedirect, NotificationsRoute, ProjectsRoute, WikiRoute, WorkspaceHome } from "./pages/workspace-screens";
import { SettingsLayout, WorkspaceGeneral, WorkspaceInvites, WorkspaceMembers } from "./pages/settings/workspace-settings";
import { ProjectFeatures, ProjectGeneral, ProjectLabels, ProjectMembers, ProjectSettingsLayout, ProjectStates } from "./pages/settings/project-settings";
import { ProjectWorkItems } from "./pages/project-work-items";
import { ProjectCycleRoute, ProjectCyclesRoute, ProjectIntakeRoute, ProjectModuleRoute, ProjectModulesRoute, ProjectPageRoute, ProjectPagesRoute } from "./pages/project-feature-pages";
import { WorkItemPage } from "./pages/work-item-page";
import { PlaceholderPage } from "./pages/placeholder-page";
import "./style.css";

registerSW({ immediate: true });
initLocale();
initTheme();
const queryClient = createQueryClient();

/** The route table. URL shapes mirror Plane's; a project is addressed by its key. */
function AppRoutes() {
  return <Routes>
    <Route element={<RootLayout />}>
      <Route index element={<HomeRedirect />} />
      <Route path="invite/:token" element={null} />
      <Route path=":workspaceSlug" element={<WorkspaceLayout />}>
        <Route index element={<WorkspaceHome />} />
        <Route path="projects" element={<ProjectsRoute />} />
        <Route path="projects/:projectKey" element={<ProjectLayout />}>
          <Route index element={<Navigate to="issues" replace />} />
          <Route path="issues" element={<ProjectWorkItems />} />
          <Route path="cycles" element={<ProjectCyclesRoute />} />
          <Route path="cycles/:cycleId" element={<ProjectCycleRoute />} />
          <Route path="modules" element={<ProjectModulesRoute />} />
          <Route path="modules/:moduleId" element={<ProjectModuleRoute />} />
          <Route path="views" element={<PlaceholderPage heading="projectNav.views" />} />
          <Route path="views/:viewId" element={<PlaceholderPage heading="projectNav.views" />} />
          <Route path="pages" element={<ProjectPagesRoute />} />
          <Route path="pages/:pageId" element={<ProjectPageRoute />} />
          <Route path="intake" element={<ProjectIntakeRoute />} />
          <Route path="settings" element={<LegacyRedirect to={(workspace, params) => paths.projectSettings(workspace, params.projectKey ?? "")} />} />
        </Route>
        <Route path="browse/:displayId" element={<WorkItemPage />} />
        <Route path="notifications" element={<NotificationsRoute />} />
        <Route path="wiki" element={<WikiRoute />} />
        <Route path="wiki/:pageId" element={<WikiRoute />} />
        <Route path="ai" element={<AiRoute />} />
        <Route path="ai/:chatId" element={<AiRoute />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<WorkspaceGeneral />} />
          <Route path="members" element={<WorkspaceMembers />} />
          <Route path="invites" element={<WorkspaceInvites />} />
          <Route path="projects/:projectKey" element={<ProjectSettingsLayout />}>
            <Route index element={<ProjectGeneral />} />
            <Route path="members" element={<ProjectMembers />} />
            <Route path="labels" element={<ProjectLabels />} />
            <Route path="states" element={<ProjectStates />} />
            <Route path="features" element={<ProjectFeatures />} />
          </Route>
        </Route>
        {/* URLs from before the Plane-style routes */}
        <Route path="work-items/:displayId" element={<LegacyRedirect to={(workspace, params) => paths.workItem(workspace, params.displayId ?? "")} />} />
        <Route path="inbox" element={<LegacyRedirect to={paths.notifications} />} />
      </Route>
    </Route>
  </Routes>;
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><BrowserRouter><AppRoutes /></BrowserRouter></QueryClientProvider>);
