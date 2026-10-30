# AI connections

AI connection metadata is managed under `/api/v1/ai/connections`. Workspace and
installation connections are visible only to granted users; personal connections
are visible only to their owner. Connection grants do not grant Project or Task
access. Default resolution is the user's personal choice, the Workspace default,
then the installation default. The defaults endpoint returns the selected
provider, billing mode, state, reason, and a `run_notice` suitable for display
before a run starts.

## Encrypting API credentials

Set `WEFT_AI_CREDENTIAL_KEY` in the server's secret environment before accepting
API credentials. The value must be a 32-byte key encoded as 64 hexadecimal
characters (or exactly 32 raw bytes). Generate and store it outside PostgreSQL,
for example in the deployment's secret manager. Keep the same key available to
every server instance that reads these credentials, and include it in the
separately protected secret backup. Do not put it in `DATABASE_URL`, a database
table, a checked-in config file, or a log.

The server encrypts each API credential with ChaCha20-Poly1305 and binds the
ciphertext to its connection ID. The API returns only a `has_credential` flag.
Rotating a credential replaces the encrypted value and creates an audit event;
revoking a connection removes the encrypted value, disables the connection,
and creates an audit event. The audit log is separate from Task operations and
cannot be removed by Task undo.

Provider credentials held by a runner should be referenced by the connection,
not copied into its API credential field. A connection with a runner reference
shows `runner_offline` until runner state is supplied by the runner service.
