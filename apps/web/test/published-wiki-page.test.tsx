import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { setLocale, translate } from "@weft/shared";
import { PublishedPageStatus, publishedLoadState } from "../src/published-wiki-page";

test("only a 404 answer means the published page is missing", () => {
  expect(publishedLoadState(404)).toBe("missing");
  expect(publishedLoadState(500)).toBe("failed");
  expect(publishedLoadState(503)).toBe("failed");
});

test("each state renders translated text, loading as a status, failure with a retry control", () => {
  for (const locale of ["en", "th"] as const) {
    setLocale(locale);
    const loading = renderToString(<PublishedPageStatus state="loading" onRetry={() => {}} />);
    expect(loading).toContain('role="status"');
    expect(loading).toContain(translate("published.loading", locale));
    expect(renderToString(<PublishedPageStatus state="missing" onRetry={() => {}} />)).toContain(translate("published.notFound", locale));
    const failed = renderToString(<PublishedPageStatus state="failed" onRetry={() => {}} />);
    expect(failed).toContain(translate("published.loadFailed", locale));
    expect(failed).toContain("<button");
    expect(failed).toContain(translate("published.retry", locale));
  }
  setLocale("en");
  expect(translate("published.loading", "th")).not.toBe(translate("published.loading", "en"));
});
