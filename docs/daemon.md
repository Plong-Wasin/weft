# Daemon credentials and local exposure

## Start and stop the local Daemon

Run `weft daemon start` after `weft login`. It returns to the prompt while the Daemon runs in the background, registers the installed agent CLIs as Runtimes, and writes its log to `~/.config/weft/daemon.log` by default (or `$XDG_CONFIG_HOME/weft/daemon.log`). Use `weft daemon start --foreground` to keep it attached to the terminal while debugging. If `weft login` has not run yet, `weft daemon start` stops and tells you to run `weft login`.

Use `weft daemon status` to see whether it is running, its process ID, uptime, detected agent CLIs, signed-in server, and log path. Add `--json` for machine-readable output. Use `weft daemon stop` to stop the Daemon and its active Runs. A second start is refused while the process is running; stale records left by a crashed process are removed by status or the next start.

The Daemon folder (`~/.config/weft` by default) is created with owner-only permissions (`0700`). It holds:

- `config.json` (`0600`): the CLI settings and the Personal API token that `weft login` saved.
- `config.json.lockdb` (`0600`): a SQLite transaction lock used to serialize login and renewal across CLI processes. An interrupted transaction is released by the operating system.
- `daemon-credential.json` (`0600`): the Daemon credential, issued by the server at registration.
- `daemon.json` (`0600`) and `daemon.log` (`0600`): the process record and the log.

## Logs, restart and probe

- `weft daemon logs` shows the last 50 lines of the log. Any Weft token in a line (`weft_`, `weft_daemon_`, `weft_run_`) is shown as `[redacted token]`. Use `-n 200` for more, `--follow` (or `-f`) to keep showing new lines until you press Ctrl+C, and `--json` for `{"path", "lines"}`. `--json` cannot be combined with `--follow`.
- `weft daemon restart` stops a running Daemon and starts it again. It stops active Runs the same way `weft daemon stop` does. With autostart on, it restarts the autostart service instead. Add `--json` for the previous and new process IDs.
- `weft daemon probe` shows, for each agent CLI (`claude`, `codex`), whether it is ready and, if not, why: not found on PATH, the `--version` check failed, or it did not answer within 5 seconds. Add `--json` for machine-readable output. Run it after you install a CLI, then start or restart the Daemon so the CLI is registered.

## Start at login (autostart)

Autostart is off by default. Nothing starts the Daemon by itself until you run:

- `weft daemon autostart enable` writes a user-level unit and needs no administrator rights. On Linux it is a systemd user unit (`~/.config/systemd/user/weft-daemon.service`). On macOS it is a LaunchAgent (`~/Library/LaunchAgents/com.weft.daemon.plist`). It starts the Daemon now and at each sign-in, and restarts it after a crash.
- `weft daemon autostart disable` (also `off`) stops the autostart Daemon and removes the unit or agent file. `enable` also takes `on`.
- `weft daemon autostart status` (or `--json`) shows whether autostart is on.

Enable refuses while a background Daemon runs: run `weft daemon stop` first. While autostart is on, `weft daemon start` starts the service instead of a second background Daemon. The unit stores the PATH of the shell where you enabled it, so the agent CLIs are found, plus `WEFT_HOSTNAME`, `WEFT_API_URL` and `XDG_CONFIG_HOME` when they are set. It never stores a token. Run `weft daemon probe` after enabling to check the CLIs under that PATH. Other systems (Windows) do not have autostart yet.

## New version notice

`weft daemon start` and `weft daemon status` ask the Weft server for the newest CLI version (`GET /api/cli/version`). If a newer one exists, they print a notice. Weft never downloads or installs a new CLI by itself; the person installs it. The server reports the version in its `WEFT_CLI_LATEST_VERSION` environment setting, and reports nothing when that setting is empty. A failed or slow check (3 seconds) prints nothing.

**Each machine needs its own hostname.** The server keys a Daemon by its owner and hostname, so two machines with the same hostname share one Daemon row and lock each other out: each one's registration refreshes the credential the other is using. The hostname defaults to the computer's name. Set `WEFT_HOSTNAME` to a distinct name on each machine before `weft login` and `weft daemon start`, for example `WEFT_HOSTNAME=laptop-work weft daemon start`.

## Two credentials

**CLI credential transport and recovery.** Authenticated CLI requests, `weft login`, and automatic device-token renewal require HTTPS for remote Weft servers. HTTP is accepted for loopback development addresses (`localhost`, `127.0.0.0/8`, and `::1`). The CLI checks the URL before sending credentials and explains this requirement if a remote HTTP URL is selected. Existing explicit Personal API token authentication (`--token` or `WEFT_TOKEN`) remains supported with HTTPS. A bearer token sent over remote HTTP can be stolen. The browser URL and code remain visible in the terminal, and the browser must be able to reach the same Weft server.

If approval succeeds but the server response or local save is interrupted, the CLI keeps the previous config and a protected pending credential in `config.json`. The next `weft login`, CLI request, or Daemon registration retries finalization and promotes the new credential only after the server confirms it. The pending exchange must be finalized within the authorization request's five-minute lifetime; after it expires, the server revokes its unused credential and `weft login` must be run again. The worker also expires abandoned exchanges during its hourly cleanup, so cleanup does not depend on another login. Login and renewal operations sharing a config are serialized; a process crash releases the SQLite transaction lock automatically.

**The Personal API token** (`config.json`) is a normal token for CLI commands, the same kind as one you create in the web app. A token enrolled by `weft login` renews automatically while the device is active and requires sign-in again after 90 days without activity. Signing in again on the same machine replaces that device's credential after the new one is installed. The Daemon uses it only for registration, the call that registers the Daemon and its Runtimes.

**The Daemon credential** (`daemon-credential.json`) is a restricted token (prefix `weft_daemon_`). The server returns it once, when registration issues or rotates it. It reaches `/api/daemon/*` endpoints only: claiming Runs, status posts, the WebSocket, and stopping the Daemon. It is refused on `/actions`, and it cannot register again. It expires 30 days after issue. Every registration (about every 5 minutes) checks it: when less than 7 days remain, or when no active credential exists for this host, the server issues a new one and keeps the same Daemon and its Runtimes. A Daemon with no credential file asks for a new one.

**Rotation has a 10-minute grace period.** The previous credential is not revoked when a new one is issued. It keeps working for 10 minutes, so calls already in flight (a Run's status posts or its final result) finish, and then it is refused. Later registrations revoke rotated credentials whose grace has passed. If the Daemon crashes before it writes the new credential, the old one still works for the grace period, and the Daemon asks for a new one once it is refused.

**Rotation closes the WebSocket once.** The server closes the socket of a superseded credential (close code 4001) and the Daemon reconnects with the credential it adopted. Nothing else is needed.

**The Daemon recovers from a refused credential by itself.** When a `/api/daemon/*` call returns 401, or the WebSocket closes with code 1008, the Daemon asks for a new credential at its next registration, and logs the close code and reason to `daemon.log`. A Run's result is re-sent with the credential re-read from disk, so a single 401 does not lose it.

**When the Personal sign-in is refused**, registration returns 401 (the Personal token expired or was revoked). The Daemon writes a message to its log and to stderr telling you to run `weft login`, and keeps retrying with a backoff of up to 5 minutes. Run `weft login`; the Daemon picks up the new sign-in at its next retry.

**WebSocket credential transport.** Current Daemon versions send their restricted credential as `Authorization: Bearer <credential>` on the WebSocket handshake to `/api/daemon`; the URL contains no credential. The API authenticates that credential when the socket opens and again for each heartbeat, so expiry, rotation and revocation are enforced on an active connection. Current clients do not fall back to query authentication if the header is rejected.

For compatibility, the API still accepts `?token=...` from older Daemon versions. Those older clients expose the reusable credential in the request URL, which a reverse proxy or access log may record; the API's own request log records only the path, but cannot control logs at an upstream proxy. Upgrade old Daemons to a current CLI and configure upstream access logs to omit or redact query strings until those clients are retired. This compatibility path is temporary and does not weaken authentication or revocation checks; header authentication takes precedence whenever an Authorization header is present.

## What an Agent CLI can read

The Daemon starts each Agent CLI with an allowlisted environment: `PATH`, the locale and terminal variables, `HOME`, `XDG_CONFIG_HOME` and a few provider keys, plus the Run-specific `WEFT_*` values. The Daemon credential and every `WEFT_DAEMON_*` variable are never placed in that environment. The child receives the short-lived Run token as `WEFT_TOKEN`.

The environment is not a boundary for files. The Agent CLI runs as the same OS user as the Daemon, and `HOME` and `XDG_CONFIG_HOME` are passed on. It can therefore read `config.json` and `daemon-credential.json`, like any other file that user can read. The Daemon credential is refused on `/actions`, but a child that reads it can use it on the Daemon endpoints. A child that reads the Personal API token can call `/actions` as the owner, which the Run's Agent permissions do not limit. Until a sandbox exists, treat any Agent Run on a Runtime as able to act with the owner's full Weft access.

There is no OS sandbox per Run. An Agent CLI can use any file and network access available to its OS account on that computer. The credential split limits what a leaked Daemon credential can do to Weft; it does not limit local file or network access.

## Stable folders and resumed Sessions

A Run on a Runtime that has a work item works in a stable folder, not in a new temporary one. The folder belongs to one Agent, one work item and one Runtime, so the Runs of that Agent on that work item share it: round two finds the files round one wrote. The Daemon keeps these folders under `$XDG_CACHE_HOME/weft/sessions` (default `~/.cache/weft/sessions`). That path is outside `~/.config/weft`, which the sandbox denies reading. Each folder holds a small `.weft-session.json` file that records when it was last used.

Each Run also resumes the CLI's own Session, through the CLI's resume option (`claude --resume <id>`, `codex exec resume <id>`). A Run resumes only when the previous Run of the same Agent, work item and Runtime completed and reported a Session id. Otherwise it starts a new Session in the same folder. The Run page says whether the Run resumed a Session, or started a new one and why:

- `first`: the first Run on this work item.
- `previous_failed`, `previous_active`: the previous Run did not complete, or was still running.
- `no_session_id`: the previous Run finished without a Session id from the CLI.
- `runtime_changed`: the Agent now uses another Runtime, so the folder and Session are not shared.
- `rerun_as_new`: a person chose "Rerun as new session".
- `folder_missing`: the folder was removed, so the Session cannot be restored.
- `cli_rejected_resume`: the CLI refused the resume before it printed anything. The Run is retried once as a new Session and does not fail because of it.
- `cli_without_resume`: the CLI cannot resume a Session, so every Run starts a new one.

A Run on the Weft server never resumes a Session and never reads an earlier Run's transcript.

**Cleanup.** The Daemon removes a folder in two cases, and never a folder a Run is using:

- The work item is Done or Cancelled. After a Run finishes, the Daemon asks the server which of its folders belong to closed work items, and removes those.
- The folder has not been used for seven days.

The cleanup runs after a Run that used a stable folder finishes. A Daemon that stops running keeps its folders until its next such Run.

**Sandbox.** The sandbox settings are generated for every Run, as before. The Run's folder is the directory the sandbox allows for that Run; it is not a path a profile adds. A Session folder never lies outside that directory, and the Daemon never reads or writes a folder whose name is not a UUID.
