import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/ui/button";

test("Button preserves native button semantics and maps the four migration variants", () => {
  const html = renderToStaticMarkup(<>
    <Button type="button" aria-label="Primary action" variant="primary">Save</Button>
    <Button className="secondary" disabled>Cancel</Button>
    <Button className="ghost">More</Button>
    <Button className="bg-transparent">Quiet</Button>
    <Button className="danger">Delete</Button>
    <Button className="h-10 rounded-md bg-accent-primary px-3 text-14 font-medium text-on-color">Legacy primary</Button>
    <Button>Submit by default</Button>
  </>);

  expect(html).toContain('<button type="button"');
  expect(html).toContain('aria-label="Primary action" class=');
  expect(html).toContain('>Submit by default</button>');
  expect(html).toContain('<button type="submit"');
  expect(html).toContain("bg-primary text-primary-foreground");
  expect(html).not.toContain("bg-accent-primary");
  expect(html).toContain("border-input bg-background");
  expect(html).toContain("hover:bg-accent hover:text-accent-foreground");
  expect(html).toContain(">Quiet</button>");
  expect(html).toContain("bg-destructive text-destructive-foreground");
  expect(html).toContain("disabled=\"\"");
});
