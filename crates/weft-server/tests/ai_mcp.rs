use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Fixture {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    db: sqlx::PgPool,
    workspace: Uuid,
    user: Uuid,
    cookie: String,
    csrf: String,
}

async fn fixture() -> Fixture {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("mcp_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let scoped = format!("{base}?options=-csearch_path%3D{schema}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    let root = env::temp_dir().join(format!("weft-{schema}"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("index.html"), "Weft").unwrap();
    let server_db = scoped.clone();
    let server = tokio::spawn(async move {
        let _ = serve(listener, ServerConfig::new(server_db, root)).await;
    });
    let origin = format!("http://{address}");
    let client = reqwest::Client::new();
    for _ in 0..3000 {
        if client
            .get(format!("{origin}/health/ready"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let db = sqlx::PgPool::connect(&scoped).await.unwrap();
    weft_server::bootstrap_admin(&db, "owner@example.com", "secret", "Workspace")
        .await
        .unwrap();
    let (workspace, user): (Uuid, Uuid) = sqlx::query_as(
        "SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(user).bind(token_hash).bind(&csrf).execute(&db).await.unwrap();
    Fixture {
        origin,
        server,
        schema,
        admin,
        db,
        workspace,
        user,
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

async fn cleanup(f: Fixture) {
    f.server.abort();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&f.admin)
        .await
        .unwrap();
    f.admin.close().await;
}

fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    f: &Fixture,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &f.cookie)
        .header("x-csrf-token", &f.csrf)
}

use serde_json::{json, Value};

struct Client {
    http: reqwest::Client,
    url: String,
    bearer: String,
}

impl Client {
    async fn raw(&self, body: Value) -> reqwest::Response {
        self.http
            .post(&self.url)
            .header("authorization", &self.bearer)
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn rpc(&self, method: &str, params: Value) -> Value {
        let response = self
            .raw(json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .await;
        assert_eq!(response.status(), 200);
        response.json().await.unwrap()
    }
    async fn call(&self, name: &str, arguments: Value) -> Value {
        self.rpc("tools/call", json!({"name":name,"arguments":arguments}))
            .await
    }
    async fn tool_names(&self) -> Vec<String> {
        let listed = self.rpc("tools/list", json!({})).await;
        listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect()
    }
}

fn payload(response: &Value) -> Value {
    serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

async fn mint(f: &Fixture, capabilities: Value) -> (String, String) {
    let created = request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{}/api/v1/workspaces/{}/mcp-tokens", f.origin, f.workspace),
        f,
    )
    .json(&json!({"name":"My client","capabilities":capabilities}))
    .send()
    .await
    .unwrap();
    let status = created.status();
    let text = created.text().await.unwrap();
    assert_eq!(status, 201, "{text}");
    let created: Value = serde_json::from_str(&text).unwrap();
    (
        created["id"].as_str().unwrap().to_owned(),
        created["token"].as_str().unwrap().to_owned(),
    )
}

fn client(f: &Fixture, secret: &str) -> Client {
    Client {
        http: reqwest::Client::new(),
        url: format!("{}/api/v1/mcp", f.origin),
        bearer: format!("Bearer {secret}"),
    }
}

async fn project(f: &Fixture, name: &str, visibility: &str, member: bool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(f.workspace)
    .bind(name)
    .bind(visibility)
    .bind(f.user)
    .execute(&f.db)
    .await
    .unwrap();
    if member {
        sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')")
            .bind(f.workspace).bind(id).bind(f.user).execute(&f.db).await.unwrap();
    }
    id
}

async fn task(f: &Fixture, project: Uuid, title: &str) -> Uuid {
    let id = Uuid::new_v4();
    let number: i64 = sqlx::query_scalar(
        "UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1",
    )
    .bind(f.workspace)
    .fetch_one(&f.db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,created_by) VALUES($1,$2,$3,$4,$5,'Collect numbers',$6)")
        .bind(id).bind(f.workspace).bind(number).bind(project).bind(title).bind(f.user).execute(&f.db).await.unwrap();
    id
}

fn draft(project: Uuid, title: &str) -> Value {
    json!({"id":"tmp-a","kind":"task","project_id":project,"title":title,"reason":"needed","sources":[]})
}

#[tokio::test(flavor = "multi_thread")]
async fn token_is_shown_once_stored_hashed_and_listed_without_its_secret() {
    let f = fixture().await;
    let (id, secret) = mint(&f, json!(["read", "generate"])).await;
    let stored: (String, Vec<String>) =
        sqlx::query_as("SELECT token_hash,capabilities FROM mcp_tokens WHERE id=$1::uuid")
            .bind(&id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(stored.0, format!("{:x}", Sha256::digest(secret.as_bytes())));
    assert_ne!(stored.0, secret);
    assert_eq!(stored.1, vec!["read", "generate"]);
    let listed = request(
        &reqwest::Client::new(),
        reqwest::Method::GET,
        format!("{}/api/v1/workspaces/{}/mcp-tokens", f.origin, f.workspace),
        &f,
    )
    .send()
    .await
    .unwrap()
    .text()
    .await
    .unwrap();
    assert!(listed.contains(&id) && !listed.contains(&secret) && !listed.contains("token_hash"));
    for bad in [json!([]), json!(["read", "approve"])] {
        let status = request(
            &reqwest::Client::new(),
            reqwest::Method::POST,
            format!("{}/api/v1/workspaces/{}/mcp-tokens", f.origin, f.workspace),
            &f,
        )
        .json(&json!({"name":"x","capabilities":bad}))
        .send()
        .await
        .unwrap()
        .status();
        assert_eq!(status, 422);
    }
    // No bearer token, or an unknown one, never reaches the endpoint.
    let anonymous = reqwest::Client::new()
        .post(format!("{}/api/v1/mcp", f.origin))
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);
    assert_eq!(
        client(&f, "weft_mcp_nope").raw(json!({})).await.status(),
        401
    );
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn endpoint_serves_exactly_the_read_and_propose_tools_with_no_apply_or_approve() {
    let f = fixture().await;
    let (_, secret) = mint(&f, json!(["read", "generate", "split", "link"])).await;
    let c = client(&f, &secret);
    assert_eq!(
        c.rpc("initialize", json!({})).await["result"]["serverInfo"]["name"],
        "weft"
    );
    let mut names = c.tool_names().await;
    names.sort();
    let mut expected = vec![
        "get_skill",
        "get_task",
        "list_attributes",
        "list_skills",
        "list_teams",
        "list_vaults",
        "propose_links",
        "propose_split",
        "propose_tasks",
        "read_note",
        "search_notes",
        "search_tasks",
        "validate_proposal",
    ];
    expected.sort();
    assert_eq!(names, expected);
    for name in [
        "approve_proposal",
        "apply_proposal",
        "update_task",
        "create_task",
        "shell",
    ] {
        let response = c.call(name, json!({"proposal_id":Uuid::new_v4()})).await;
        assert_eq!(response["error"]["code"], -32602, "{name}");
    }
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn effective_permission_is_user_access_intersected_with_token_capabilities() {
    let f = fixture().await;
    let visible = project(&f, "Visible", "restricted", true).await;
    let hidden = project(&f, "Hidden", "restricted", false).await;
    task(&f, visible, "Quarterly report visible").await;
    task(&f, hidden, "Quarterly report hidden").await;
    let (_, read_secret) = mint(&f, json!(["read"])).await;
    let reader = client(&f, &read_secret);
    // The token can read, but only what the user can read.
    let found = payload(
        &reader
            .call("search_tasks", json!({"query":"Quarterly"}))
            .await,
    );
    let titles: Vec<String> = found["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["data"]["title"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(titles, vec!["Quarterly report visible"]);
    // Tool results are labelled as data.
    assert_eq!(found["results"][0]["content_type"], "untrusted_data");
    assert_eq!(found["results"][0]["source"]["kind"], "task");
    // A read-only token has no propose tools and cannot call them.
    assert!(!reader
        .tool_names()
        .await
        .iter()
        .any(|n| n.starts_with("propose")));
    let denied = reader
        .call("propose_tasks", json!({"items":[draft(visible,"X")]}))
        .await;
    assert_eq!(denied["error"]["code"], -32602);
    // A propose-only token cannot read.
    let (_, propose_secret) = mint(&f, json!(["generate"])).await;
    let proposer = client(&f, &propose_secret);
    assert!(!proposer
        .tool_names()
        .await
        .iter()
        .any(|n| n == "search_tasks"));
    assert_eq!(
        proposer
            .call("search_tasks", json!({"query":"Quarterly"}))
            .await["error"]["code"],
        -32602
    );
    // A generate token cannot propose a split or links.
    assert_eq!(
        proposer.call("propose_links", json!({"items":[]})).await["error"]["code"],
        -32602
    );
    // The user's access does not reach the hidden project through propose either.
    let outside = proposer
        .call("propose_tasks", json!({"items":[draft(hidden,"Sneak in")]}))
        .await;
    assert_eq!(outside["result"]["isError"], true);
    let proposals: i64 = sqlx::query_scalar("SELECT count(*) FROM proposals")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(proposals, 0);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_the_token_or_removing_access_takes_effect_on_the_next_call() {
    let f = fixture().await;
    let shared = project(&f, "Shared", "restricted", true).await;
    task(&f, shared, "Quarterly report").await;
    let (id, secret) = mint(&f, json!(["read"])).await;
    let c = client(&f, &secret);
    let count = |value: &Value| payload(value)["results"].as_array().unwrap().len();
    assert_eq!(
        count(&c.call("search_tasks", json!({"query":"Quarterly"})).await),
        1
    );
    // Removing the user's Project access empties the very next read.
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1")
        .bind(shared)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        count(&c.call("search_tasks", json!({"query":"Quarterly"})).await),
        0
    );
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')")
        .bind(f.workspace).bind(shared).bind(f.user).execute(&f.db).await.unwrap();
    assert_eq!(
        count(&c.call("search_tasks", json!({"query":"Quarterly"})).await),
        1
    );
    // Revoking the token in Settings stops the next call.
    let status = request(
        &reqwest::Client::new(),
        reqwest::Method::DELETE,
        format!(
            "{}/api/v1/workspaces/{}/mcp-tokens/{id}",
            f.origin, f.workspace
        ),
        &f,
    )
    .send()
    .await
    .unwrap()
    .status();
    assert_eq!(status, 204);
    assert_eq!(
        c.raw(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .await
            .status(),
        401
    );
    // A second token dies when the user leaves the Workspace.
    let (_, other) = mint(&f, json!(["read"])).await;
    let c2 = client(&f, &other);
    assert_eq!(
        c2.raw(json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
            .await
            .status(),
        200
    );
    sqlx::query("DELETE FROM workspace_memberships WHERE user_id=$1")
        .bind(f.user)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        c2.raw(json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
            .await
            .status(),
        401
    );
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_made_through_mcp_is_ready_for_the_user_and_no_token_can_approve_it() {
    let f = fixture().await;
    let p = project(&f, "Plan", "restricted", true).await;
    let (_, secret) = mint(&f, json!(["generate"])).await;
    let c = client(&f, &secret);
    let result = c
        .call("propose_tasks", json!({"items":[draft(p,"Brand new unrelated chore")],"assumptions":["thin input"],"open_questions":["Who owns it?"]}))
        .await;
    assert_eq!(result["result"]["isError"], false, "{result}");
    let made = payload(&result);
    assert_eq!(made["status"], "ready");
    let id = made["proposal_id"].as_str().unwrap();
    let url = format!(
        "{}/api/v1/workspaces/{}/proposals/{id}",
        f.origin, f.workspace
    );
    let shown: Value = request(
        &reqwest::Client::new(),
        reqwest::Method::GET,
        url.clone(),
        &f,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(shown["status"], "ready");
    assert_eq!(shown["provider"], "mcp");
    assert_eq!(shown["open_questions"][0], "Who owns it?");
    let initiator: Uuid =
        sqlx::query_scalar("SELECT initiator_id FROM proposals WHERE id=$1::uuid")
            .bind(id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(initiator, f.user);
    // The bearer token alone reaches no session route, so it cannot approve, read or undo.
    for suffix in ["approve", "undo", "validate"] {
        let status = reqwest::Client::new()
            .post(format!("{url}/{suffix}"))
            .header("authorization", &c.bearer)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(status, 401, "{suffix}");
    }
    let status = reqwest::Client::new()
        .get(&url)
        .header("authorization", &c.bearer)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 401);
    let tasks: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE project_id=$1")
        .bind(p)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(tasks, 0);
    let still: String = sqlx::query_scalar("SELECT status FROM proposals WHERE id=$1::uuid")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(still, "ready");
    // A signed-in session can approve it; the approval is audited as an MCP-sourced Proposal.
    let approved = request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{url}/approve"),
        &f,
    )
    .header("idempotency-key", Uuid::new_v4().to_string())
    .json(&json!({"revision":shown["revision"]}))
    .send()
    .await
    .unwrap();
    assert_eq!(approved.status(), 200, "{}", approved.text().await.unwrap());
    let audited: (String, Option<Uuid>) = sqlx::query_as(
        "SELECT provider,connection_id FROM ai_approval_audit WHERE proposal_id=$1::uuid",
    )
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(audited, ("mcp".to_owned(), None));
    // The dry run stores nothing and invalid drafts come back as tool errors.
    let valid = payload(
        &c.call("validate_proposal", json!({"items":[draft(p,"Another")]}))
            .await,
    );
    assert_eq!(valid["valid"], true);
    let invalid = c
        .call(
            "validate_proposal",
            json!({"items":[json!({"id":"x","kind":"task"})]}),
        )
        .await;
    assert_eq!(invalid["result"]["isError"], true);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM proposals")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn results_are_bounded_like_the_web_tools_and_calls_are_rate_limited_per_token() {
    let f = fixture().await;
    let p = project(&f, "Busy", "restricted", true).await;
    for n in 0..30 {
        task(&f, p, &format!("Quarterly item {n}")).await;
    }
    let (_, secret) = mint(&f, json!(["read"])).await;
    let c = client(&f, &secret);
    let found = payload(&c.call("search_tasks", json!({"query":"Quarterly"})).await);
    assert_eq!(found["results"].as_array().unwrap().len(), 20);
    assert_eq!(found["truncated"], true);
    assert!(found["total_size"].as_u64().unwrap() > 0);
    // Per-token limit: another token is unaffected by this one running out.
    let (_, quiet) = mint(&f, json!(["read"])).await;
    let mut limited = None;
    for _ in 0..80 {
        let response = c.raw(json!({"jsonrpc":"2.0","id":1,"method":"ping"})).await;
        if response.status() == 429 {
            limited = Some(response);
            break;
        }
    }
    let limited = limited.expect("token was never rate limited");
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(
        client(&f, &quiet)
            .raw(json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
            .await
            .status(),
        200
    );
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn knowledge_capability_lists_only_proposal_tools_for_note_edits_and_file_additions() {
    let f = fixture().await;
    let (_, secret) = mint(&f, json!(["knowledge"])).await;
    let names = client(&f, &secret).tool_names().await;
    assert!(names.contains(&"propose_note_edit".to_owned()));
    assert!(names.contains(&"propose_file_add".to_owned()));
    assert!(!names
        .iter()
        .any(|name| name.contains("apply") || name.contains("approve")));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disable_landing_with_the_proposal_insert_leaves_no_proposal_and_no_revived_run() {
    let f = fixture().await;
    let p = project(&f, "Plan", "restricted", true).await;
    let (_, secret) = mint(&f, json!(["generate"])).await;
    let c = client(&f, &secret);
    // The cancel commits in the same transaction as the Proposal insert (worst-case timing).
    sqlx::raw_sql("CREATE FUNCTION cancel_run_after_proposal() RETURNS trigger AS $$ BEGIN UPDATE ai_runs SET state='canceled',summary='Canceled' WHERE id=NEW.ai_run_id; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER cancel_run_after_proposal AFTER INSERT ON proposals FOR EACH ROW EXECUTE FUNCTION cancel_run_after_proposal()")
        .execute(&f.db)
        .await
        .unwrap();
    let result = c
        .call("propose_tasks", json!({"items":[draft(p,"Late chore")]}))
        .await;
    assert_eq!(result["result"]["isError"], true, "{result}");
    let proposals: i64 = sqlx::query_scalar("SELECT count(*) FROM proposals")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(proposals, 0);
    let state: String =
        sqlx::query_scalar("SELECT state FROM ai_runs WHERE mcp_token_id IS NOT NULL")
            .fetch_one(&f.db)
            .await
            .unwrap();
    // The trigger's cancel rolled back with the refused Proposal, so the call fails the run.
    assert_eq!(state, "failed", "the run is not revived");
    cleanup(f).await;
}
