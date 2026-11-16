# Sandbox prototype

Run `./tools/sandbox-prototype/run.sh` on Linux with Node.js/npm, Python 3, bubblewrap, socat, ripgrep, curl, Git, and npm. The script installs SRT `0.0.83` in a temporary directory, creates a disposable Run and synthetic secret files, prints each check result, then removes its temporary tree. It does not install packages globally or edit system settings.

Set `WEFT_TEST_URL` to a reachable Weft API URL to test that host through the SRT proxy, for example `WEFT_TEST_URL=https://weft.example.test/api/me ./tools/sandbox-prototype/run.sh`. The supplied host and port are added to the temporary allowlist. On Linux, `localhost` inside SRT is the sandbox's own loopback, so a host-local `http://localhost:3000` endpoint cannot be used to represent the Daemon callback. For a private LAN address, the prototype removes `NO_PROXY` for this one probe so the request goes through SRT's allowlist proxy instead of its blocked private-network route.

The real-Codex CLI run and platform comparison are recorded in [`docs/research/agent-cli-sandbox-runtime.md`](../../docs/research/agent-cli-sandbox-runtime.md). Do not copy a person's login files into a Run in production; the research run used a temporary copy only to verify CLI behavior and removed it afterward.
