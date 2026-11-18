# Deleting a Runtime is refused while it is in use, not cascaded

A Runtime can be deleted by its owner, by a workspace Admin, or by the hourly cleanup. The database would otherwise clear the Agent and Run references to a deleted Runtime silently, which leaves Runs and Agents pointing at nothing and a Run waiting for a Runtime that no longer exists.

So the delete is refused while an enabled Agent is bound to the Runtime or a Run of it is not finished. Only a disabled bound Agent does not block: its binding and Autopilot are cleared in the same transaction, and each change is audited. Profiles go with the Runtime, and sharing ends with its row. Session folders on the computer are left to the Daemon's own sweep (ADR 0014).

Alternatives rejected:

- **Cascade:** deleting the Runs and unbinding the Agents without asking would drop work that is waiting and change Agents an admin did not choose to change. Unbinding or moving the Agents is an explicit Admin decision instead, offered next to the refusal.
- **Set-null only:** the database already does this, and it is exactly the silent loss the refusal prevents.
