import { expect, test } from "bun:test";
import { applyAuditPage, applyMemberResponse, changeAuditFilter, failMember, isCurrentRequest, nextRequest, refreshCurrentMember, selectMember } from "../src/pages/settings/member-security-state";

test("delayed revoke refresh uses the current selection and cannot show A tokens under B", () => {
  let state = selectMember<{ id: string }>("A");
  state = selectMember("B");
  const refreshTarget = refreshCurrentMember(state);
  expect(refreshTarget).toBe("B");
  expect(applyMemberResponse(state, "A", [{ id: "A-token" }])).toEqual({ selected: "B", tokens: null, loading: true, failed: false });
  expect(applyMemberResponse(state, "B", [{ id: "B-token" }]).tokens).toEqual([{ id: "B-token" }]);
});

test("rejected fetch is a retryable error and a later retry succeeds", () => {
  let state = selectMember<{ id: string }>("A");
  state = failMember(state, "A");
  expect(state).toMatchObject({ selected: "A", failed: true, loading: false, tokens: null });
  state = selectMember("A");
  state = applyMemberResponse(state, "A", [{ id: "retried" }]);
  expect(state).toMatchObject({ failed: false, loading: false, tokens: [{ id: "retried" }] });
});

test("old audit-filter page is discarded after changing filters", () => {
  const before = changeAuditFilter<{ id: string }>("member:A");
  const after = changeAuditFilter("member:B");
  expect(applyAuditPage(after, before.filter, 50, [{ id: "old" }], true)).toEqual(after);
});

test("out-of-order account and token responses are dropped", () => {
  const identity = { current: 0 };
  const accountRequest = nextRequest(identity);
  nextRequest(identity);
  expect(isCurrentRequest(identity, accountRequest)).toBe(false);
  const tokenRequest = nextRequest(identity);
  nextRequest(identity);
  expect(isCurrentRequest(identity, tokenRequest)).toBe(false);
});
