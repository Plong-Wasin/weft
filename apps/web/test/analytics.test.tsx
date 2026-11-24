import React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Chart } from "../src/analytics";

test("grouped analytics charts expose each group count to assistive technology", () => {
  const html = renderToStaticMarkup(React.createElement(Chart, {
    insights: {
      x: "stateGroup",
      groupBy: "label",
      buckets: [{
        key: "started",
        label: "In Progress",
        count: 2,
        groups: [
          { key: "bug", label: "Bug", count: 2 },
          { key: "ux", label: "UX", count: 1 },
        ],
      }],
    },
  }));

  expect(html).toContain('aria-label="Started: 2"');
  expect(html).toContain('class="sr-only">Group by: Bug: 2, UX: 1</span>');
});
