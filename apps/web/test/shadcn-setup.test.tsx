import React from "react";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { cn } from "../src/lib/utils";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "../src/ui/tooltip";

test("cn merges conflicting Tailwind classes while retaining conditional classes", () => {
  expect(cn("rounded-sm px-2", false && "hidden", "rounded-lg px-3")).toBe("rounded-lg px-3");
});

test("shadcn light and dark theme tokens use their own defaults without overriding legacy text utilities", () => {
  const tokens = readFileSync(join(import.meta.dir, "../src/tokens.css"), "utf8");
  const style = readFileSync(join(import.meta.dir, "../src/style.css"), "utf8");

  expect(tokens).toContain("--background: oklch(1 0 0)");
  expect(tokens).toContain("--background: oklch(0.145 0 0)");
  expect(tokens).toContain("--radius: 0.625rem");
  expect(tokens).not.toContain("--background: var(--bg-canvas)");
  expect(style).not.toContain("--color-secondary: var(--secondary)");
});

test("Tooltip proof component renders an accessible trigger and composes its content", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<button type="button" aria-label="Helpful detail">Help</button>} />
        <TooltipContent>Helpful detail</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  const portal = TooltipContent({ children: "Helpful detail" }) as React.ReactElement<{ children: React.ReactNode }>;
  const positioner = portal.props.children as React.ReactElement<{ children: React.ReactNode }>;
  const popup = positioner.props.children as React.ReactElement<{ children: React.ReactNode; className: string; "data-slot": string }>;

  expect(html).toContain("Help");
  expect(html).toContain('data-slot="tooltip-trigger"');
  expect(html).toContain('type="button"');
  expect(html).toContain('aria-label="Helpful detail"');
  expect(popup.props["data-slot"]).toBe("tooltip-content");
  expect(popup.props.children).toBe("Helpful detail");
  expect(popup.props.className).toContain("bg-primary");
});
