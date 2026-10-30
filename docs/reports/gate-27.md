# Gate report

## Run record

- Branch: `feat/weft-alpha-1-knowledge-and-proposals`
- Tested commit: `eba89e2` (after seven review rounds of the branch; the last returned `ship`).
- Rust: `cargo fmt --check` passed; `cargo clippy --locked --all-targets -- -D warnings` passed; `cargo test --locked` passed 113 tests, 0 failed.
- Web: `pnpm build` passed; `pnpm test:e2e` passed 4 tests, 0 failed, 0 skipped (keyboard/palette/undo/Thai IME journey; mobile shell with offline write feedback; service worker never serves authenticated API data after sign-out; revoked session clears the app on its next 401).
- Not run: `container-smoke.yml` and `ci.yml` on GitHub, a real backup/restore on a Compose deployment.

## Ticket acceptance

- [ ] **Keyboard-only desktop journey:** partly met. Workspace switching, Status and Attribute management, the Settings screen (sessions list and revoke) and sign-out now exist (ticket 28) and `apps/web/keyboard.e2e.test.mjs` asserts their outcomes after a reload. The journey is still headless Chromium and still sets up its Project through the API, so a person must run the full route in a real browser (see human checks).
- [ ] **Mobile journeys focus-complete with a Bluetooth keyboard:** unmet. The phone-viewport E2E now reaches Knowledge, searches notes, opens a result and follows a rendered note link with keyboard focus and Enter. It does not establish completeness across all mobile journeys or test a physical Bluetooth keyboard; a person must do that check.
- [ ] **History/undo table:** unmet. `tasks_history.rs`, `review_fixes.rs`, `customization.rs`, `lists.rs` and `proposals.rs` cover status undo/redo, same-actor compaction and no-ops, interleaved actors, atomic bulk undo, custom-attribute changes, and Proposal group undo. This gate adds an API integration assertion that custom-select Small→Large→Small compacts out of visible task history. The spec row for undoing a Description that adds a task reference and removing its backlink remains unverified because task-reference/backlink support is not present in this checkout.
- [x] **Proposal schema, atomic creation, retry safety and group undo:** met by `crates/weft-server/tests/proposals.rs` (3 integration tests passed), including revision-scoped idempotent approval retries, group undo of created tasks/Skill/schema changes, and all-or-nothing conflict behavior.
- [x] **Vault, Team and Project-member access; search/count leak checks:** met by `vaults_membership.rs`, `teams_assignees.rs`, `projects_acl.rs` and `comments_search_export.rs` (16 relevant integration tests passed across those files). Tests cover direct, Team and Project grants, Workspace Viewer ceilings, restricted Project search/count filtering, and Knowledge search filtering by caller access.
- [ ] **Clean install and upgrade on one origin; backup/restore drill:** unmet as a full gate. The single-origin API integration test and generated restore-drill test passed (`single_origin.rs`, `restore_drill.rs`). I did not run the `container-smoke` Compose workflow or an actual backup, clean-container restore and post-restore drill: worker instructions prohibit starting another Compose/Postgres stack because it risks the shared database and other terminals. Compose configuration itself parsed successfully.
- [ ] **Spike and benchmark findings in docs, with spec updates where reality differs:** unmet as a complete checkbox. Existing evidence is recorded in `docs/spikes/git-lfs.md`, `docs/research/markdown-thai-search.md`, `spikes/html-sandbox/README.md` and `docs/benchmarks/ceilings.md`. Benchmark ticket 26 remains explicitly partial and was not redone. The product spec under `.scratch` was not editable in this worktree, so the suggested changes below are recorded instead of applied.
- [x] **Short report of failures and skips:** met by this document.

## Human checks still open

- [ ] Run the complete desktop keyboard journey in a supported real browser, including Workspace selection, Project/task creation and editing, comments, view changes, bulk edit, Undo/Redo, search, Status/Attribute management, Settings and sign-out (these screens exist now; the check is the human run).
- [ ] Run the complete phone journeys on a physical phone with a Bluetooth keyboard, including the Knowledge reader at phone width.
- [ ] Run the HTML sandbox checks in real Chromium, Firefox and WebKit for this candidate and review the results; the spike README records an earlier three-engine run, not a run of this candidate.

## Failures, skips and limits

- No required automated gate failed. Two exploratory versions of the new custom-select test failed because the fixture began at `null`, which was not the spec’s X→Y→X sequence; the corrected fixture seeds X, verifies both API writes, and passes in the final suite.
- The desktop and phone human checks, real-browser checks, container smoke workflow, clean-container upgrade, and actual backup/restore were skipped for the reasons above.
- The backup/restore drill evidence is the generated `weft-cli` drill test, not a production-shaped deployment archive restored into a clean installation.
- The Git/LFS spike did not inject an interrupted transfer, and its constrained-write simulation is not an actual filesystem-full event. The HTML sandbox evidence records successful `postMessage` delivery and WebRTC/STUN egress in all tested engines, WebKit attaching cookies to same-origin image requests, and DNS lookup remaining unobservable. The benchmark log still lacks the reference-machine dataset, end-to-end Vault Proposal apply, capacity measurements and evidence-based defaults.

## Spec changes to carry forward

The following changes need review in the product spec; this gate did not edit `.scratch`:

- The Workspace switcher, Status/Attribute management, Settings and sign-out screens now exist. Whether the UI needs a Project member-management screen for this gate stays a spec question.
- Keep the History/Undo claim conditional until task-reference/backlink behavior exists and the Description-undo case is tested. The custom-select compaction example is now covered through the task API.
- Carry forward the HTML-sandbox limits: the parent must ignore untrusted frame messages, same-origin assets must remain permission-checked safe GETs without cross-origin redirects, WebRTC is not blocked, and browser-level DNS behavior is unknown.
- Do not treat the current Git timing, small API fixtures or validation-size constants as recommended performance ceilings. The spec-sized workload and reference machine measurements remain outstanding; benchmark ticket 26 lists the missing cases.
- Record that interrupted Git/LFS import and a real filesystem `ENOSPC` event were not fault-injected; current staging/retry and recovery guidance is reasoned from the tested boundaries.
