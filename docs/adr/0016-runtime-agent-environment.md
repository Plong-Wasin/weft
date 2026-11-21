# Runtime owners configure per-Agent CLI environments

Runtime owners may set environment variables for an Agent bound to their Runtime. This supports selecting a pre-existing CLI configuration such as Claude Code's `CLAUDE_CONFIG_DIR`, or supplying provider credentials such as `ANTHROPIC_API_KEY`. Weft does not provision or manage provider accounts.

The whole variable map is sealed with AES-256-GCM before storage using the deployment secret, and is excluded from ordinary Agent outputs, Run records, transcripts and audit values. Only the Runtime owner may replace, inspect the saved variable names, or clear it. The Daemon receives the decrypted map only with its Run claim and applies it after inherited provider values, while platform variables (including `WEFT_*`, `PATH`, `HOME` and XDG paths) remain protected. CLI output is redacted against configured values before it is stored or returned.

An explicitly selected configuration is authoritative. Claude Code's own `CLAUDE_CONFIG_DIR` controls which configuration directory it uses; an empty or invalid directory must fail authentication rather than consult the Runtime owner's default account. An explicit provider API key takes precedence over the inherited API key and a stored CLI login. Unconfigured Agents keep the previous inherited-environment behavior.

The environment map is hashed without storing its values on each Runtime Run. If the hash changes, the next Run starts a new Claude Session while reusing the same stable work folder (ADR 0014). Moving or unbinding an Agent clears its Runtime environment, so the old Runtime's credentials do not transfer.

The Runtime still uses the sandbox profile selected for each Run (ADR 0011). Configuring credentials or a Claude directory does not loosen that profile. If a required sandbox cannot start, the Run fails closed.
