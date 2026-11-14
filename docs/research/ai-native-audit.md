# AI-native compatibility audit (ticket 24)

Scope: real `claude` agents (Haiku 5.5, the only agent with quota this session) doing jobs in Weft through the `weft` CLI and the MCP server, plus the CLI-side negative checks and a human walkthrough. Codex was not used (out of quota).

Environment: one API on its own throwaway Postgres database (`weft_audit_24`, dropped after the run), one Daemon with a temporary HOME, the test workspace under the session scratchpad, one agent run at a time. Agent runs used an empty temporary folder, a minimal environment (`env -i`, temporary HOME, `WEFT_API_URL`, `WEFT_WORKSPACE`, `WEFT_TOKEN`) and only the `weft` Bash command or the `weft` MCP tools (`Read`, `Edit`, `Write`, `Glob`, `Grep`, web tools disallowed).

Caveats, stated up front:

- The agents used the **workspace Admin's personal API token**, not a scoped Run token. A scoped Run token needs a Daemon Run, which this audit did not start (see "Not done").
- Per-run tool counts include `ToolSearch` calls (the MCP tools are deferred) and any refused call.
- Transcripts are summarised below (command, short result, final report). Full stream-json transcripts stay in the session scratchpad, `ai-audit/transcripts/`, because they are large. Nothing in them contains a token.
- The friction log comes from the agents' own final reports, checked against the transcript where a claim was checkable. Items marked _inferred_ are the agent's reading, not a verified fact.

## 1. Scenario list (12 jobs)

| # | Job | Surface | Result | Tool calls |
|---|---|---|---|---|
| S1 | List open work items in project AUD with display ids and titles | CLI | finished | 5 (`--help` ×2, `list-projects`, `list-work-items`, `list-states`) |
| S2 | Create "Login button hangs on Safari" with priority and description, move to In Progress | MCP | finished | 5 (`ToolSearch`, `get_project`, `list_states`, `create_work_item`, `move_work_item`) |
| S3 | Comment on AUD-1 with a markdown table, list comments, confirm | CLI | finished | 6 (`--help` ×3, `get-work-item`, `create-comment`, `list-comments`) |
| S4 | Assign the Agent "Helper" to AUD-2 and comment mentioning it | MCP | **partly**: assignee set; mention not created | 8 (`Bash` refused, `ToolSearch`, `list_agents`, `get_work_item`, `update_work_item` ×2, `list_mentionable_members`, `create_comment`) |
| S5 | Search the workspace for "board" and report matches | CLI | finished | 6 (`--help` ×2, `list-projects`, `search-work-items` ×2, `list-work-items`) |
| S6 | Create cycle "Sprint 1" from today for 14 days, add AUD-3 and AUD-4, report count | MCP | finished | 8 (`ToolSearch` ×2, `get_project`, `get_work_item` ×2, `create_cycle`, `add_cycle_items`, `get_cycle`) |
| S7 | Create a wiki page in a Collection, then edit it | either | not run | - |
| S8 | Create a Module and add work items to it | either | not run | - |
| S9 | Change priority and labels of a work item, then read its timeline | either | not run | - |
| S10 | Add a blocks relation between two work items | either | not run | - |
| S11 | Read the activity of a Run after an Agent was assigned | either | not run (needs a Daemon Run) | - |
| S12 | Submit a work item to Intake, then accept it | either | not run | - |

Six of twelve were run end to end: three through the CLI (S1, S3, S5) and three through MCP (S2, S4, S6). Each run used a fresh `claude -p --model haiku` process with the job and the one-line instruction "the only way to reach Weft is the weft command line tool" or "use only the Weft MCP tools", and no repository access.

## 2. Transcript summaries and reports

S4 was started with the CLI wording in its prompt by mistake, so the agent tried `Bash` first; the harness refused it and the agent switched to MCP. The job itself was MCP-shaped, so the run still counts; it is marked as a deviation.

The full per-run summaries (command, result, and the agent's final report) are in the appendix at the end of this file.

## 3. Friction log

Each item: evidence (scenario), status. "Fixed" means a commit on this branch with a test; "follow-up" means listed with a reason.

### Fixed in this ticket

| # | Friction | Evidence | Fix | Test |
|---|---|---|---|---|
| F1 | After `weft login` every command failed `401: Unauthenticated`. The saved token was the Daemon token, which Actions refuse. | Walkthrough step 3 (before fix: `401: Unauthenticated`, verified) | Sign-in now issues a personal CLI token (30 days, replaced on the next sign-in from the same machine) and a separate Daemon token; `weft daemon start` reads the Daemon token | `apps/cli/test/login.test.ts`; updated `apps/cli/test/daemon.test.ts` (commit `a7e03de`) |
| F2 | A 401 said only `401: Unauthenticated`, with no next step | F1 | The 401 names `weft login`, `--token` and `WEFT_TOKEN` (commit `23bbc98`) | `login.test.ts` (asserts "run `weft login` again") |
| F3 | Passing an Agent's **agent id** in `assigneeIds` returned `400 Assignees must be project members`, which is false for Helper | S4 (verified: `list_agents` gives `id` and `userId`; the 400 came from the agent id) | The error names the `userId` to pass; a non-member error names `add_project_member` and the ids (commit `458c8db`) | `packages/actions/test/agents.test.ts` (new test) |
| F4 | `@Helper` in a comment was plain text, not a mention, and nothing said so | S4 (`mentionedUserIds: []`, verified) | The `bodyMarkdown` field and `create_comment` description say to write `@{exact name}`; a plain `@Name` is only text | MCP description test in `apps/mcp/test/ai-native-negative.test.ts` |
| F5 | `workItemId`, `cycleId` and cycle `workItemIds` are UUIDs. Agents had to look up UUIDs from display ids first, and no description said so | S3, S5, S6 (verified: each run ran `get-work-item` or `get_work_item` first) | Descriptions of `create_comment`, `list_comments`, `add_cycle_items`, `create_cycle` say they are UUIDs and where to get them (`get_work_item` by displayId, `list_projects` or `get_project` for projects) | MCP description test |
| F6 | Cycle end date: the agent could not tell whether `endDate` is inclusive | S6 (agent said "14-day span is my reading") | `create_cycle` says both days belong to the Cycle (the code already treats both end points as inclusive; `packages/actions/test/cycles.test.ts`) | MCP description test |

### Follow-ups (not fixed here, with reason)

| # | Friction | Evidence | Why not fixed now |
|---|---|---|---|
| U1 | Id fields accept only UUIDs. `--work-item-id AUD-1` and `--project-id AUD` fail | S1, S3, S5, S6 | Changing every id input to accept display ids or keys is an API change across many Actions. Proposal: resolve display ids and keys in one shared input type |
| U2 | `@Name` mentions need the `@{exact name}` syntax, and the server gives no warning for a plain `@Name` | S4 | A warning needs the comment write path to scan for `@` text; kept as a description fix for now |
| U3 | `list-*` results are bare arrays with no count or total | S3 | Changing output shape breaks every consumer; a `--count` flag or a wrapper is a proposal |
| U4 | `search-work-items` results have an empty `snippet` and do not say which field matched | S5 | Needs search-side highlighting; a larger change |
| U5 | The PQL reference is printed in full under `list-work-items`, `search-work-items` and the top-level `--help`, which makes them hard to scan | S1, S5 | Text layout change in the registry; proposal to show the PQL reference once, linked |
| U6 | `create_work_item` returns both `description` (a ProseMirror document) and `descriptionMarkdown`, and the input has both too | S2 | Shape decision with the web app; proposal |
| U7 | `update_work_item` and `move_work_item` both set `stateId` | S2 | Both are valid; the agent chose one by the word in the job. Proposal: say in the `update_work_item` description that `move_work_item` is the state change |
| U8 | `move_work_item` returns only `stateId`, not the state name | S2 | Needs a join in the response; proposal |
| U9 | `create-comment` accepts `--body` and `--body-markdown`; the help does not say which wins (the code refuses both) | S3 | The code already refuses both with a message; the help text is the gap. Small, left for the next help pass |
| U10 | Daemon status prints `Agent CLIs: none detected` when the Daemon's PATH lacks `claude`/`codex`, without saying which PATH it checked | walkthrough step 6 (verified: the walkthrough PATH had no `claude`) | The message is correct; the fix is to print the PATH searched. Small, next pass |
| U11 | Cycle overlap warnings (`check_cycle_dates`, `add_cycle_items` skipped list) were never exercised | S6 (agent: "I don't know what the report looks like when it fires") | Needs a second overlapping Cycle in the audit database; not run |
| U12 | An Agent Run's own friction (tool use through the Daemon, Run token scope, Run activity) is not measured | none | Needs a Daemon Run with a Code-capable or Runtime Agent; not started |

## 4. CLI-side negative checks

Test files (run through `bun run test:isolated`, all passing):

- `apps/cli/test/ai-native-negative.test.ts`
  - "the CLI refuses a Member an Agent without Agent access, and the item gets no Run": a Member runs `create-work-item --assignee-ids '[<agent userId>]'` with the Agent's access narrowed to the owner. The command fails, stderr contains `You do not have Agent access to Reply Agent. Ask its owner or an Admin to grant access.`, and no Run row is created.
  - "the CLI shows the Run token refusal when an Agent Run tries to delete, and nothing is deleted": a Run token claimed through the Daemon runs `delete-work-item`. The command fails with `Agents cannot delete anything`, and a following `get-work-item` still returns the item.
- `apps/mcp/test/ai-native-negative.test.ts` (MCP side, from the earlier commit): Agent access refusal through MCP, PM cannot delete Agent/project/workspace through MCP, Daemon credential refused by every Action.
- `apps/cli/test/login.test.ts`: the Daemon credential is refused by `/actions/list_projects` (401).

Result: all pass. Full suite under `flock /tmp/weft-suite.lock bun run test:isolated --max-concurrency=2`: 959 pass, 0 fail (before the last two commits; the 401 message change ran in `apps/cli` only, 30 pass).

## 5. Human walkthrough (install, login, one task from list to comment)

Commands run in order in a clean temporary HOME (`walkthrough/home`) and an empty folder (`walkthrough/folder`). The browser step was replaced by a stand-in `xdg-open` that follows the sign-in redirect with the owner's session; everything else is the real CLI against the real API. Output is as printed, with the scratchpad path shortened.

```sh
# 0. Install: bun 1.4.2 on PATH. The CLI runs from the repo; the wrapper is the install.
printf '#!/bin/sh\nexec <bun> <repo>/apps/cli/src/index.ts "$@"\n' > walkthrough/bin/weft && chmod +x walkthrough/bin/weft

# 1. Help
weft --help | head -3
```
```
Usage: weft [options] [command]

Weft command line, derived from the Action registry: one command per Action
```

```sh
# 2. Login (opens the browser; here xdg-open is the stand-in)
export WEFT_API_URL=http://localhost:3917
weft login
```
```
Signed in to http://localhost:3917. Token saved to .../walkthrough/home/.config/weft/config.json
```

```sh
# 3. First command with the workspace slug
weft -w audit-co list-projects | jq -c '.[] | {key,role}'
```
```
{"key":"AUD","role":"Admin"}
```

```sh
# 4. List open work items
PID=<project id from list-projects>
weft -w audit-co list-work-items --project-id $PID --query "stateGroup != completed AND stateGroup != cancelled" | jq -c '.[] | {displayId,title}' | head -5
```
```
{"displayId":"AUD-1","title":"Fix login redirect loop"}
{"displayId":"AUD-5","title":"Login button hangs on Safari"}
{"displayId":"AUD-2","title":"Export CSV missing archived items"}
{"displayId":"AUD-3","title":"Add dark mode to settings"}
{"displayId":"AUD-4","title":"Slow board load with 500 items"}
```

```sh
# 5. Find the id of AUD-1 (the comment command takes the UUID, see U1), then comment with a table
ID=$(weft -w audit-co get-work-item --display-id AUD-1 | jq -r .id)
weft -w audit-co create-comment --work-item-id $ID --body-markdown $'Checked on Chrome.\n\n| Browser | Status |\n| --- | --- |\n| Chrome | Fixed |' | jq -c '{id,markdown}'
```
```
{"id":"927a3326-7965-4835-836d-fe7ac5f78d93","markdown":"Checked on Chrome.\n\n| Browser | Status |\n| --- | --- |\n| Chrome | Fixed |"}
```

```sh
# 6. Confirm, then the Daemon (temporary HOME, one Daemon, stopped at the end)
weft -w audit-co list-comments --work-item-id $ID | jq -c 'length'
weft daemon start
weft daemon status
weft daemon stop
```
```
2
Daemon started in the background (process 3827186). It will register its Runtimes. Run `weft daemon status` to check it or `weft daemon stop` to stop it; log: .../walkthrough/home/.config/weft/daemon.log
Daemon is running as process 3827186 (up 0m 6s).
Agent CLIs: none detected.
Signed in to: http://localhost:3917.
Log file: .../walkthrough/home/.config/weft/daemon.log.
Run `weft daemon stop` to stop it.
Daemon stopped (process 3827186). In-flight Runs were asked to stop. Run `weft daemon start` to reconnect.
```

Timing: not timed. The stand-in browser step is not a real browser, so the 10-minute bar is not measured here. Friction in the walkthrough: before fix F1, the saved token gave `401: Unauthenticated` on every command (reproduced with a simulated sign-in callback); step 5 needs the UUID (U1); step 6 says `none detected` because the walkthrough PATH had no agent CLI (U10).

## 6. Not done

- Scenarios S7 to S12 (wiki, Modules, field changes, relations, Run activity, Intake). Reason: time and the one-run limit; S11 needs a Daemon Run.
- Runs with a scoped Run token and a real Daemon Run. The agents used the owner's personal token.
- The fresh-agent tool-choice test (10 tasks, wrong-choice count). Not run.
- Codex runs. Out of quota.
- The Thai summary page (the coordinator writes it).

## Appendix: per-run summaries

Condensed from the stream-json transcripts by `summarize.py` (command, first ~220 characters of the result, final report). Full transcripts stay in the session scratchpad.

### Run S1 (cli)
```text
tool calls: 5
1. [Bash] weft --help
   -> Usage: weft [options] [command] Weft command line, derived from the Action registry: one command per Action (work items, wiki, Cycles, Modules, Intake, Relations, comments, queries, ...). Run `weft <command> --help` for 
2. [Bash] weft list-work-items --help
   -> Usage: weft list-work-items [options] read action list_work_items Lists one project's work items. Filter them with the `query` field, which is a PQL query (not free text). Weft query: Field Operator Value, combined with 
3. [Bash] weft -w audit-co list-projects
   -> [ { "id": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "key": "AUD", "name": "Audit", "visibility": "public", "archived": false, "role": "Admin", "features": { "cycles": true, "modules": true, "intake": true } } ]
4. [Bash] weft -w audit-co list-work-items --project-id eda907cb-fe21-439e-97c6-3adb253ecd8c --query "stateGroup != completed AND stateGroup != cancelled"
   -> [ { "assigneeIds": [], "labelIds": [], "parentId": null, "startDate": null, "dueDate": null, "id": "31a4b34e-13fd-45e4-94ca-5ad445892e54", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "sequence": 1, "displayId": 
5. [Bash] weft -w audit-co list-states --project-id eda907cb-fe21-439e-97c6-3adb253ecd8c
   -> [ { "id": "2b75bd18-f4bf-4b3e-a0c8-cdf499e1d408", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "name": "Backlog", "group": "backlog", "sortOrder": 0 }, { "id": "134b16ef-fcfa-4094-bade-6601d4424156", "projectId":
tool errors: 0
--- final report ---
Four work items in AUD are open (not completed or cancelled):

- **AUD-1**: Fix login redirect loop (id `31a4b34e-13fd-45e4-94ca-5ad445892e54`)
- **AUD-2**: Export CSV missing archived items (id `a0e9efc9-f95e-40ee-9e71-829a48fbab83`)
- **AUD-3**: Add dark mode to settings (id `71562a05-8abe-46db-9cd9-e9a8866a97d7`)
- **AUD-4**: Slow board load with 500 items (id `77f23953-5b26-467f-9e1d-0035024382a8`)

All four are in the Backlog state (group `backlog`). The project id is `eda907cb-fe21-439e-97c6-3adb253ecd8c`. The filter was `stateGroup != completed AND stateGroup != cancelled`. I checked the state groups with `list-states` before reporting.

Commands run: 5 (`weft --help`, `weft list-work-items --help`, `weft list-projects`, `weft list-work-items`, `weft list-states`).

Points where the tool or its messages confused me:
- `list-work-items` takes the project's UUID as `--project-id`, not the key `AUD`, so I had to look up the id with `list-projects` first.
- The `--query` option takes PQL, not free text, and the help text does not say which field names the open-state filter should use; I had to infer `stateGroup` from the state list.
- The default list silently excludes archived items, and nothing in the output says so, so archived open items would not appear here.
- The top-level `--help` repeats the full PQL reference under several commands, which makes the command list hard to scan.
```

### Run S2 (mcp)
```text
tool calls: 5
1. [ToolSearch] {"query": "select:mcp__weft__create_work_item,mcp__weft__list_states,mcp__weft__update_work_item,mcp__weft__move_work_item,mcp__weft__get_work_item,mcp__weft__get_project", "max_results": 6}
   ->  
2. [mcp__weft__get_project] {"key": "AUD", "workspace": "audit-co"}
   -> { "id": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "key": "AUD", "name": "Audit", "visibility": "public", "archived": false, "role": "Admin", "features": { "cycles": true, "modules": true, "intake": true }, "requestedKey": 
3. [mcp__weft__list_states] {"projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c"}
   -> [ { "id": "2b75bd18-f4bf-4b3e-a0c8-cdf499e1d408", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "name": "Backlog", "group": "backlog", "sortOrder": 0 }, { "id": "134b16ef-fcfa-4094-bade-6601d4424156", "projectId":
4. [mcp__weft__create_work_item] {"projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "title": "Login button hangs on Safari", "priority": "high", "descriptionMarkdown": "Repro: open login on Safari 17, click Sign in, the spinner never stops."}
   -> { "assigneeIds": [], "labelIds": [], "parentId": null, "startDate": null, "dueDate": null, "id": "be31e305-10f8-41ca-8749-4ff7ebb486d6", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "sequence": 5, "displayId": "A
5. [mcp__weft__move_work_item] {"workItemId": "be31e305-10f8-41ca-8749-4ff7ebb486d6", "stateId": "b5776b2e-0e3f-46d2-9ce9-418145817e90"}
   -> { "assigneeIds": [], "labelIds": [], "parentId": null, "startDate": null, "dueDate": null, "id": "be31e305-10f8-41ca-8749-4ff7ebb486d6", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "sequence": 5, "displayId": "A
tool errors: 0
--- final report ---
**Result: AUD-5 is created and is in In Progress.**

- **displayId:** AUD-5
- **Work item id:** `be31e305-10f8-41ca-8749-4ff7ebb486d6`
- **Title:** Login button hangs on Safari
- **Priority:** high
- **Description:** "Repro: open login on Safari 17, click Sign in, the spinner never stops."
- **Final state:** In Progress (`b5776b2e-0e3f-46d2-9ce9-418145817e90`, group `started`). The move response confirms this.

**Tool calls:** 4 Weft calls (`get_project`, `list_states`, `create_work_item`, `move_work_item`), plus 1 `ToolSearch` call to load the schemas.

**Points of confusion:**
1. `create_work_item` has an untyped `description` field and a separate `descriptionMarkdown` field that says "Use instead of description." I used `descriptionMarkdown`. The response stored the text correctly.
2. `get_project` takes a project `key`, but `list_states` and `create_work_item` need the project UUID. I had to look up the UUID first.
3. The create response defaulted the item to the Backlog state, so a separate move was needed. The job didn't say whether to set the state at creation.
4. `update_work_item` and `move_work_item` can both change `stateId`. I used `move_work_item` because the job said "move".
5. The `move_work_item` response shows only `stateId`, not the state name. I matched the UUID against `list_states` to confirm In Progress.
6. The `create_work_item` response contains both `description` (a ProseMirror doc object) and `descriptionMarkdown` (a string), which is redundant.
```

### Run S3 (cli)
```text
tool calls: 6
1. [Bash] weft --help
   -> Usage: weft [options] [command] Weft command line, derived from the Action registry: one command per Action (work items, wiki, Cycles, Modules, Intake, Relations, comments, queries, ...). Run `weft <command> --help` for 
2. [Bash] weft create-comment --help; echo ---; weft list-comments --help
   -> Usage: weft create-comment [options] write action create_comment Adds a comment to a work item. Give `parentId` (a top-level comment) to reply; a reply to a reply is refused. Options: --input <json> Full input as JSON; o
3. [Bash] weft get-work-item --help
   -> Usage: weft get-work-item [options] read action get_work_item Options: --input <json> Full input as JSON; options override its fields. Markdown options accept '-' to read stdin. --display-id <value> Input field displayId
4. [Bash] weft -w audit-co get-work-item --display-id AUD-1
   -> { "assigneeIds": [], "labelIds": [], "parentId": null, "startDate": null, "dueDate": null, "id": "31a4b34e-13fd-45e4-94ca-5ad445892e54", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "sequence": 1, "displayId": "A
5. [Bash] weft -w audit-co create-comment --work-item-id 31a4b34e-13fd-45e4-94ca-5ad445892e54 --body-markdown '| Browser | Status |
|---------|--------|
| Chrome | Fixed |
| Firefox | Open |'
   -> { "id": "85d7ce45-d397-466d-865c-1970755f677b", "workItemId": "31a4b34e-13fd-45e4-94ca-5ad445892e54", "authorId": "oFXRSa4ej8ydEGtdsSncoCz0NT4huaZN", "authorName": "Owner", "body": { "type": "doc", "content": [ { "type":
6. [Bash] weft -w audit-co list-comments --work-item-id 31a4b34e-13fd-45e4-94ca-5ad445892e54
   -> [ { "id": "85d7ce45-d397-466d-865c-1970755f677b", "workItemId": "31a4b34e-13fd-45e4-94ca-5ad445892e54", "authorId": "oFXRSa4ej8ydEGtdsSncoCz0NT4huaZN", "authorName": "Owner", "body": { "type": "doc", "content": [ { "type
tool errors: 0
--- final report ---
The comment is on AUD-1 and the list confirms it.

**Result**
- AUD-1 work item id: `31a4b34e-13fd-45e4-94ca-5ad445892e54` (title "Fix login redirect loop", project `eda907cb-fe21-439e-97c6-3adb253ecd8c`)
- New comment id: `85d7ce45-d397-466d-865c-1970755f677b`, author "Owner", created 2026-11-13T13:51:48Z
- Stored markdown: `| Browser | Status |` / `| --- | --- |` / `| Chrome | Fixed |` / `| Firefox | Open |`, with no warnings.
- `list-comments` on AUD-1 returned exactly one comment, which is the new one, with the same id and table content. AUD-1 had no other comments before this.

**Commands run:** 7 (`weft --help`, three `--help` lookups, one `get-work-item`, one `create-comment`, one `list-comments`).

**Points of confusion**
1. The `create-comment` help example shows the table without a separator row (`| A | B |`). I added the `---` separator row, which is needed for a valid markdown table, and the stored markdown confirms it parsed.
2. `list-comments` and `create-comment` take `--work-item-id`, which needs the UUID, not the display id `AUD-1`. Nothing in their help says so; I had to look the UUID up with `get-work-item --display-id AUD-1`.
3. `list-comments` prints a bare JSON array with no count or wrapper, so confirming the comment means scanning the output.
4. `create-comment` offers both `--body` and `--body-markdown`, and the help does not say which one wins when both are given. I used only `--body-markdown`.
```

### Run S4 (mcp)
```text
tool calls: 8
1. [Bash] weft --help
   -> ERROR <tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.</tool_use_error>
2. [ToolSearch] {"query": "select:mcp__weft__list_agents,mcp__weft__get_work_item,mcp__weft__update_work_item,mcp__weft__create_comment,mcp__weft__list_mentionable_members", "max_results": 5}
   ->  
3. [mcp__weft__list_agents] {"workspace": "audit-co"}
   -> [ { "id": "a55b8ba3-1ef6-4a91-8370-6b2772694169", "userId": "5ba1daca-9c06-47d3-89b6-3c96b40919b1", "workspaceId": "06e41934-66d2-4a13-b750-776469450b04", "name": "Helper", "instructions": "Help the team with Weft work."
4. [mcp__weft__get_work_item] {"displayId": "AUD-2", "workspace": "audit-co"}
   -> { "assigneeIds": [], "labelIds": [], "parentId": null, "startDate": null, "dueDate": null, "id": "a0e9efc9-f95e-40ee-9e71-829a48fbab83", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "sequence": 2, "displayId": "A
5. [mcp__weft__update_work_item] {"workItemId": "a0e9efc9-f95e-40ee-9e71-829a48fbab83", "assigneeIds": ["a55b8ba3-1ef6-4a91-8370-6b2772694169"]}
   -> ERROR 400: Assignees must be project members
6. [mcp__weft__list_mentionable_members] {"projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c"}
   -> [ { "userId": "5ba1daca-9c06-47d3-89b6-3c96b40919b1", "name": "Helper", "email": "agent-5ba1daca-9c06-47d3-89b6-3c96b40919b1@agents.weft.invalid", "isAgent": true, "codeCapable": false, "hasAccess": true, "accessReason":
7. [mcp__weft__update_work_item] {"workItemId": "a0e9efc9-f95e-40ee-9e71-829a48fbab83", "assigneeIds": ["5ba1daca-9c06-47d3-89b6-3c96b40919b1"]}
   -> { "assigneeIds": [ "5ba1daca-9c06-47d3-89b6-3c96b40919b1" ], "labelIds": [], "parentId": null, "startDate": null, "dueDate": null, "id": "a0e9efc9-f95e-40ee-9e71-829a48fbab83", "projectId": "eda907cb-fe21-439e-97c6-3adb2
8. [mcp__weft__create_comment] {"workItemId": "a0e9efc9-f95e-40ee-9e71-829a48fbab83", "bodyMarkdown": "@Helper, please check the CSV export for AUD-2 (Export CSV missing archived items)."}
   -> { "id": "f6246107-4ff2-4077-9ccf-f3e9a2802d12", "workItemId": "a0e9efc9-f95e-40ee-9e71-829a48fbab83", "authorId": "oFXRSa4ej8ydEGtdsSncoCz0NT4huaZN", "authorName": "Owner", "body": { "type": "doc", "content": [ { "type":
tool errors: 2
--- final report ---
The assignee is set and the comment is posted, but the comment's mention is not a real mention. Details below.

**Report**

- **Work item:** AUD-2 (`a0e9efc9-f95e-40ee-9e71-829a48fbab83`), "Export CSV missing archived items", in workspace `audit-co`, project `AUD` (`eda907cb-fe21-439e-97c6-3adb253ecd8c`).
- **Assignee:** Helper, set to user id `5ba1daca-9c06-47d3-89b6-3c96b40919b1`. The `assigneeIds` field now lists that id.
- **Comment id:** `f6246107-4ff2-4077-9ccf-f3e9a2802d12`. Body: "@Helper, please check the CSV export for AUD-2 (Export CSV missing archived items)." Author is Owner.
- **Mention problem:** the response has `mentionedUserIds: []`, so the text "@Helper" is plain text and does not notify or link Helper. I did not edit the comment or try a second one, because I don't know the mention syntax this tool accepts.
- **Commands run:** 6 weft calls (`list_agents`, `get_work_item`, `update_work_item` ×2, `list_mentionable_members`, `create_comment`). Plus one tool-schema lookup, which is not a weft command.
- **Environment deviation:** Bash is disabled in this session, so I could not run the `weft` CLI at all. I used the weft MCP tools instead, which expose the same operations. I did not read any other files.

**Points where the tool or its messages confused me**

- `list_agents` returns Helper's agent id (`a55b8ba3-…`), but the assignee field needs its user id (`5ba1daca-…`). Using the agent id gave a 400 error.
- The 400 error said "Assignees must be project members". Helper was in `list_mentionable_members` with `hasAccess: true`, so the error text does not match the membership data.
- Nothing in the create-comment response flags that `@Helper` was not converted into a mention. The only sign is the empty `mentionedUserIds`.
- The write tools accept both `body` and `bodyMarkdown`, and the response returns both forms, so it is unclear which one the server treats as the source of truth.
```

### Run S5 (cli)
```text
tool calls: 6
1. [Bash] weft --help
   -> Usage: weft [options] [command] Weft command line, derived from the Action registry: one command per Action (work items, wiki, Cycles, Modules, Intake, Relations, comments, queries, ...). Run `weft <command> --help` for 
2. [Bash] weft search-work-items --help
   -> Usage: weft search-work-items [options] read action search_work_items Searches a workspace. `query` is free text matched against titles, ids and descriptions. `pql` is a PQL query and needs `projectId`; give `pql` to fil
3. [Bash] weft list-projects -w audit-co 2>&1; echo "---"; weft list-projects --help 2>&1 | head -30
   -> [ { "id": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "key": "AUD", "name": "Audit", "visibility": "public", "archived": false, "role": "Admin", "features": { "cycles": true, "modules": true, "intake": true } } ] --- Usage: 
4. [Bash] weft -w audit-co search-work-items --query board 2>&1
   -> [ { "id": "77f23953-5b26-467f-9e1d-0035024382a8", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "displayId": "AUD-4", "title": "Slow board load with 500 items", "snippet": "", "stateId": "2b75bd18-f4bf-4b3e-a0c8-c
5. [Bash] weft list-work-items --help 2>&1 | head -40; echo ---; weft -w audit-co list-work-items --project-id eda907cb-fe21-439e-97c6-3adb253ecd8c --query 'text ~ "board" OR title ~ "board"' 2>&1
   -> Usage: weft list-work-items [options] read action list_work_items Lists one project's work items. Filter them with the `query` field, which is a PQL query (not free text). Weft query: Field Operator Value, combined with 
6. [Bash] weft -w audit-co list-projects --archived true 2>&1; echo ---; weft -w audit-co search-work-items --query board --limit 100 2>&1 | grep -c displayId
   -> [] --- 1
tool errors: 0
--- final report ---
**Result:** One work item in the workspace mentions "board":

- **AUD-4**: "Slow board load with 500 items" (id `77f23953-5b26-467f-9e1d-0035024382a8`)

**Checks:** The workspace search (`search-work-items --query board`) returned only AUD-4, and a cross-check with `list-work-items` on AUD using `text ~ "board" OR title ~ "board"` also returned only AUD-4. The workspace has one project, AUD (Audit), and no archived projects. I read "in project AUD, search the whole workspace" as a workspace-wide search, so the results are not filtered to AUD. Here that makes no difference, since AUD is the only project.

**Commands run:** 9 `weft` invocations (4 of them `--help`).

**Where the tool or its messages confused me:**
- `search-work-items` needs a project UUID for `pql`, but there is no way to pass the key `AUD`; I had to call `list-projects` to get the id.
- `search-work-items --query` is free text, while `list-work-items --query` is PQL, and both use the same `--query` flag name. Easy to mix up.
- The `search-work-items` help says `query` matches "titles, ids and descriptions", but the result has an empty `snippet`, so I can't tell which field matched AUD-4.
- The help doesn't say whether `~` in PQL is a substring match or a word match, so I couldn't tell whether "boards" or "dashboard" would be caught.
- The search help doesn't state a default result limit. I passed `--limit 100` to confirm; it still returned one item.
- The `search-work-items` help repeats the full PQL reference, which makes it hard to find the part that applies to free-text search.
```

### Run S6 (mcp)
```text
tool calls: 8
1. [ToolSearch] {"query": "select:mcp__weft__create_cycle,mcp__weft__add_cycle_items,mcp__weft__check_cycle_dates,mcp__weft__get_cycle,mcp__weft__list_cycles,mcp__weft__get_project", "max_results": 6}
   ->  
2. [mcp__weft__get_project] {"key": "AUD", "workspace": "audit-co"}
   -> { "id": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "key": "AUD", "name": "Audit", "visibility": "public", "archived": false, "role": "Admin", "features": { "cycles": true, "modules": true, "intake": true }, "requestedKey": 
3. [ToolSearch] {"query": "select:mcp__weft__get_work_item", "max_results": 1}
   -> 
4. [mcp__weft__get_work_item] {"displayId": "AUD-3", "workspace": "audit-co"}
   -> { "assigneeIds": [], "labelIds": [], "parentId": null, "startDate": null, "dueDate": null, "id": "71562a05-8abe-46db-9cd9-e9a8866a97d7", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "sequence": 3, "displayId": "A
5. [mcp__weft__get_work_item] {"displayId": "AUD-4", "workspace": "audit-co"}
   -> { "assigneeIds": [], "labelIds": [], "parentId": null, "startDate": null, "dueDate": null, "id": "77f23953-5b26-467f-9e1d-0035024382a8", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "sequence": 4, "displayId": "A
6. [mcp__weft__create_cycle] {"projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "name": "Sprint 1", "startDate": "2026-11-13", "endDate": "2026-11-27"}
   -> { "id": "d27872fc-e293-410a-9445-df63c7cfd669", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "name": "Sprint 1", "startDate": "2026-11-13", "endDate": "2026-11-27", "status": "active", "createdBy": "oFXRSa4ej8ydE
7. [mcp__weft__add_cycle_items] {"cycleId": "d27872fc-e293-410a-9445-df63c7cfd669", "workItemIds": ["71562a05-8abe-46db-9cd9-e9a8866a97d7", "77f23953-5b26-467f-9e1d-0035024382a8"]}
   -> { "added": [ "71562a05-8abe-46db-9cd9-e9a8866a97d7", "77f23953-5b26-467f-9e1d-0035024382a8" ], "skipped": [] }
8. [mcp__weft__get_cycle] {"cycleId": "d27872fc-e293-410a-9445-df63c7cfd669"}
   -> { "id": "d27872fc-e293-410a-9445-df63c7cfd669", "projectId": "eda907cb-fe21-439e-97c6-3adb253ecd8c", "name": "Sprint 1", "startDate": "2026-11-13", "endDate": "2026-11-27", "status": "active", "createdBy": "oFXRSa4ej8ydE
tool errors: 0
--- final report ---
**Result:** Cycle "Sprint 1" is created in AUD and holds **2 work items**: AUD-3 and AUD-4.

- **Cycle id:** `d27872fc-e293-410a-9445-df63c7cfd669`
- **Dates:** 2026-11-13 to 2026-11-27. The 14-day span is my reading: end date = start + 14 days. If you meant the last day to be 2026-11-26, tell me and I'll update it.
- **Status:** active
- **Project id:** `eda907cb-fe21-439e-97c6-3adb253ecd8c` (Audit, key AUD)
- **Work items added:**
  - AUD-3 "Add dark mode to settings", id `71562a05-8abe-46db-9cd9-e9a8866a97d7`
  - AUD-4 "Slow board load with 500 items", id `77f23953-5b26-467f-9e1d-0035024382a8`
- **Verification:** `add_cycle_items` returned both as added, with none skipped. `get_cycle` confirms `itemCount: 2`, progress 0/2.
- **Overlap check:** I did not run `check_cycle_dates`, so I don't know whether this cycle overlaps another one.

**Tool calls:** 8 in total. That is 6 Weft calls (`get_project`, `get_work_item` ×2, `create_cycle`, `add_cycle_items`, `get_cycle`) plus 2 `ToolSearch` calls to load schemas.

**Points of confusion:**
1. The job says to use `weft__*` tools, but the tools are named `mcp__weft__*`. I used the `mcp__weft__*` names.
2. `create_cycle` and `add_cycle_items` take UUIDs only, so I had to resolve the project key and the AUD-3 and AUD-4 display ids to UUIDs first. Neither description says that.
3. `create_cycle`'s description doesn't say whether `endDate` is inclusive, so the "14 days" arithmetic was a guess.
4. The `add_cycle_items` description warns that items already in another cycle are skipped and reported. The `skipped` field was empty here, so I can't tell you what that report looks like when it fires.
5. The `get_work_item` result has `stateId`, but nothing in the response shows what that state is called.
```

