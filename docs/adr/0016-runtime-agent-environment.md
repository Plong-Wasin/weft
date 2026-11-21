# Runtime owners configure per-Agent CLI environments

Runtime owners may set environment variables for an Agent bound to their Runtime. This supports selecting a pre-existing CLI configuration such as Claude Code's `CLAUDE_CONFIG_DIR`, or supplying provider credentials such as `ANTHROPIC_API_KEY`. Weft does not provision or manage provider accounts.

The whole variable map is sealed with AES-256-GCM before storage using the deployment secret, and is excluded from ordinary Agent outputs, Run records, transcripts and audit values. Only the Runtime owner may replace, inspect the saved variable names, or clear it. The Daemon receives the decrypted map only with its Run claim and applies it after inherited provider values, while platform variables (including `WEFT_*`, `PATH`, `HOME` and XDG paths) remain protected. For Claude Runs with a configured `CLAUDE_CONFIG_DIR`, the Daemon suppresses an inherited host `ANTHROPIC_API_KEY` unless the Agent explicitly sets a non-empty key of its own.

Before storing CLI output, the Daemon reassembles stream chunks into complete lines and redacts exact configured values, their exact `JSON.stringify`-escaped forms, inherited Anthropic/OpenAI API keys, and the Run token. This catches literal echoes and JSONL echoes using the standard JSON.stringify representation, including when the encoded value crosses stream chunks. It does not catch alternate JSON escape spellings or arbitrary derived encodings, and the CLI process itself can read the credentials it receives.

An explicitly selected configuration is authoritative. Claude Code's own `CLAUDE_CONFIG_DIR` controls which configuration directory it uses; an empty or invalid directory must fail authentication rather than consult the Runtime owner's default account. A non-empty per-Agent `ANTHROPIC_API_KEY` intentionally takes precedence over the selected account's stored CLI login. If no per-Agent key is supplied, the inherited host key is suppressed so the selected account is used. Without a selected config directory, inherited API keys continue to work as before.

The environment map is hashed without storing its values on each Runtime Run. If the hash changes, the next Run starts a new Claude Session while reusing the same stable work folder (ADR 0014). Moving or unbinding an Agent clears its Runtime environment, so the old Runtime's credentials do not transfer.

The Runtime still uses the sandbox profile selected for each Run (ADR 0011). Configuring credentials or a Claude directory does not loosen that profile. If a required sandbox cannot start, the Run fails closed.
