# HTML sandbox browser spike

This harness exercises the sandbox decision in ADR-0005 on one origin. It is a spike fixture, not a Vault implementation: it has no Vault membership check or real Knowledge asset route. The fixture seeds app cookies, embeds an active page from `/vault-pages/spike.html`, and exposes a second local origin plus a local UDP STUN listener to observe attempted egress.

## Run

```sh
pnpm install
pnpm exec playwright install chromium firefox webkit
pnpm test
```

On Linux, install the system libraries required by Playwright's browsers. `browser.test.mjs` reports a browser as skipped if its executable cannot launch; a cross-browser run is complete only when all three browser tests execute.

## Findings

Tested with Playwright 1.56.1 and Chromium 155.0.8059.12, Firefox 142.0.1, and WebKit 26.0 on Linux. The matrix uses the final response policy, including an explicit app origin in `img-src`.

| Probe | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Read app cookies from script | Blocked with `SecurityError` | Blocked with `SecurityError` | Blocked with `SecurityError` |
| Read parent document | Blocked with `SecurityError` | Blocked with `SecurityError` | Blocked with `SecurityError` |
| Send `postMessage` to parent | Succeeds | Succeeds | Succeeds |
| Fetch app API (`connect-src 'none'`) | Blocked; no request sent | Blocked; no request sent | Blocked; no request sent |
| Fetch to another origin | Blocked; no request reached the listener | Blocked; no request reached the listener | Blocked; no request reached the listener |
| Same-origin image | Loaded; request reached app route without cookies | Loaded; request reached app route without cookies | Loaded; request reached app route **with both seeded app cookies** |
| Cross-origin image | Blocked; listener received no request | Blocked; listener received no request | Blocked; listener received no request |
| Submit form to another origin | Blocked by `form-action`; no request | Blocked by `form-action`; no request | Blocked by `form-action`; no request |
| WebSocket to another origin | Blocked; no request | Blocked; no request | Blocked; no request |
| `window.open` | Blocked | Blocked (`InvalidAccessError`) | Blocked |
| Top-window navigation from iframe | Blocked with `SecurityError` | Blocked with `SecurityError` | Blocked with `SecurityError` |
| WebRTC/STUN | UDP reached local STUN listener | UDP reached local STUN listener | UDP reached local STUN listener |
| DNS prefetch | Attempted for reserved `.invalid` name; lookup itself not observable in browser harness | Same | Same |

The same-origin image result changed during the spike. With the planned `img-src 'self' data:`, Chromium and Firefox loaded the app image, while WebKit blocked it because the sandboxed document has an opaque origin. The response was changed to use the exact app origin in `img-src`; all three engines then loaded the same-origin image and blocked the cross-origin image. WebKit attached the seeded session and CSRF cookies to that image request even though script cookie access failed. Asset routes therefore must remain membership-checked, read-only GETs and must not redirect across origins.

WebRTC is an actual egress path: every engine sent STUN traffic to the local UDP observer despite the CSP. This proves the policy does not block WebRTC; it does not establish which arbitrary payloads an attacker can encode. The DNS prefetch declaration was exercised, but this harness cannot tell whether the browser or OS resolver performed a DNS lookup. Network-level DNS capture is required to settle that question. Directly opening `/vault-pages/spike.html` retained the response CSP and `nosniff`; scripts still could not read cookies or call the API, and could not open windows. There is no parent frame in a direct tab, so parent navigation is not an applicable boundary; the document can navigate its own top-level tab.

One acceptance phrase needs a limit: the frame cannot read or navigate its parent, but all three browsers deliver a sandbox page's `postMessage` event to the parent. The parent must not trust messages from the untrusted frame or expose a command listener to it.

## Spec adjustment

Updated product spec v0.4 §10 to use the exact application origin in `img-src`, record WebKit's automatic cookie attachment on same-origin image requests, and require same-origin asset routes to be safe GETs without cross-origin redirects. The existing warning about WebRTC and DNS prefetch remains: this sandbox reduces browser capabilities but does not guarantee zero egress.

Ticket 17 acceptance: the route/frame, direct-route lockdown, and all requested browser/channel attempts are implemented and measured. Parent DOM reads and top navigation are blocked, but the stronger interpretation that no message can reach the parent is impossible with this sandbox: `postMessage` succeeds in all three engines; this limitation and required parent behavior are recorded above. DNS resolution remains unobservable in this browser-level run and is recorded as an unresolved measurement, not as a successful block.

## Verification

- `pnpm test`: 5 passed, 0 failed, 0 skipped (2 HTTP contract tests and 3 browser tests).
- `cargo fmt --check`: passed.
- `cargo clippy --locked --all-targets -- -D warnings`: passed.
- `cargo test --locked`: 27 passed, 0 failed before the fast-forward merge. The first parallel run had two `projects_acl` setup failures while concurrent servers were migrating; rerunning the same full command passed all tests without code changes. A full suite rerun after merge was omitted per the coordinator's disk-space instruction; `fmt`, clippy, and build were rerun after merge.
- `pnpm build`: passed. The generated `apps/web/dist` was removed before the final Rust suite.
