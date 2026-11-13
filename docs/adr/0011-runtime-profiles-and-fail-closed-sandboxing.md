# Runtime profiles define local Agent permissions

An Agent's local file and network access is a property of its Runtime binding, not of the Agent's workspace configuration. A Daemon can offer several permission profiles for each installed agent CLI, and the Runtime owner can bind each Agent to one of those profiles. Profiles are shared when their Runtime is shared. Only the Runtime owner can create, edit, delete or bind profiles; workspace Admins can select a Runtime for an Agent but cannot change a profile or select a different profile on another person's computer. Deleting an in-use profile is refused until its Agents are moved.

A profile contains a sandbox mode and explicit filesystem and network allowlists. `full` preserves legacy behavior and always displays a warning. `read-only` permits reads from the Run directory and explicit read paths but no writes. `run-folder` permits writes only in the Run directory. SRT is the first common OS-level launcher because its explicit filesystem and host allowlists wrap the complete agent CLI process. The Daemon builds a fresh settings file for each Run, outside agent-writable content, with mode 0600. It checks SRT's version, Linux dependencies, and a harmless launch probe before marking a Run started. Any unavailable tool, dependency or rejected sandbox startup fails with install or host-policy guidance; it never retries unsandboxed. Full profiles intentionally skip SRT.

Runtimes default to enforcement off and a `Full access` profile. This preserves existing behavior while making it visible. An owner can enable enforcement; sandboxed profiles then fail closed. This staged default lets owners verify the host can start SRT before enabling the requirement.

## Alternatives rejected

- **Policy on the Agent:** workspace Admins edit Agents, while the files are on the Runtime owner's computer. Putting policy on the Agent would let another person's Admin change local filesystem access. A profile owned by the Runtime owner keeps the authority beside the resource.
- **One Daemon per profile:** this duplicates sign-in, heartbeats, CLI discovery and operations for one computer, and still does not express several limits for one installed CLI cleanly. Profiles let one Daemon offer several policy choices for its CLI.
- **A container per Run:** containers need an image and mount, credential and Git setup, and operational ownership on each host. The prototype recommendation uses the host's SRT support and a disposable Run directory; container isolation remains out of scope.
- **CLI-native sandboxing:** Codex's default workspace-write mode exposes `/tmp` and does not provide the selected shared host allowlist. Claude's built-in sandbox applies only to shell commands, leaving other CLI tools outside the boundary. Neither is the common whole-process boundary needed here.

## Consequences and limits

SRT settings are generated per Run and profiles list paths and hosts rather than accepting arbitrary shell commands. The Daemon uses a filtered child environment and the short-lived Run credential. This does not stop a process from sending a readable Run token to an allowed model host; credential masking or a brokered callback remains a separate risk and no claim is made that host allowlisting prevents exfiltration. Linux may require an administrator to enable user namespaces or adjust host policy; the Daemon reports refusal and never changes system settings. macOS and Windows enforcement are not established by the Linux prototype. Existing Runtimes migrate to full access without a behavior change.
