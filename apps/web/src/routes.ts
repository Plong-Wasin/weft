/** Every URL the web app links to. Shapes mirror Plane's (workspace slug first, projects, cycles, modules, views, pages, browse by work item key); a project is addressed by its key. */
const e = encodeURIComponent;

export const paths = {
  home: (workspace: string) => `/${e(workspace)}`,
  projects: (workspace: string) => `/${e(workspace)}/projects`,
  project: (workspace: string, key: string) => `/${e(workspace)}/projects/${e(key)}`,
  workItems: (workspace: string, key: string) => `${paths.project(workspace, key)}/issues`,
  workItem: (workspace: string, displayId: string) => `/${e(workspace)}/browse/${e(displayId)}`,
  cycles: (workspace: string, key: string) => `${paths.project(workspace, key)}/cycles`,
  cycle: (workspace: string, key: string, id: string) => `${paths.cycles(workspace, key)}/${e(id)}`,
  activeCycles: (workspace: string) => `/${e(workspace)}/active-cycles`,
  modules: (workspace: string, key: string) => `${paths.project(workspace, key)}/modules`,
  module: (workspace: string, key: string, id: string) => `${paths.modules(workspace, key)}/${e(id)}`,
  views: (workspace: string, key: string) => `${paths.project(workspace, key)}/views`,
  view: (workspace: string, key: string, id: string) => `${paths.views(workspace, key)}/${e(id)}`,
  pages: (workspace: string, key: string) => `${paths.project(workspace, key)}/pages`,
  page: (workspace: string, key: string, id: string) => `${paths.pages(workspace, key)}/${e(id)}`,
  intake: (workspace: string, key: string) => `${paths.project(workspace, key)}/intake`,
  /** Project settings live under the workspace settings, as in Plane: /settings/projects/KEY[/members|labels|states|features]. */
  projectSettings: (workspace: string, key: string, section = "") => `/${e(workspace)}/settings/projects/${e(key)}${section ? `/${section}` : ""}`,
  workspaceSettings: (workspace: string) => `/${e(workspace)}/settings`,
  workspaceMembers: (workspace: string) => `/${e(workspace)}/settings/members`,
  workspaceInvites: (workspace: string) => `/${e(workspace)}/settings/invites`,
  notifications: (workspace: string) => `/${e(workspace)}/notifications`,
  wiki: (workspace: string) => `/${e(workspace)}/wiki`,
  wikiPage: (workspace: string, id: string) => `/${e(workspace)}/wiki/${e(id)}`,
  ai: (workspace: string) => `/${e(workspace)}/ai`,
  aiChat: (workspace: string, id: string) => `/${e(workspace)}/ai/${e(id)}`,
  invite: (token: string) => `/invite/${e(token)}`,
} as const;
