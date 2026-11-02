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
import { ApiTokensPage } from "./pages/settings/api-tokens";
import { OAuthConsentPage } from "./pages/oauth-consent";
import { ProjectWorkItems } from "./pages/project-work-items";
import { WorkspaceViewRoute } from "./pages/workspace-view-route";
import { ActiveCyclesRoute, ProjectCycleRoute, ProjectCyclesRoute, ProjectIntakeRoute, ProjectModuleRoute, ProjectModulesRoute, ProjectPageRoute, ProjectPagesRoute, ProjectViewRoute, ProjectViewsRoute } from "./pages/project-feature-pages";
import { WorkItemPage } from "./pages/work-item-page";
import "./style.css";

// A tab left open never re-navigates, so the browser would not look for a new service worker: check hourly and when the tab regains focus.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => { void registration.update().catch(() => undefined); };
    setInterval(check, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  },
});
initLocale();
initTheme();
const queryClient = createQueryClient();

/** The route table. URL shapes mirror Plane's; a project is addressed by its key. */
function AppRoutes() {
  return <Routes>
    <Route element={<RootLayout />}>
      <Route path="oauth/sign-in" element={null} />
      <Route path="oauth/consent" element={<OAuthConsentPage />} />
      <Route path="account/api-tokens" element={<ApiTokensPage />} />
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
          <Route path="views" element={<ProjectViewsRoute />} />
          <Route path="views/:viewId" element={<ProjectViewRoute />} />
          <Route path="pages" element={<ProjectPagesRoute />} />
          <Route path="pages/:pageId" element={<ProjectPageRoute />} />
          <Route path="intake" element={<ProjectIntakeRoute />} />
          <Route path="settings" element={<LegacyRedirect to={(workspace, params) => paths.projectSettings(workspace, params.projectKey ?? "")} />} />
        </Route>
        <Route path="workspace-views" element={<Navigate to="all-issues" replace />} />
        <Route path="workspace-views/:viewId" element={<WorkspaceViewRoute />} />
        <Route path="active-cycles" element={<ActiveCyclesRoute />} />
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
