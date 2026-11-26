import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/ui/button";

test("Button preserves native button semantics and takes its variant from the prop only", () => {
  const html = renderToStaticMarkup(<>
    <Button type="button" aria-label="Primary action" variant="primary">Save</Button>
    <Button disabled>Cancel</Button>
    <Button variant="ghost">More</Button>
    <Button variant="danger">Delete</Button>
    <Button>Submit by default</Button>
  </>);

  expect(html).toContain('<button type="button"');
  expect(html).toContain('aria-label="Primary action" class=');
  expect(html).toContain('>Submit by default</button>');
  expect(html).toContain('<button type="submit"');
  expect(html).toContain("bg-primary text-primary-foreground");
  expect(html).toContain("border-input bg-background");
  expect(html).toContain("hover:bg-accent hover:text-accent-foreground");
  expect(html).toContain("bg-destructive text-destructive-foreground");
  expect(html).toContain('disabled=""');
});

test("Button keeps the caller's utilities, which win over the variant's", () => {
  const html = renderToStaticMarkup(<Button className="rounded-lg px-3 py-1 text-13">Quiet</Button>);

  for (const name of ["rounded-lg", "px-3", "py-1", "text-13"]) expect(html).toContain(name);
});
