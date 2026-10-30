# ADR-0005: Serve Vault HTML only through a locked route

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

Knowledge can contain Markdown with embedded HTML and standalone `.html` pages. The product uses one public origin, and a Vault page may contain untrusted JavaScript. Serving it as a normal app document could expose app capabilities or credentials to that content.

## Decision

Sanitize inline HTML in Markdown with a server-side allowlist and remove scripts, event handlers, unsafe URLs, and active embedding elements. Serve standalone Vault `.html` files only through a dedicated permission-checked route with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'` and `X-Content-Type-Options: nosniff`. Do not allow network-loaded scripts, styles, or images: `self` would permit a sandboxed page to issue requests to any same-origin Vault route. Display the page in an iframe with `sandbox="allow-scripts"` only; do not allow same-origin access, forms, popups, or top navigation. Apply the same response restrictions when the route is opened directly. Pages can include images as data URLs. This reduces risk but does not guarantee isolation from every browser exfiltration path.

## Alternatives considered

- **Serve Vault HTML as a normal Weft page on the app route.** Rejected because untrusted page scripts would share the trusted app document context.
- **Serve raw HTML without a locked route or iframe sandbox.** Rejected because scripts and embedded content could access browser capabilities without the intended restrictions.
- **Strip all HTML and reject standalone `.html` pages.** Rejected because sanitized HTML in Markdown and interactive standalone pages are part of the Knowledge requirements.
- **Use a separate origin as the sole isolation measure.** Rejected because the product requires one public origin; the route, response CSP, and iframe sandbox provide the specified boundary within that origin.

## Consequences

All ways to view a Vault `.html` file must use the locked route, and every request must check Vault membership. The server-side parser is the single sanitizer for Markdown HTML. Browser tests must verify the actual sandbox and headers; CSP and iframe sandboxing reduce risk but are not a complete guarantee.
