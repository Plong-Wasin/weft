/** Integration list of the current workspace. A response only lands if it belongs to the current workspace and the latest request. */
export type IntegrationsState<T> = { workspaceId: string; request: number; rows: T[] | null; loaded: boolean };
export type IntegrationsAction<T> =
  | { type: "workspace"; workspaceId: string; request: number }
  | { type: "refresh"; request: number }
  | { type: "response"; workspaceId: string; request: number; rows: T[] | null };
export function initialIntegrations<T>(workspaceId = ""): IntegrationsState<T> { return { workspaceId, request: 0, rows: null, loaded: false }; }
export function integrationsReducer<T>(state: IntegrationsState<T>, action: IntegrationsAction<T>): IntegrationsState<T> {
  if (action.type === "workspace") return { workspaceId: action.workspaceId, request: action.request, rows: null, loaded: false };
  if (action.type === "refresh") return { ...state, request: action.request };
  if (state.workspaceId !== action.workspaceId || state.request !== action.request) return state;
  return { ...state, rows: action.rows, loaded: true };
}
