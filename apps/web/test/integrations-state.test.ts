import { expect, test } from "bun:test";
import { initialIntegrations, integrationsReducer } from "../src/pages/settings/integrations-state";

test("late response from the old workspace cannot overwrite the new one", () => {
  let state = integrationsReducer(initialIntegrations<string>(), { type: "workspace", workspaceId: "W1", request: 1 });
  state = integrationsReducer(state, { type: "response", workspaceId: "W1", request: 1, rows: ["w1"] });
  state = integrationsReducer(state, { type: "workspace", workspaceId: "W2", request: 2 });
  expect(state).toMatchObject({ rows: null, loaded: false });
  expect(integrationsReducer(state, { type: "response", workspaceId: "W1", request: 1, rows: ["w1"] })).toEqual(state);
  expect(integrationsReducer(state, { type: "response", workspaceId: "W2", request: 2, rows: ["w2"] })).toMatchObject({ rows: ["w2"], loaded: true });
});

test("failure keeps loaded with null rows so Retry shows, and a stale refresh is dropped", () => {
  let state = integrationsReducer(initialIntegrations<string>(), { type: "workspace", workspaceId: "W", request: 1 });
  state = integrationsReducer(state, { type: "response", workspaceId: "W", request: 1, rows: null });
  expect(state).toMatchObject({ rows: null, loaded: true });
  state = integrationsReducer(state, { type: "refresh", request: 2 });
  state = integrationsReducer(state, { type: "refresh", request: 3 });
  expect(integrationsReducer(state, { type: "response", workspaceId: "W", request: 2, rows: ["stale"] })).toEqual(state);
});

test("Retry after a failure shows the loading state again, and a refresh with rows keeps showing them", () => {
  let state = integrationsReducer(initialIntegrations<string>(), { type: "workspace", workspaceId: "W", request: 1 });
  state = integrationsReducer(state, { type: "response", workspaceId: "W", request: 1, rows: null });
  expect(integrationsReducer(state, { type: "refresh", request: 2 })).toMatchObject({ rows: null, loaded: false });
  state = integrationsReducer(state, { type: "response", workspaceId: "W", request: 1, rows: ["a"] });
  expect(integrationsReducer(state, { type: "refresh", request: 3 })).toMatchObject({ rows: ["a"], loaded: true });
});
