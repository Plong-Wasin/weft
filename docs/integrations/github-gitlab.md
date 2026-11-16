# GitHub and GitLab links

A workspace Admin connects GitHub or GitLab with a webhook. A pull request or merge request whose branch, title or description mentions a work item key (such as `MOB-231`) is linked to that work item and shows its state and checks. When a linked request merges, the work item can move to its project's done state. Everything is off until an Admin turns it on.

## Turn it on (server operator)

The feature ships **off**. Set `WEFT_INTEGRATIONS_ENABLED=true` in the server environment (`.env`, or the `api` service in `compose.yaml` / `docker-compose.dokploy.yml`) and restart the API. Only the exact value `true` turns it on; unset, empty, or any other value keeps it off.

While it is off:

- `POST /api/webhooks/work-items/<provider>/<id>` answers 404 and does no work.
- The integration Actions are not registered: not on the REST API, the CLI (`weft`), MCP, or the AI.
- The web app hides the **GitHub and GitLab** settings page, the work item pull request section, and the project done-on-merge setting.
- Nothing is written. The database tables still exist (migration `0089`) and stay empty.

## Setup (workspace Admin)

1. Open **Settings → GitHub and GitLab** in the workspace.
2. Click **Connect GitHub** or **Connect GitLab**. Weft shows a webhook secret once. Copy it now.
3. Copy the **Webhook URL** shown on the same page. It is the API origin plus `/api/webhooks/work-items/<provider>/<id>`.
4. In the repository (or GitLab project), add a webhook with that URL and the secret:
   - **GitHub**: Settings → Webhooks → Add webhook. Payload URL = the webhook URL, Content type = `application/json`, Secret = the secret. Choose the events **Pull requests**, **Check suites** and **Check runs**.
   - **GitLab**: Settings → Webhooks → Add new webhook. URL = the webhook URL, Secret token = the secret. Tick **Merge request events** and **Pipeline events**.
5. Back in Weft, tick **Link requests from this connection**.
6. In **Repositories**, list each repository, one per line: `owner/name` for GitHub, `group/project` for GitLab. Only listed repositories can link work items; other repositories are ignored.
7. For a project that should move work items to done on merge: open the project's **Settings → Features**, then turn on **Move to done when merged**. A project Admin does this per project. It is off by default.

## Secrets and permissions

- The webhook secret is shown once. Weft stores it sealed with AES-256-GCM, and no Action returns it again. **Make a new secret** replaces it at once; update the provider's webhook before deliveries fail.
- Sealing uses `BETTER_AUTH_SECRET`. Changing that value makes every stored webhook secret unreadable: create a new connection for each provider after a change, and rotate the secret in the provider.
- Only workspace Admins connect, list, enable, or rotate. Agents never get these actions.
- The webhook secret is a password for the webhook. It is what lets Weft tell a genuine GitHub or GitLab message from a forged one.
- A webhook is accepted only when its signature (GitHub `X-Hub-Signature-256`) or token (GitLab `X-Gitlab-Token`) matches. A repeated delivery id (`X-GitHub-Delivery`, `X-Gitlab-Event-UUID`) is ignored.
- Setting a project's done-on-merge option requires project Admin.

## Reading links

Check status is conservative: a failure stays on the pull request until a new commit is pushed. A re-run that passes does not clear it.

- In a work item, the **Pull and merge requests** section lists the links. It is hidden when there are none.
- Activity shows **linked a pull or merge request** and state changes, with the source "the GitHub or GitLab connection".
- CLI and MCP: `list_work_item_pull_requests` with `workItemId` returns the linked requests. Agents may read them; they cannot change them.

## Manual checklist for a real repository (not yet run)

Automated tests use fixed payloads and do not call GitHub or GitLab. Check these by hand before relying on the feature:

- [ ] The provider shows a green delivery (200) for a test pull request or merge request.
- [ ] A test pull request whose branch contains a work item key appears under that work item with state **Open**.
- [ ] Checks run on the pull request, and the item shows **Checks passing** or **Checks failing** for the latest commit.
- [ ] Merging the request changes the item to the done state only in a project where the option is on.
- [ ] A repository not in the list produces no link (the provider still shows a 200 response with an ignored result).
- [ ] A wrong secret gives a 401 delivery in the provider's log.
- [ ] Rotating the secret makes the old secret fail with 401.

Real-service behaviour (GitHub and GitLab payload details, pipeline status mapping on each provider's version) is unverified until these steps pass on a real repository.
