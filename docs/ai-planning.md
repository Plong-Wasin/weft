# AI planning: operations, trust boundary and exit-gate record

Weft's AI proposes and a person approves ([ADR 0003](adr/0003-ai-proposes-human-approves.md)).
Nothing the AI reads is an instruction, and the AI has no write, approve, shell or file tool.
This page covers running it, what it can reach, how to back it up, and what has and has not
been verified. Provider and CLI details are in [provider-adapters.md](provider-adapters.md);
connection administration is in [ai-connections.md](ai-connections.md).

## Install and pair a runner

A runner is a small outbound-only program (`weft-runner`) that executes provider jobs on a
machine you trust. It listens on no port.

1. Set the server's signing key (a secret seed of at least 32 bytes) before starting Weft:
   `WEFT_AGENT_SIGNING_KEY`. Keep it out of the database and away from runners. Set
   `WEFT_AI_CREDENTIAL_KEY` too when API credentials are stored (see ai-connections.md).
2. A Workspace admin creates a connection (`POST /api/v1/ai/connections`) and chooses it as a
   default (`PUT /api/v1/ai/defaults`). A Workspace connection is granted to its Workspace on
   creation; a personal connection is visible only to its owner.
3. On the connection, create a pairing code (`POST
   /api/v1/ai/connections/:id/runners/pairing-codes`). The code is single use and expires.
4. On the runner machine, pair once and then run:

   ```
   weft-runner pair --origin https://weft.example.com --code <code> --store-root /var/lib/weft-runner [--scope personal|global]
   weft-runner run  --store-root /var/lib/weft-runner --runner-id <id> [--scope personal|global]
   ```

   Plain HTTP is accepted only for loopback development. The runner does not follow redirects.
   The store holds the runner token and is keyed by scope and runner ID with restrictive file
   permissions.
5. Revoke a runner (`POST /api/v1/ai/runners/:id/revoke`) or disable or revoke its connection
   to stop it. Disabling a connection cancels its leased runs and notifies the initiators.

The runner currently supports only the `scripted` mode. Codex and Claude Code modes are
present but disabled (see "Supported providers" below).

## Trust boundary

- The machine that holds the runner token and any provider credentials is the trust boundary.
  Pair only on a machine or isolated container you trust. Do not mount a host home, SSH
  directory, secret directory or Docker socket into it.
- Jobs are typed JSON with an Ed25519 signature from the server; the runner verifies the
  signature first. Shell commands are not a job type.
- Access is the requester's own Project and Vault membership, intersected with the run scope
  and the connection's grants, and checked again on every tool call and at apply time. A
  connection grant or an assignment never grants access to a Project or Vault.
- The model reaches Weft only through read tools and propose tools. Every read result is
  labelled `untrusted_data` with its source; Task, comment, note and attachment text is data and
  cannot change tools, scope, owner or provider. There is no approve or apply tool: approval
  needs a signed-in user session, and neither a runner token nor an MCP token is a session.
- Every Proposal is validated by the server against a versioned schema (ceilings on items,
  edges and text, scope, access, cycles, dangling edges, expected versions) before a person
  sees it, and again when it is approved.
- External MCP clients (`/api/v1/mcp`) use a per-user token with capabilities `read`,
  `generate`, `split`, `link`. The token's effective permission is the user's access
  intersected with its capabilities. Tokens are shown once and stored hashed, can be revoked,
  and are rate limited per token.

## What data goes to which provider

| Provider mode | What is sent | Where it goes |
| --- | --- | --- |
| `scripted` (tests, development) | Nothing leaves the runner machine. | A fresh empty directory on the runner. |
| Codex CLI, Claude Code CLI | Disabled in this build. When enabled: the job prompt and the labelled results of scoped Weft tool calls for that requester. | The provider account signed in on the runner (subscription) or the API key configured for the connection (API billing). |
| MCP client | Whatever the client's own model receives from tool results the user could already read. | The client's provider, outside Weft's control. The user, not Weft, chooses it. |

Weft connection secrets, runner tokens, other users' context, host files and provider
credentials must not enter provider requests. Weft never stores provider passwords or CLI
credentials. A connection never switches silently between subscription and API billing or
between provider accounts. Attachments are not readable by any AI tool. The usage dashboard
stores aggregated usage attributed to users, without prompt or Task content.

## Supported providers and CLI versions

| Provider | CLI versions | Smoke result |
| --- | --- | --- |
| Codex CLI | None claimed | Not run. |
| Claude Code CLI | None claimed | Not run. |
| Scripted (fake) | n/a | Automated tests only; not a provider smoke check. |

No combination of provider, plan and CLI version is claimed as supported. Both CLI adapters
stay disabled until the runner enforces a Weft-only tool bridge and a person completes the
checklist in provider-adapters.md for a named version. The fake-CLI tests check argument
construction, parsing, error mapping and timeouts only.

## Backup and restore of AI data

`weft backup <archive.tar.gz>` turns maintenance mode on, prunes AI records past the retention
window (`WEFT_AI_RETENTION_DAYS`, default 365), and writes `pg_dump --format=custom` plus
attachments, Vaults, config and an inventory. AI runs, Proposals, approvals and audit travel
within the retention window. These tables keep their structure but never their rows:
`ai_connection_credentials` and `ai_runner_pairing_codes` (dumped with
`--exclude-table-data`). Provider credentials, pairing codes and `WEFT_AI_CREDENTIAL_KEY` /
`WEFT_AGENT_SIGNING_KEY` are re-created or supplied again on the new installation; keep both
keys in a separately protected secret backup. Runners must be re-paired after a restore to a
new installation.

`weft restore <archive>` restores a dump; `weft drill <archive>` extracts an archive, refuses
it if its dump lists a `TABLE DATA` entry for either secret table, and compares the
inventory with the live database. Run `weft maintenance off` after verification.

The dump listing format was checked against a real PostgreSQL 16.15 `pg_dump` and
`pg_restore --list` (inside the shared test container, in a temporary database that was
dropped afterwards): with the two exclusions the secret tables appear only as
`TABLE public <name>` lines and no `TABLE DATA` line, and without them each has a
`TABLE DATA public <name>` line. That is the format the drill parses; the captured listing is
the fixture in `crates/weft-cli/tests/ai_backup.rs`. The `weft backup` and `weft drill`
commands themselves were not run against a real database on a host with the client tools
installed (see the checklist).

## Automated exit-gate coverage

- Hostile Task, comment, note and attachment text through the web run path and through the MCP
  endpoint: `crates/weft-server/tests/ai_exit_gate.rs`. The tests check that every reply is
  labelled data, that no approve, apply, shell, update or provider tool exists, that a
  Restricted Project, a Project outside the run scope and an unreadable Vault stay unreachable,
  that attachments never appear in a reply, and that owner, provider, scope, Tasks and tokens
  are unchanged afterwards.
- Core latency while the provider hangs, is rate limited or the runner is offline: the same
  file. Create, list and read Task and the readiness check each stay under 2 s. This is a
  coarse regression guard on a developer machine, not a performance commitment.
- Keyboard-only desktop journey and phone-viewport journey in a real browser:
  `apps/web/ai-exit-gate.e2e.test.mjs`. The desktop journey connects team AI through the admin
  API, opens Team AI from Settings by keyboard, generates, renames and rejects rows, approves,
  reads the attributed history through the API and undoes the group. The phone journey reviews
  and approves with the keyboard in a 390 px viewport and checks that every review control is
  at least 44 by 44 CSS pixels (checkboxes measured by their label).
- Existing suites cover scoped reads, proposal validation, fairness, rate limit, needs login,
  attribution and group undo, MCP scoping and backup.

## Known limits

- Stale detection (Split and Link) compares `tasks.updated_at` with the run's `created_at`:
  any later change to a Task marks its items stale, not only changes to fields the item
  touches.
- MCP reads are not recorded as Proposal sources, so a Proposal made through MCP shows its
  proposed sources but not the Tasks and notes the client read.
- Connection credential rotation is tested; revoking a connection mid-run is covered through
  disable and through access loss, not through the `revoke` endpoint itself.
- The web app has no Task history panel. Attribution is exposed by the history API and
  checked there.
- Only the scripted provider can run. All provider-specific behaviour (sign-in, tool
  restriction, structured output, rate-limit and expiry) is untested against real CLIs.
- Latency ceilings were measured on a tiny dataset, not the reference machine or data volume.
- A bug found while writing the exit-gate tests: starting a run with a Vault in its scope
  queried a table that does not exist and returned HTTP 500. It now uses the Vault access
  evaluator, and the web-path test covers it.

## What was and was not run for this gate

Run: the Rust gates (`cargo fmt --check`, `cargo clippy --locked --all-targets -- -D
warnings`, `cargo test --locked`), `pnpm build`, and `pnpm test:e2e` on the final tree; the
real `pg_dump` and `pg_restore --list` listing check described above.

Not run: every item below. They need real providers, accounts or devices and stay unchecked
for a person to run. Record CLI version, plan, runner OS, device and date beside each result.

### Manual checklist

- [ ] Codex CLI, per version and plan: the six items in provider-adapters.md.
- [ ] Claude Code CLI, per version and plan: the six items in provider-adapters.md.
- [ ] Real-device phone check on iOS Safari and Android Chrome: sign in, open Generate with
  AI, review a plan, approve with a thumb, undo; confirm targets are comfortable and the
  on-screen keyboard does not cover Approve.
- [ ] Real `weft backup`, `weft restore` and `weft drill` against a database with the
  PostgreSQL client tools installed, then confirm no credential rows in the restored database.
- [ ] Pair a real runner on a separate machine over HTTPS and run a job end to end.
- [ ] Connect one real MCP client (Claude or Codex) with a token, read and propose, and confirm
  the person must still approve in the web app.
