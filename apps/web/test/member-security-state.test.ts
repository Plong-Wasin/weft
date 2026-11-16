import { expect, test } from "bun:test";
import { auditPageReducer, initialAuditPage, initialMemberTokens, isCurrentRequest, memberTokensReducer, nextRequest } from "../src/pages/settings/member-security-state";

type Token = { id: string };

test("delayed revoke refresh for A cannot show A tokens under B", () => {
  let state = initialMemberTokens<Token>();
  state = memberTokensReducer(state, { type: "load", userId: "A", request: 1 });
  state = memberTokensReducer(state, { type: "load", userId: "B", request: 2 });
  const late = memberTokensReducer(state, { type: "response", userId: "A", request: 1, tokens: [{ id: "A-token" }] });
  expect(late).toEqual(state);
  expect(memberTokensReducer(state, { type: "response", userId: "B", request: 2, tokens: [{ id: "B-token" }] }).tokens).toEqual([{ id: "B-token" }]);
});

test("older response for the same member is dropped after a newer refresh starts", () => {
  let state = memberTokensReducer(initialMemberTokens<Token>(), { type: "load", userId: "A", request: 1 });
  state = memberTokensReducer(state, { type: "load", userId: "A", request: 2 });
  expect(memberTokensReducer(state, { type: "response", userId: "A", request: 1, tokens: [{ id: "stale" }] })).toEqual(state);
});

test("closing the panel drops in-flight responses", () => {
  let state = memberTokensReducer(initialMemberTokens<Token>(), { type: "load", userId: "A", request: 1 });
  state = memberTokensReducer(state, { type: "load", userId: null, request: 2 });
  expect(memberTokensReducer(state, { type: "response", userId: "A", request: 1, tokens: [{ id: "x" }] }).tokens).toBeNull();
});

test("rejected fetch is a retryable error and a later retry succeeds", () => {
  let state = memberTokensReducer(initialMemberTokens<Token>(), { type: "load", userId: "A", request: 1 });
  state = memberTokensReducer(state, { type: "response", userId: "A", request: 1, tokens: null });
  expect(state).toMatchObject({ selected: "A", failed: true, tokens: null });
  state = memberTokensReducer(state, { type: "load", userId: "A", request: 2 });
  expect(state.failed).toBe(false);
  state = memberTokensReducer(state, { type: "response", userId: "A", request: 2, tokens: [{ id: "retried" }] });
  expect(state).toMatchObject({ failed: false, tokens: [{ id: "retried" }] });
});

test("old audit-filter page is discarded after changing filters", () => {
  let state = auditPageReducer(initialAuditPage<Token>(), { type: "filter", filter: "member:A", request: 1 });
  state = auditPageReducer(state, { type: "filter", filter: "member:B", request: 2 });
  expect(auditPageReducer(state, { type: "page", filter: "member:A", request: 1, offset: 0, rows: [{ id: "old" }], hasMore: true })).toEqual(state);
  expect(auditPageReducer(state, { type: "fail", filter: "member:A", request: 1 })).toEqual(state);
});

test("audit pages append for the same filter and a failed page is retryable", () => {
  let state = auditPageReducer(initialAuditPage<Token>(), { type: "filter", filter: "f", request: 1 });
  state = auditPageReducer(state, { type: "page", filter: "f", request: 1, offset: 0, rows: [{ id: "1" }], hasMore: true });
  state = auditPageReducer(state, { type: "more", request: 2 });
  state = auditPageReducer(state, { type: "fail", filter: "f", request: 2 });
  expect(state).toMatchObject({ failed: true, rows: [{ id: "1" }] });
  state = auditPageReducer(state, { type: "more", request: 3 });
  state = auditPageReducer(state, { type: "page", filter: "f", request: 3, offset: 1, rows: [{ id: "2" }], hasMore: false });
  expect(state).toMatchObject({ failed: false, hasMore: false, rows: [{ id: "1" }, { id: "2" }] });
});

test("out-of-order request identities are dropped", () => {
  const identity = { current: 0 };
  const first = nextRequest(identity);
  nextRequest(identity);
  expect(isCurrentRequest(identity, first)).toBe(false);
});
