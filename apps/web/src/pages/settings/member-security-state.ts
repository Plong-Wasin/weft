/** Monotonic request identity; callers ignore responses whose identity is no longer current. */
export type RequestIdentity = { current: number };
export function nextRequest(identity: RequestIdentity): number { return ++identity.current; }
export function isCurrentRequest(identity: RequestIdentity, request: number): boolean { return identity.current === request; }

/** Token panel of one member. A response only lands if it still belongs to the selected member and the latest request. */
export type MemberTokensState<T> = { selected: string | null; request: number; tokens: T[] | null; failed: boolean };
export type MemberTokensAction<T> =
  | { type: "load"; userId: string | null; request: number }
  | { type: "response"; userId: string; request: number; tokens: T[] | null };
export function initialMemberTokens<T>(): MemberTokensState<T> { return { selected: null, request: 0, tokens: null, failed: false }; }
export function memberTokensReducer<T>(state: MemberTokensState<T>, action: MemberTokensAction<T>): MemberTokensState<T> {
  if (action.type === "load") return { selected: action.userId, request: action.request, tokens: null, failed: false };
  if (state.selected !== action.userId || state.request !== action.request) return state;
  return { ...state, tokens: action.tokens, failed: action.tokens === null };
}

/** Audit page list for one filter. A page for an old filter or an old request is dropped. */
export type AuditPageState<T> = { filter: string; request: number; rows: T[]; hasMore: boolean; loaded: boolean; failed: boolean };
export type AuditPageAction<T> =
  | { type: "filter"; filter: string; request: number }
  | { type: "more"; request: number }
  | { type: "page"; filter: string; request: number; offset: number; rows: T[]; hasMore: boolean }
  | { type: "fail"; filter: string; request: number };
export function initialAuditPage<T>(filter = ""): AuditPageState<T> { return { filter, request: 0, rows: [], hasMore: false, loaded: false, failed: false }; }
export function auditPageReducer<T>(state: AuditPageState<T>, action: AuditPageAction<T>): AuditPageState<T> {
  if (action.type === "filter") return { filter: action.filter, request: action.request, rows: [], hasMore: false, loaded: false, failed: false };
  if (action.type === "more") return { ...state, request: action.request, failed: false };
  if (state.filter !== action.filter || state.request !== action.request) return state;
  if (action.type === "fail") return { ...state, loaded: true, failed: true };
  return { ...state, rows: action.offset === 0 ? action.rows : [...state.rows, ...action.rows], hasMore: action.hasMore, loaded: true, failed: false };
}
