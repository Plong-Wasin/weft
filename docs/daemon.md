# Daemon credentials and local exposure

## Start and stop the local Daemon

Run `weft daemon start` after `weft login`. It returns to the prompt while the Daemon runs in the background, registers the installed agent CLIs as Runtimes, and writes its log to `~/.config/weft/daemon.log` by default (or `$XDG_CONFIG_HOME/weft/daemon.log`). Use `weft daemon start --foreground` to keep it attached to the terminal while debugging. If `weft login` has not run yet, `weft daemon start` stops and tells you to run `weft login`.

Use `weft daemon status` to see whether it is running, its process ID, uptime, detected agent CLIs, signed-in server, and log path. Add `--json` for machine-readable output. Use `weft daemon stop` to stop the Daemon and its active Runs. A second start is refused while the process is running; stale records left by a crashed process are removed by status or the next start.

The Daemon folder (`~/.config/weft` by default) is created with owner-only permissions (`0700`). It holds:

- `config.json` (`0600`): the CLI settings and the Personal API token that `weft login` saved.
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

**The Personal API token** (`config.json`) is a normal token for CLI commands, the same kind as one you create in the web app. `weft login` saves it with a 30-day expiry. Signing in again on the same machine revokes the previous token of that machine. The Daemon uses it only for `register_daemon`, the call that registers the Daemon and its Runtimes.

**The Daemon credential** (`daemon-credential.json`) is a restricted token (prefix `weft_daemon_`). The server returns it once, when registration issues or rotates it. It reaches `/api/daemon/*` endpoints only: claiming Runs, status posts, the WebSocket, and stopping the Daemon. It is refused on `/actions`, and it cannot register again. It expires 30 days after issue. Every registration (about every 5 minutes) checks it: when less than 7 days remain, or when no active credential exists for this host, the server issues a new one and keeps the same Daemon and its Runtimes. A Daemon with no credential file asks for a new one.

**Rotation has a 10-minute grace period.** The previous credential is not revoked when a new one is issued. It keeps working for 10 minutes, so calls already in flight (a Run's status posts or its final result) finish, and then it is refused. Later registrations revoke rotated credentials whose grace has passed. If the Daemon crashes before it writes the new credential, the old one still works for the grace period, and the Daemon asks for a new one once it is refused.

**Rotation closes the WebSocket once.** The server closes the socket of a superseded credential (close code 4001) and the Daemon reconnects with the credential it adopted. Nothing else is needed.

**The Daemon recovers from a refused credential by itself.** When a `/api/daemon/*` call returns 401, or the WebSocket closes with code 1008, the Daemon asks for a new credential at its next registration, and logs the close code and reason to `daemon.log`. A Run's result is re-sent with the credential re-read from disk, so a single 401 does not lose it.

**When the Personal sign-in is refused**, registration returns 401 (the Personal token expired or was revoked). The Daemon writes a message to its log and to stderr telling you to run `weft login`, and keeps retrying with a backoff of up to 5 minutes. Run `weft login`; the Daemon picks up the new sign-in at its next retry.

**The Daemon credential is in the WebSocket URL.** The WebSocket connects to `/api/daemon?token=...`, so the credential is part of the URL. Proxies and access logs in front of the API may record that URL. Treat the server's access logs as holding Daemon credentials, and keep the credential's lifetime short (30 days, rotated early).

## What an Agent CLI can read

The Daemon starts each Agent CLI with an allowlisted environment: `PATH`, the locale and terminal variables, `HOME`, `XDG_CONFIG_HOME` and a few provider keys, plus the Run-specific `WEFT_*` values. The Daemon credential and every `WEFT_DAEMON_*` variable are never placed in that environment. The child receives the short-lived Run token as `WEFT_TOKEN`.

The environment is not a boundary for files. The Agent CLI runs as the same OS user as the Daemon, and `HOME` and `XDG_CONFIG_HOME` are passed on. It can therefore read `config.json` and `daemon-credential.json`, like any other file that user can read. The Daemon credential is refused on `/actions`, but a child that reads it can use it on the Daemon endpoints. A child that reads the Personal API token can call `/actions` as the owner, which the Run's Agent permissions do not limit. Until a sandbox exists, treat any Agent Run on a Runtime as able to act with the owner's full Weft access.

There is no OS sandbox per Run. An Agent CLI can use any file and network access available to its OS account on that computer. The credential split limits what a leaked Daemon credential can do to Weft; it does not limit local file or network access.
