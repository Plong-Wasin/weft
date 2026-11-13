# Daemon credentials and local exposure

## Start and stop the local Daemon

Run `weft daemon start` after `weft login`. It returns to the prompt while the Daemon runs in the background, registers the installed agent CLIs as Runtimes, and writes its log to `~/.config/weft/daemon.log` by default (or `$XDG_CONFIG_HOME/weft/daemon.log`). Use `weft daemon start --foreground` to keep it attached to the terminal while debugging.

Use `weft daemon status` to see whether it is running, its process ID, uptime, detected agent CLIs, signed-in server, and log path. Add `--json` for machine-readable output. Use `weft daemon stop` to stop the Daemon and its active Runs. A second start is refused while the process is running; stale records left by a crashed process are removed by status or the next start.

The log and process record (`~/.config/weft/daemon.json` by default) are stored in your Weft config folder with owner-only permissions. The Daemon is not an OS sandbox: Agent CLIs can access files and network resources available to your OS account. Starting automatically when the computer boots is not included.

`weft login` signs the Daemon in with a restricted credential that expires after 30 days. Signing in again rotates the credential for that host and invalidates its previous one. It can register the Daemon and reach `/api/daemon/*` endpoints only; it cannot call `/actions` as the Runtime owner. If an upgraded Daemon reports that its sign-in is expired or from an older version, run `weft login` again.

The Daemon starts each Agent CLI with an allowlisted environment: `PATH` and the Run-specific `WEFT_*` values. The child receives the short-lived Run token, never the Daemon credential or the Runtime owner's Personal API token.

There is no OS sandbox per Run. An Agent CLI still runs as the Daemon's OS user, can access files and credentials that user can access, and can use any network access available to that computer. The credential boundary limits what a leaked Daemon token can do to Weft; it does not limit local file or network access.
