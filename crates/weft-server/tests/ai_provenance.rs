#![allow(dead_code)]

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
    connection: Uuid,
}

async fn fixture() -> Fixture {
    env::set_var(
        "WEFT_AGENT_SIGNING_KEY",
        "runner-test-signing-key-012345678901234567890123456789",
    );
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("ai_runs_{}", Uuid::new_v4().simple());
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
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) VALUES($1,'workspace',$2,'scripted','provider_cli','api','ready','ready',$3)")
        .bind(connection).bind(workspace).bind(user).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO ai_connection_grants(connection_id,workspace_id) VALUES($1,$2)")
        .bind(connection)
        .bind(workspace)
        .execute(&db)
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
        connection,
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

struct Agent {
    client: reqwest::Client,
    root: String,
    bearer: String,
    job: String,
    run: String,
    project: Uuid,
    other_project: Uuid,
    task: Uuid,
    task_version: i64,
}

async fn start_run(f: &Fixture, capability: &str, reuse: Option<(Uuid, Uuid)>) -> Agent {
    let client = reqwest::Client::new();
    let root = format!("{}/api/v1/ai", f.origin);
    let (project, task) = reuse.unwrap_or_else(|| (Uuid::new_v4(), Uuid::new_v4()));
    let other_project = Uuid::new_v4();
    if reuse.is_none() {
        for (id, name) in [(project, "Scoped"), (other_project, "Other")] {
            sqlx::query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,'workspace',$4)")
                .bind(id).bind(f.workspace).bind(name).bind(f.user).execute(&f.db).await.unwrap();
            sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')")
                .bind(f.workspace).bind(id).bind(f.user).execute(&f.db).await.unwrap();
        }
        sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,created_by) VALUES($1,$2,1,$3,'Publish the quarterly report',$4,$5)")
            .bind(task).bind(f.workspace).bind(project).bind("Collect numbers").bind(f.user).execute(&f.db).await.unwrap();
        sqlx::query("UPDATE workspaces SET next_task_number=2 WHERE id=$1")
            .bind(f.workspace)
            .execute(&f.db)
            .await
            .unwrap();
    }
    let task_version: i64 = sqlx::query_scalar("SELECT version FROM tasks WHERE id=$1")
        .bind(task)
        .fetch_one(&f.db)
        .await
        .unwrap();
    let code: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{root}/connections/{}/runners/pairing-codes", f.connection),
        f,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let paired: serde_json::Value = client
        .post(format!("{root}/agent/pair"))
        .json(&serde_json::json!({"code":code["code"],"name":"scripted","version":"test","supported_modes":["scripted"]}))
        .send().await.unwrap().json().await.unwrap();
    let bearer = format!("Bearer {}", paired["token"].as_str().unwrap());
    client
        .post(format!("{root}/agent/heartbeat"))
        .header("authorization", &bearer)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    let started: serde_json::Value = request(&client, reqwest::Method::POST, format!("{root}/runs"), f)
        .json(&serde_json::json!({"workspace_id":f.workspace,"connection_id":f.connection,"capability":capability,"scope":{"projects":[project]},"prompt":"plan"}))
        .send().await.unwrap().json().await.unwrap();
    let lease: serde_json::Value = client
        .post(format!("{root}/agent/jobs/lease"))
        .header("authorization", &bearer)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    Agent {
        client,
        root,
        bearer,
        job: lease["job"]["id"].as_str().unwrap().to_owned(),
        run: started["id"].as_str().unwrap().to_owned(),
        project,
        other_project,
        task,
        task_version,
    }
}

impl Agent {
    async fn tool(&self, call: serde_json::Value) -> (reqwest::StatusCode, serde_json::Value) {
        let response = self
            .client
            .post(format!("{}/agent/jobs/{}/tools", self.root, self.job))
            .header("authorization", &self.bearer)
            .json(&serde_json::json!({ "call": call }))
            .send()
            .await
            .unwrap();
        let status = response.status();
        (status, response.json().await.unwrap_or_default())
    }

    async fn validate(&self, items: serde_json::Value) -> serde_json::Value {
        let (status, body) = self
            .tool(serde_json::json!({"tool":"validate_proposal","proposal":{"schema_version":1,"items":items,"assumptions":[],"open_questions":[]}}))
            .await;
        assert_eq!(status, reqwest::StatusCode::OK);
        body
    }

    async fn complete(&self, proposal: serde_json::Value) {
        let response = self
            .client
            .post(format!("{}/agent/jobs/{}/result", self.root, self.job))
            .header("authorization", &self.bearer)
            .json(&serde_json::json!({"result":{"summary":"done","outcome":"waiting_for_approval","proposal":proposal}}))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
    }

    async fn run_state(&self, f: &Fixture) -> serde_json::Value {
        request(
            &self.client,
            reqwest::Method::GET,
            format!("{}/runs/{}", self.root, self.run),
            f,
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
    }
}

fn draft(id: &str, project: Uuid, title: &str) -> serde_json::Value {
    serde_json::json!({"id":id,"kind":"task","project_id":project,"title":title,"reason":"needed","sources":[]})
}

fn relation(id: &str, kind: &str, source: &str, target: &str) -> serde_json::Value {
    serde_json::json!({"id":id,"kind":"relation","relation":kind,"source_task_id":source,"target_task_id":target,"reason":"order of work","sources":[]})
}

async fn json_of(response: reqwest::Response) -> (reqwest::StatusCode, serde_json::Value) {
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

fn selected(proposal: &serde_json::Value) -> Vec<(String, bool)> {
    proposal["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["id"].as_str().unwrap().to_owned(),
                item["selected"] == true,
            )
        })
        .collect()
}

struct Plan {
    proposal: String,
    parent: Uuid,
    child: Uuid,
}

fn plan_url(f: &Fixture, id: &str) -> String {
    format!(
        "{}/api/v1/workspaces/{}/proposals/{id}",
        f.origin, f.workspace
    )
}

/// Approves the Proposal the completed run produced and returns its id.
async fn approve_completed(f: &Fixture, a: &Agent) -> String {
    let run = a.run_state(f).await;
    let id = run["result"]["proposal_id"].as_str().unwrap().to_owned();
    let (_, proposal) = json_of(
        request(&a.client, reqwest::Method::GET, plan_url(f, &id), f)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let (status, applied) = json_of(
        request(
            &a.client,
            reqwest::Method::POST,
            format!("{}/approve", plan_url(f, &id)),
            f,
        )
        .header("idempotency-key", Uuid::new_v4().to_string())
        .json(&serde_json::json!({"revision":proposal["revision"]}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{applied}");
    id
}

/// Completes the run with a two-Task plan joined by a `blocks` link, then approves it.
async fn approved_plan(f: &Fixture, a: &Agent) -> Plan {
    let (status, read) = a
        .tool(serde_json::json!({"tool":"get_task","task_id":a.task}))
        .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{read}");
    let parent = draft("tmp-parent", a.project, "Build the billing API");
    let mut child = draft("tmp-child", a.project, "Verify the API with QA");
    child["depends_on"] = serde_json::json!(["tmp-parent"]);
    a.complete(serde_json::json!({
        "schema_version":1,
        "items":[parent, child, relation("tmp-link","blocks","tmp-parent","tmp-child")],
        "assumptions":[],"open_questions":[]
    }))
    .await;
    let run = a.run_state(f).await;
    let id = run["result"]["proposal_id"].as_str().unwrap().to_owned();
    let (_, proposal) = json_of(
        request(&a.client, reqwest::Method::GET, plan_url(f, &id), f)
            .send()
            .await
            .unwrap(),
    )
    .await;
    let (status, applied) = json_of(
        request(
            &a.client,
            reqwest::Method::POST,
            format!("{}/approve", plan_url(f, &id)),
            f,
        )
        .header("idempotency-key", Uuid::new_v4().to_string())
        .json(&serde_json::json!({"revision":proposal["revision"]}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{applied}");
    let created = applied["created_tasks"].as_array().unwrap();
    let find = |item: &str| {
        Uuid::parse_str(
            created.iter().find(|task| task["item_id"] == item).unwrap()["id"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    Plan {
        proposal: id,
        parent: find("tmp-parent"),
        child: find("tmp-child"),
    }
}

async fn undo(f: &Fixture, a: &Agent, plan: &Plan) -> (reqwest::StatusCode, serde_json::Value) {
    json_of(
        request(
            &a.client,
            reqwest::Method::POST,
            format!("{}/undo", plan_url(f, &plan.proposal)),
            f,
        )
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap(),
    )
    .await
}

async fn history(f: &Fixture, task: Uuid) -> Vec<serde_json::Value> {
    let (status, body) = json_of(
        request(
            &reqwest::Client::new(),
            reqwest::Method::GET,
            format!("{}/api/v1/tasks/{task}/history", f.origin),
            f,
        )
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    body["operations"].as_array().unwrap().clone()
}

async fn active_tasks(f: &Fixture, project: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM tasks WHERE project_id=$1 AND archived_at IS NULL")
        .bind(project)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

async fn extra_user(f: &Fixture, role: &str) -> Fixture2 {
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(user)
        .bind(format!("{role}-{}@example.com", Uuid::new_v4().simple()))
        .execute(&f.db)
        .await
        .unwrap();
    if role != "outsider" {
        sqlx::query(
            "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
        )
        .bind(f.workspace)
        .bind(user)
        .bind(role)
        .execute(&f.db)
        .await
        .unwrap();
    }
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4())
        .bind(user)
        .bind(format!("{:x}", Sha256::digest(token.as_bytes())))
        .bind(&csrf)
        .execute(&f.db)
        .await
        .unwrap();
    Fixture2 {
        user,
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
    }
}

struct Fixture2 {
    user: Uuid,
    cookie: String,
}

async fn audit_as(f: &Fixture, cookie: &str) -> (reqwest::StatusCode, serde_json::Value) {
    json_of(
        reqwest::Client::new()
            .get(format!(
                "{}/api/v1/workspaces/{}/ai/audit",
                f.origin, f.workspace
            ))
            .header(reqwest::header::COOKIE, cookie)
            .send()
            .await
            .unwrap(),
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn history_names_the_approver_as_actor_and_the_ai_run_provider_and_proposal_as_source() {
    let f = fixture().await;
    let a = start_run(&f, "generate", None).await;
    let plan = approved_plan(&f, &a).await;
    for task in [plan.parent, plan.child] {
        let operations = history(&f, task).await;
        assert!(!operations.is_empty());
        for operation in &operations {
            assert_eq!(operation["actor_id"], f.user.to_string(), "{operation}");
            assert_eq!(operation["source"]["kind"], "ai_proposal", "{operation}");
            assert_eq!(operation["source"]["run_id"], a.run, "{operation}");
            assert_eq!(operation["source"]["provider"], "scripted", "{operation}");
            assert_eq!(
                operation["source"]["proposal_id"], plan.proposal,
                "{operation}"
            );
        }
    }
    // A hand edit of the same Task is not attributed to the AI run.
    let version: i64 = sqlx::query_scalar("SELECT version FROM tasks WHERE id=$1")
        .bind(plan.parent)
        .fetch_one(&f.db)
        .await
        .unwrap();
    let edited = request(
        &a.client,
        reqwest::Method::PATCH,
        format!("{}/api/v1/tasks/{}", f.origin, plan.parent),
        &f,
    )
    .json(&serde_json::json!({"expected_version":version,"title":"Build the invoicing API"}))
    .send()
    .await
    .unwrap();
    assert_eq!(edited.status(), reqwest::StatusCode::OK);
    let operations = history(&f, plan.parent).await;
    let title = operations.iter().find(|op| op["field"] == "title").unwrap();
    assert!(title["source"].is_null(), "{title}");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn undo_checks_the_whole_group_and_lists_conflicts_without_applying_anything() {
    let f = fixture().await;
    let a = start_run(&f, "generate", None).await;
    let plan = approved_plan(&f, &a).await;
    assert_eq!(active_tasks(&f, a.project).await, 3);

    // Someone edits one generated Task.
    let edited = request(
        &a.client,
        reqwest::Method::PATCH,
        format!("{}/api/v1/tasks/{}", f.origin, plan.parent),
        &f,
    )
    .json(&serde_json::json!({"expected_version":2,"title":"Build the invoicing API"}))
    .send()
    .await
    .unwrap();
    assert_eq!(
        edited.status(),
        reqwest::StatusCode::OK,
        "{}",
        edited.text().await.unwrap()
    );
    let (status, body) = undo(&f, &a, &plan).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["applied"], false);
    let listed = body["conflicts"].as_array().unwrap();
    assert!(
        listed
            .iter()
            .any(|c| c["task_id"] == plan.parent.to_string()),
        "{body}"
    );
    // Nothing was applied: both generated Tasks and the link are still there.
    assert_eq!(active_tasks(&f, a.project).await, 3);
    let links: i64 = sqlx::query_scalar("SELECT count(*) FROM task_relations WHERE kind='blocks'")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(links, 1);
    let status: String = sqlx::query_scalar("SELECT status FROM proposals WHERE id=$1")
        .bind(Uuid::parse_str(&plan.proposal).unwrap())
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(status, "applied");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_added_to_a_generated_task_blocks_undo_and_is_listed() {
    let f = fixture().await;
    let a = start_run(&f, "generate", None).await;
    let plan = approved_plan(&f, &a).await;
    let linked = request(
        &a.client,
        reqwest::Method::POST,
        format!("{}/api/v1/tasks/{}/relations", f.origin, plan.child),
        &f,
    )
    .json(&serde_json::json!({"target_task_id":a.task,"kind":"related"}))
    .send()
    .await
    .unwrap();
    assert!(linked.status().is_success(), "{}", linked.status());
    let (status, body) = undo(&f, &a, &plan).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["applied"], false);
    assert!(
        body["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["task_id"] == plan.child.to_string()),
        "{body}"
    );
    assert_eq!(active_tasks(&f, a.project).await, 3);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn clean_undo_archives_generated_tasks_as_one_group_and_audit_outlives_it() {
    let f = fixture().await;
    let a = start_run(&f, "generate", None).await;
    let plan = approved_plan(&f, &a).await;
    let admin = extra_user(&f, "admin").await;
    let member = extra_user(&f, "member").await;
    let outsider = extra_user(&f, "outsider").await;

    let (status, body) = undo(&f, &a, &plan).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["archived_tasks"], 2);
    assert_eq!(active_tasks(&f, a.project).await, 1);
    let archived: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM tasks WHERE project_id=$1 AND archived_at IS NOT NULL",
    )
    .bind(a.project)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(archived, 2, "generated Tasks are archived, not deleted");

    // The run, source and approval audit stays readable by the run owner after the undo.
    let (status, audit) = audit_as(&f, &f.cookie).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    let record = &audit["records"][0];
    assert_eq!(record["run_id"], a.run);
    assert_eq!(record["proposal_id"], plan.proposal);
    assert_eq!(record["provider"], "scripted");
    assert_eq!(record["approved_by"], f.user.to_string());
    assert_eq!(record["created_task_count"], 2);
    assert!(record["undone_at"].is_string(), "{record}");
    assert_eq!(record["undone_by"], f.user.to_string());
    assert!(record["run_summary"].is_string());
    assert!(
        !record["sources"].as_array().unwrap().is_empty(),
        "{record}"
    );
    // The run itself is also still there.
    assert_eq!(a.run_state(&f).await["state"], "waiting_for_approval");

    // A Workspace admin sees that a plan was approved, never what the run read.
    let (status, seen) = audit_as(&f, &admin.cookie).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    let record = &seen["records"][0];
    assert_eq!(record["proposal_id"], plan.proposal);
    assert!(
        record.get("sources").is_none()
            && record.get("run_scope").is_none()
            && record.get("run_summary").is_none(),
        "{record}"
    );
    assert!(record["source_count"].as_i64().unwrap() > 0);
    // Plain members see nothing; non-members get no answer.
    let (status, seen) = audit_as(&f, &member.cookie).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert!(seen["records"].as_array().unwrap().is_empty());
    let (status, _) = audit_as(&f, &outsider.cookie).await;
    assert_eq!(status, reqwest::StatusCode::NOT_FOUND);
    let _ = (admin.user, member.user, outsider.user);

    // Retention: past the window the audit is unreadable and pruning removes it.
    sqlx::query("UPDATE ai_approval_audit SET expires_at=now()-interval '1 second'")
        .execute(&f.db)
        .await
        .unwrap();
    let (_, gone) = audit_as(&f, &f.cookie).await;
    assert!(gone["records"].as_array().unwrap().is_empty());
    let removed = weft_server::prune_ai_records(&f.db, 365).await.unwrap();
    assert_eq!(removed, 1);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn compaction_never_merges_changes_from_different_ai_runs() {
    let f = fixture().await;
    let first = start_run(&f, "link", None).await;
    let second_task = Uuid::new_v4();
    sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,created_by) VALUES($1,$2,2,$3,'Review the report',$4)")
        .bind(second_task)
        .bind(f.workspace)
        .bind(first.project)
        .bind(f.user)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("UPDATE workspaces SET next_task_number=3 WHERE id=$1")
        .bind(f.workspace)
        .execute(&f.db)
        .await
        .unwrap();
    let link_plan = |a: &Agent| serde_json::json!({"schema_version":1,"items":[relation("tmp-link","related",&a.task.to_string(),&second_task.to_string())],"assumptions":[],"open_questions":[]});
    first.complete(link_plan(&first)).await;
    let first_proposal = approve_completed(&f, &first).await;
    let (status, body) = undo(
        &f,
        &first,
        &Plan {
            proposal: first_proposal,
            parent: first.task,
            child: second_task,
        },
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");

    let second = start_run(&f, "link", Some((first.project, first.task))).await;
    second.complete(link_plan(&second)).await;
    approve_completed(&f, &second).await;

    let operations = history(&f, first.task).await;
    let links: Vec<_> = operations
        .iter()
        .filter(|op| op["field"].as_str().unwrap().starts_with("relation"))
        .collect();
    assert_eq!(links.len(), 1, "{operations:?}");
    assert_eq!(
        links[0]["source"]["run_id"], second.run,
        "the second run is not folded into the first"
    );
    assert_eq!(links[0]["before"], false);
    assert_eq!(links[0]["after"], true);
    assert_eq!(links[0]["actor_id"], f.user.to_string());
    cleanup(f).await;
}
