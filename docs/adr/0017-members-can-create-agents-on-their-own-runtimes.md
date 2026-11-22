# Members may create Agents only on their own Runtimes

Workspace Members may create an Agent only when they bind it to a Runtime they own and have shared with that workspace. Guests cannot create Agents. Admins retain the existing ability to create server Agents and bind Agents to any Runtime shared with the workspace.

A Member-created Agent starts with no project access and no extra Action grants. Its Runtime binding makes it use Autopilot, as all Runtime Agents do, but workspace Autopilot still gates whether its Runs start. Only a workspace Admin may grant project access, change Agent configuration, enable or disable it, attach Skills, change Action grants, or allow it to wake other Agents. The Runtime owner retains the existing control of the Agent's Agent access, Runtime profile and environment. All Actions enforce these rules, including direct API, CLI and MCP calls.

This keeps code execution on the computer of the person who opted into creating the Agent, while preventing a Member from creating a server Agent or using creation as a path to workspace administration or broader project access. Project access remains an explicit Admin decision and the default remains empty.
