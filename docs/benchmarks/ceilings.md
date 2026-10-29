# Proposal and Knowledge ceilings: benchmark log

This log records the reproducible prepared-git-merge measurement available in
this checkout. It is evidence for the primitive only; it is not an application
ceiling recommendation.

## Prepared git merge primitive

Run `scripts/benchmarks/git-merge-tree.sh` from the repository root. It creates
throwaway repositories with clean, non-overlapping proposals, then times
`git merge-tree --write-tree <base> <proposal>` 101 times per case. The command
includes process startup and output is discarded. The first call warms the
OS/Git caches; all reported samples are therefore warm-cache. The generator
changes one short line in each Markdown file. There are no concurrent clients
and no errors across 303 runs. The script reports median, p95, minimum and
maximum wall time; `RUNS` changes the number of repetitions.

Observed on 2026-10-30, using Git 2.43.0, Linux x86_64, AMD Ryzen 5 5600H
(6 cores / 12 threads), 27.3 GiB host memory, local NVMe workspace storage:

| Files changed | Git diff bytes | Runs | Median | p95 | Min–max | Errors |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 161 | 101 | 1.645 ms | 1.797 ms | 1.416–1.937 ms | 0 |
| 10 | 1,615 | 101 | 1.648 ms | 1.819 ms | 1.442–2.104 ms | 0 |
| 100 | 16,560 | 101 | 1.638 ms | 1.799 ms | 1.431–1.971 ms | 0 |

The small cases are dominated by Git process startup and do not establish a
useful maximum Proposal size. These results also do not measure Postgres apply,
Vault locking, LFS, or end-to-end apply latency. The host is not the spec's
4-vCPU / 8-GB reference machine, and this synthetic workload does not use the
spec's Task/Comment dataset.

## Existing enforced size limits

These values are implementation constraints, not performance-derived ceilings:

- Archive upload request body: 50 MiB (`crates/weft-server/src/vault_import.rs`).
- Archive expanded size per entry: 50 MiB; total expanded archive: 512 MiB.
- Skill name, description and body settings default to 120, 300 and 16,000
  characters. The schema allows a Skill body setting up to 1,000,000 characters.
- Proposal item count and serialized/diff size have no explicit configured cap.
- Vault total size has no explicit configured cap.

## Measurements still required before defaults can be recommended

This checkout does not apply note/file Proposal items to git. The current
approval path only applies PostgreSQL Task, Skill and schema items, so an
end-to-end prepared Vault merge and apply-lock measurement cannot be produced
from this implementation. A valid recommendation also needs measurements of
Proposal item/diff size and PostgreSQL apply time; per-file and total Vault
size; archive import and full reindex time; indexed-note search latency on the
spec-sized reference dataset; and enabled Skill count/body-size effects.

For those measurements, use the reference machine (4 vCPU, 8 GB RAM, SSD),
record the actual Task/Comment/ledger and Vault distributions, cold and warm
cache runs, exact query shapes, concurrency and error rate. The current host
and code cannot support claims for those data points; this log deliberately
leaves them open rather than treating existing validation limits or tiny
synthetic merge timings as performance evidence.

## Implemented API-path smoke timings

The existing integration tests can exercise additional implemented paths without
changing production code. The durations below are Rust test-harness durations
reported by `cargo test`, so they include fixture setup, migrations, server
startup, assertions and cleanup. They are not endpoint latency figures. Each
case was run once with fresh test data on the same host and shared PostgreSQL
service described above; the service already had warmed OS/database caches.
The fixtures are intentionally tiny, and no request failed.

| Path / exact existing test | Fixture distribution and query shape | Elapsed | Errors |
|---|---|---:|---:|
| Archive import + reindex / `manager_can_import_a_vault_archive_and_observe_completion` | 3 visible files (2 Markdown, 1 four-byte PNG), hidden `.obsidian` settings; async archive upload, git/LFS import, index, status poll | 1.36 s | 0 |
| Knowledge search / `knowledge_search_returns_only_readable_vault_notes` | 3 indexed notes in 3 Vaults (user, Team and Project grants); Thai query, count + top-20 results and ACL filtering | 1.17 s | 0 |
| Vault ZIP export / `vault_viewer_downloads_audited_zip_with_resolved_lfs_content` | 1 Markdown file, 1 four-byte LFS binary, 1 hidden `.obsidian` file; audited export and extraction | 1.22 s | 0 |
| Knowledge reader / `reader_resolves_links_renders_safe_markdown_and_serves_lfs_files_and_history` | 6 tracked source files (Markdown, HTML and binary), duplicate basenames, links and an inaccessible Vault; render/read/history | 1.29 s | 0 |
| Task list/detail and task search / `task_numbers_conflicts_archive_restore_duplicate_and_acl_work_through_api` and `comments_are_idempotent_editable_and_search_respects_restricted_projects` | 2 Tasks; create, update, read, archive/restore/ACL flow; separate Thai title/comment/attribute search against 1 Task | 1.21 s / 1.17 s | 0 |

These checks establish that the current small fixtures complete, not p95 or
capacity. There is no 100k-Task / 500k-Comment data distribution, mixed load,
repeated endpoint sampling, 30-client run, or 4-vCPU / 8-GB run here. No
performance-derived per-Vault, Proposal, or Skill default should be inferred
from the timings above.

## Verification

- `cargo fmt --check`: passed.
- `cargo clippy --locked --all-targets -- -D warnings`: passed.
- `cargo test --locked`: passed, 71 tests, 0 failures (plus 0 unit and 0 doc tests).

## Ticket acceptance evidence

- [ ] Measured and recorded all requested maximum Proposal, file/Vault,
  import/reindex, reference-dataset search and Skill-count/size values. The
  available measurements above are partial; the remaining cases and reasons
  are listed in the preceding section.
- [x] Recorded workload distribution, cache state, query/operation shape and
  error count for every measurement included in this log.
- [ ] Proposed performance-derived configuration defaults with evidence. The
  tiny fixtures and unavailable end-to-end git apply path do not support such
  recommendations; existing validation constants are recorded separately.
- [x] Results and unmet measurements are recorded in this repository for the
  next specification.
