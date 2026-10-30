# Provider adapters

## Support status

The runner currently enables only the `scripted` mode. Codex and Claude Code adapter
implementations are present behind an explicit unsupported result; no CLI version or plan
combination is claimed as supported. The fake CLI tests verify argument construction,
structured output parsing, error mapping, and timeout handling, but do not count as provider
smoke checks.

The runner has not yet implemented a local MCP bridge for the run-scoped Weft tools. Claude
Code can be started in print mode with its tool list empty and strict MCP configuration, but
that leaves it unable to call Weft's tools. Codex read-only sandboxing still leaves Codex's
local agent tools available, so it cannot be reduced to only Weft's scoped tools. Both modes
therefore stay disabled in the runtime. Enabling either requires a runtime enforced Weft tool
bridge, a fresh empty per-job directory, no host hooks or configuration, and a completed
smoke checklist below.

## Authentication and data boundary

Authentication choices are separate connection modes: **subscription sign-in** uses the
provider account signed in on the runner; **API key billing** uses that provider's API key.
Weft does not store provider passwords or CLI credentials. Credentials belong in the
scope-specific runner credential store on the machine that runs the CLI. A connection never
silently switches between subscription and API billing or between provider accounts.

The machine holding provider credentials is the trust boundary. When enabled, the runner
would send the job prompt and the labelled results of scoped Weft tool calls to the selected
provider. Weft connection secrets, runner tokens, other users' context, host files, and
provider credentials must not enter those requests. Provider usage is reported only when the
CLI returns it; absent usage remains unknown.

## Declared CLI support

| Provider | CLI versions | Plans / billing modes | Runtime state |
| --- | --- | --- | --- |
| Codex CLI (`codex`) | None claimed | None claimed | Disabled: scoped tools are not enforceable with the current runner bridge |
| Claude Code CLI (`claude`) | None claimed | None claimed | Disabled: no Weft scoped-tool MCP bridge is configured |

## Manual smoke checklist

Leave each item unchecked until it is run against the named provider CLI version and plan.
Record the exact CLI version, plan, runner OS, and date alongside completed results. Passing
one combination does not imply support for other versions or billing modes.

### Codex CLI — version: __________; plan/billing: __________; runner OS: __________; date: __________

- [ ] Subscription sign-in succeeds using the runner's isolated credential store.
- [ ] API key authentication succeeds separately and is labelled API key billing.
- [ ] The model can call only Weft's run-scoped read and propose tools; shell, filesystem,
  MCP configuration, and host hooks are unavailable.
- [ ] Structured output is parsed and a valid Proposal is returned.
- [ ] Rate limiting pauses the run with a bounded retry delay.
- [ ] Expired sign-in changes the run and connection to needs login.

### Claude Code CLI — version: __________; plan/billing: __________; runner OS: __________; date: __________

- [ ] Subscription sign-in succeeds using the runner's isolated credential store.
- [ ] API key authentication succeeds separately and is labelled API key billing.
- [ ] The model can call only Weft's run-scoped read and propose tools; shell, filesystem,
  MCP configuration, and host hooks are unavailable.
- [ ] Structured output is parsed and a valid Proposal is returned.
- [ ] Rate limiting pauses the run with a bounded retry delay.
- [ ] Expired sign-in changes the run and connection to needs login.
