/** Monotonic request identity; callers ignore responses whose identity is no longer current. */
export type RequestIdentity = { current: number };
export function nextRequest(identity: RequestIdentity): number { return ++identity.current; }
export function isCurrentRequest(identity: RequestIdentity, request: number): boolean { return identity.current === request; }

export type MemberTokensState<T> = { selected: string | null; tokens: T[] | null; loading: boolean; failed: boolean };
export function selectMember<T>(userId: string | null): MemberTokensState<T> {
  return { selected: userId, tokens: null, loading: userId !== null, failed: false };
}
export function applyMemberResponse<T>(state: MemberTokensState<T>, userId: string, tokens: T[] | null): MemberTokensState<T> {
  if (state.selected !== userId) return state;
  return { selected: userId, tokens, loading: false, failed: tokens === null };
}
export function failMember<T>(state: MemberTokensState<T>, userId: string): MemberTokensState<T> {
  return state.selected === userId ? { ...state, tokens: null, loading: false, failed: true } : state;
}
export function refreshCurrentMember<T>(state: MemberTokensState<T>): string | null { return state.selected; }

export type AuditPageState<T> = { filter: string; rows: T[]; loading: boolean; failed: boolean; hasMore: boolean };
export function changeAuditFilter<T>(filter: string): AuditPageState<T> { return { filter, rows: [], loading: true, failed: false, hasMore: false }; }
export function applyAuditPage<T>(state: AuditPageState<T>, filter: string, offset: number, rows: T[], hasMore: boolean): AuditPageState<T> {
  if (state.filter !== filter) return state;
  return { ...state, rows: offset === 0 ? rows : [...state.rows, ...rows], loading: false, failed: false, hasMore };
}
export function failAuditPage<T>(state: AuditPageState<T>, filter: string): AuditPageState<T> {
  return state.filter === filter ? { ...state, loading: false, failed: true } : state;
}
