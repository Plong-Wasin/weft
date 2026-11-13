import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { setIntegrationsEnabled } from "../src/integrations-flag";
import { ProjectMergeSetting } from "../src/pages/settings/project-merge-setting";

const render = () => renderToString(<ProjectMergeSetting projectId="p1" canAdmin onNote={() => {}} />);

test("the merge setting (pull and merge request wording) is hidden when integrations are off", () => {
  setIntegrationsEnabled(false);
  expect(render()).toBe("");
});

test("the merge setting shows when integrations are on", () => {
  setIntegrationsEnabled(true);
  expect(render()).toContain("When a linked request merges");
  setIntegrationsEnabled(false);
});
