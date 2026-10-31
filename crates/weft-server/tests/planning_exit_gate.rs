//! Planning exit gate: the Goal, Milestones, linked Tasks, Review journey works end to end through
//! the scripted runner, no planning surface leaks a Restricted source to a member without access,
//! Schedules never borrow another sign-in and stop when revoked, and release names stay out of the
//! product. Cycle, time zone and recurrence arithmetic keep their own suites (`dependencies`,
//! `recurrence`, `ai_schedules`, `smart_lists_advanced`), which run in the same `cargo test`.
#![allow(dead_code)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, path::Path, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Who {
    id: Uuid,
    cookie: String,
    csrf: String,
}

struct Fixture {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    db: sqlx::PgPool,
    workspace: Uuid,
    owner: Who,
    /// A Workspace member with no Project membership at all.
    outsider: Who,
    connection: Uuid,
}

async fn session(db: &sqlx::PgPool, user: Uuid) -> Who {
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(user).bind(hash).bind(&csrf).execute(db).await.unwrap();
    Who {
        id: user,
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

async fn fixture() -> Fixture {
    env::set_var(
        "WEFT_AGENT_SIGNING_KEY",
        "runner-test-signing-key-012345678901234567890123456789",
    );
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("plan_gate_{}", Uuid::new_v4().simple());
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
    let (workspace, owner_id): (Uuid, Uuid) = sqlx::query_as(
        "SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let outsider_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'outsider@example.com','unused')",
    )
    .bind(outsider_id)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(outsider_id)
    .execute(&db)
    .await
    .unwrap();
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) VALUES($1,'workspace',$2,'scripted','provider_cli','api','ready','ready',$3)")
        .bind(connection).bind(workspace).bind(owner_id).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO ai_connection_grants(connection_id,workspace_id) VALUES($1,$2)")
        .bind(connection)
        .bind(workspace)
        .execute(&db)
        .await
        .unwrap();
    let owner = session(&db, owner_id).await;
    let outsider = session(&db, outsider_id).await;
    Fixture {
        origin,
        server,
        schema,
        admin,
        db,
        workspace,
        owner,
        outsider,
        connection,
    }
}

async fn cleanup(f: Fixture) {
    f.server.abort();
    f.db.close().await;
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&f.admin)
        .await
        .unwrap();
    f.admin.close().await;
    let _ = std::fs::remove_dir_all(env::temp_dir().join(format!("weft-{}", f.schema)));
}

fn call(f: &Fixture, who: &Who, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(method, format!("{}/api/v1{path}", f.origin))
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf)
        .header("idempotency-key", Uuid::new_v4().to_string())
}

async fn get(f: &Fixture, who: &Who, path: &str) -> (reqwest::StatusCode, String) {
    let response = call(f, who, reqwest::Method::GET, path)
        .send()
        .await
        .unwrap();
    (response.status(), response.text().await.unwrap())
}

async fn send_json(
    f: &Fixture,
    who: &Who,
    method: reqwest::Method,
    path: &str,
    body: Value,
) -> (reqwest::StatusCode, Value) {
    let response = call(f, who, method, path).json(&body).send().await.unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

async fn json_get(f: &Fixture, who: &Who, path: &str) -> Value {
    let (status, text) = get(f, who, path).await;
    assert_eq!(status, 200, "{path}: {text}");
    serde_json::from_str(&text).unwrap()
}

async fn next_number(f: &Fixture) -> i64 {
    sqlx::query_scalar("UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1")
        .bind(f.workspace)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

async fn add_project(f: &Fixture, name: &str, visibility: &str, members: &[(&Who, &str)]) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(f.workspace)
    .bind(name)
    .bind(visibility)
    .bind(f.owner.id)
    .execute(&f.db)
    .await
    .unwrap();
    for (who, role) in members {
        grant(f, id, who.id, role).await;
    }
    id
}

async fn grant(f: &Fixture, project: Uuid, user: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,$4)",
    )
    .bind(f.workspace)
    .bind(project)
    .bind(user)
    .bind(role)
    .execute(&f.db)
    .await
    .unwrap();
}

async fn add_task(
    f: &Fixture,
    project: Uuid,
    title: &str,
    start: Option<&str>,
    due: Option<&str>,
) -> Uuid {
    let id = Uuid::new_v4();
    let number = next_number(f).await;
    sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,created_by,start_date,due_date) VALUES($1,$2,$3,$4,$5,'',$6,$7::date,$8::date)")
        .bind(id).bind(f.workspace).bind(number).bind(project).bind(title).bind(f.owner.id).bind(start).bind(due)
        .execute(&f.db).await.unwrap();
    id
}

async fn add_milestone(f: &Fixture, project: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO milestones(id,workspace_id,project_id,name,target_date,created_by) VALUES($1,$2,$3,$4,'2026-12-01',$5)")
        .bind(id).bind(f.workspace).bind(project).bind(name).bind(f.owner.id)
        .execute(&f.db).await.unwrap();
    id
}

async fn relate(f: &Fixture, source: Uuid, target: Uuid) {
    sqlx::query("INSERT INTO task_relations(workspace_id,source_task_id,target_task_id,kind) VALUES($1,$2,$3,'blocks')")
        .bind(f.workspace).bind(source).bind(target).execute(&f.db).await.unwrap();
}

/// A paired scripted runner for the Workspace Connection.
struct Runner {
    client: reqwest::Client,
    root: String,
    bearer: String,
}

async fn pair(f: &Fixture) -> Runner {
    let client = reqwest::Client::new();
    let root = format!("{}/api/v1/ai", f.origin);
    let code: Value = call(
        f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/ai/connections/{}/runners/pairing-codes", f.connection),
    )
    .json(&json!({}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let paired: Value = client
        .post(format!("{root}/agent/pair"))
        .json(&json!({"code":code["code"],"name":"scripted","version":"test","supported_modes":["scripted"]}))
        .send().await.unwrap().json().await.unwrap();
    let bearer = format!("Bearer {}", paired["token"].as_str().unwrap());
    client
        .post(format!("{root}/agent/heartbeat"))
        .header("authorization", &bearer)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    Runner {
        client,
        root,
        bearer,
    }
}

/// A run started and leased: tools, result and state all go through its job.
struct Job {
    run: String,
    job: String,
}

impl Runner {
    async fn lease(&self) -> String {
        let lease: Value = self
            .client
            .post(format!("{}/agent/jobs/lease", self.root))
            .header("authorization", &self.bearer)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        lease["job"]["id"].as_str().unwrap().to_owned()
    }

    async fn tool(&self, job: &str, call: Value) -> (reqwest::StatusCode, Value) {
        let response = self
            .client
            .post(format!("{}/agent/jobs/{job}/tools", self.root))
            .header("authorization", &self.bearer)
            .json(&json!({ "call": call }))
            .send()
            .await
            .unwrap();
        let status = response.status();
        (status, response.json().await.unwrap_or_default())
    }

    async fn complete(&self, job: &str, result: Value) -> reqwest::StatusCode {
        self.client
            .post(format!("{}/agent/jobs/{job}/result", self.root))
            .header("authorization", &self.bearer)
            .json(&json!({ "result": result }))
            .send()
            .await
            .unwrap()
            .status()
    }
}

async fn start_run(
    f: &Fixture,
    who: &Who,
    capability: &str,
    projects: &[Uuid],
) -> (reqwest::StatusCode, Value) {
    send_json(
        f,
        who,
        reqwest::Method::POST,
        "/ai/runs",
        json!({"workspace_id":f.workspace,"connection_id":f.connection,"capability":capability,"scope":{"projects":projects},"prompt":"Plan and review the release"}),
    )
    .await
}

async fn begin(f: &Fixture, r: &Runner, capability: &str, projects: &[Uuid]) -> Job {
    let (status, started) = start_run(f, &f.owner, capability, projects).await;
    assert!(status.is_success(), "{started}");
    Job {
        run: started["id"].as_str().unwrap().to_owned(),
        job: r.lease().await,
    }
}

async fn run_state(f: &Fixture, run: &str) -> Value {
    json_get(f, &f.owner, &format!("/ai/runs/{run}")).await
}

async fn version_of(f: &Fixture, table: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(&format!("SELECT version FROM {table} WHERE id=$1"))
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

async fn proposal(f: &Fixture, id: &str) -> Value {
    json_get(
        f,
        &f.owner,
        &format!("/workspaces/{}/proposals/{id}", f.workspace),
    )
    .await
}

async fn approve(f: &Fixture, id: &str) -> Value {
    let revision = proposal(f, id).await["revision"].as_i64().unwrap();
    let (status, body) = send_json(
        f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/workspaces/{}/proposals/{id}/approve", f.workspace),
        json!({"revision":revision}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body
}

async fn undo(f: &Fixture, id: &str) {
    let (status, body) = send_json(
        f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/workspaces/{}/proposals/{id}/undo", f.workspace),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
}

async fn set_status(f: &Fixture, task: Uuid, status: &str) {
    let version = version_of(f, "tasks", task).await;
    let (code, body) = send_json(
        f,
        &f.owner,
        reqwest::Method::PATCH,
        &format!("/tasks/{task}"),
        json!({"expected_version":version,"status":status}),
    )
    .await;
    assert_eq!(code, 200, "{body}");
}

async fn milestone_of(f: &Fixture, task: Uuid) -> Option<Uuid> {
    sqlx::query_scalar("SELECT milestone_id FROM tasks WHERE id=$1")
        .bind(task)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

async fn target_date(f: &Fixture, milestone: Uuid) -> String {
    sqlx::query_scalar("SELECT target_date::text FROM milestones WHERE id=$1")
        .bind(milestone)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

async fn due_dates(f: &Fixture, project: Uuid) -> Vec<Option<String>> {
    sqlx::query_scalar("SELECT due_date::text FROM tasks WHERE project_id=$1 ORDER BY number")
        .bind(project)
        .fetch_all(&f.db)
        .await
        .unwrap()
}

// Goal -> Milestones -> linked Tasks -> Review: plan, approve, see progress, review, approve the
// fixes, undo; then deliver and take the delivery back. Nothing moves a date or a Milestone by itself.
#[tokio::test(flavor = "multi_thread")]
async fn the_planning_journey_runs_end_to_end_through_the_scripted_runner() {
    let f = fixture().await;
    let runner = pair(&f).await;
    let project = add_project(&f, "Release", "workspace", &[(&f.owner, "manager")]).await;
    let a = add_task(
        &f,
        project,
        "Write the release notes",
        None,
        Some("2026-11-20"),
    )
    .await;
    let b = add_task(&f, project, "Publish the release", None, Some("2020-01-01")).await;
    let dates_before = due_dates(&f, project).await;

    // 1. Plan a Milestone Proposal. The run alone writes nothing.
    let plan = begin(&f, &runner, "plan", &[project]).await;
    let (va, vb) = (
        version_of(&f, "tasks", a).await,
        version_of(&f, "tasks", b).await,
    );
    let items = json!([
        {"id":"tmp-m","kind":"milestone","project_id":project,"name":"Closed beta","description":"First users","target_date":"2026-12-15","reason":"The goal names a beta","sources":[]},
        {"id":"tmp-a","kind":"milestone_assign","task_id":a,"milestone_id":"tmp-m","expected_version":va,"reason":"Part of the beta","sources":[]},
        {"id":"tmp-b","kind":"milestone_assign","task_id":b,"milestone_id":"tmp-m","expected_version":vb,"reason":"Part of the beta","sources":[]},
        {"id":"tmp-link","kind":"relation","relation":"blocks","source_task_id":a,"target_task_id":b,"reason":"Notes come first","sources":[]}
    ]);
    let (status, valid) = runner
        .tool(&plan.job, json!({"tool":"validate_proposal","proposal":{"schema_version":1,"items":items,"assumptions":[],"open_questions":[]}}))
        .await;
    assert_eq!(status, 200);
    assert_eq!(valid["valid"], true, "{valid}");
    let body = json!({"summary":"done","outcome":"waiting_for_approval","proposal":{"schema_version":1,"items":items,"assumptions":["Beta users are staff"],"open_questions":[]}});
    assert!(runner.complete(&plan.job, body).await.is_success());
    let run = run_state(&f, &plan.run).await;
    assert_eq!(run["state"], "waiting_for_approval", "{run}");
    assert_eq!(
        milestone_of(&f, a).await,
        None,
        "a plan run alone writes nothing"
    );
    let plan_proposal = run["result"]["proposal_id"].as_str().unwrap().to_owned();

    // 2. Approve it: one Milestone, both Tasks in it.
    let applied = approve(&f, &plan_proposal).await;
    let milestone: Uuid = applied["created_milestones"][0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(milestone_of(&f, a).await, Some(milestone));
    assert_eq!(milestone_of(&f, b).await, Some(milestone));
    assert_eq!(
        due_dates(&f, project).await,
        dates_before,
        "dates never shift"
    );

    // 3. See progress and blockers.
    let overview = json_get(&f, &f.owner, &format!("/projects/{project}/overview")).await;
    let shown = &overview["milestones"][0];
    assert_eq!(shown["name"], "Closed beta", "{overview}");
    assert_eq!(shown["progress"]["percent"], 0, "{overview}");
    assert_eq!(overview["blocked"]["count"], 1, "{overview}");
    assert_eq!(overview["overdue"]["count"], 1, "{overview}");
    let blockers = json_get(
        &f,
        &f.owner,
        &format!("/workspaces/{}/blockers", f.workspace),
    )
    .await;
    assert_eq!(
        blockers["blocked"][0]["task"]["title"],
        "Publish the release"
    );

    // 4. Run a review; its fixes arrive as one Proposal and write nothing until approved.
    let review = begin(&f, &runner, "progress_review", &[project]).await;
    let (status, risks) = runner
        .tool(&review.job, json!({"tool":"list_progress_risks"}))
        .await;
    assert_eq!(status, 200, "{risks}");
    assert_eq!(risks["results"][0]["content_type"], "untrusted_data");
    let mversion = version_of(&f, "milestones", milestone).await;
    let fixes = json!([
        {"id":"tmp-mu","kind":"milestone_update","milestone_id":milestone,"expected_version":mversion,"target_date":"2027-01-31","reason":"The work is behind","sources":[]}
    ]);
    let body = json!({"summary":"done","outcome":"waiting_for_approval","proposal":{"schema_version":1,"items":fixes,"assumptions":["Dates are not shifted"],"open_questions":[]}});
    assert!(runner.complete(&review.job, body).await.is_success());
    let run = run_state(&f, &review.run).await;
    assert_eq!(run["state"], "waiting_for_approval", "{run}");
    assert_eq!(target_date(&f, milestone).await, "2026-12-15");
    let fix_proposal = run["result"]["proposal_id"].as_str().unwrap().to_owned();

    // 5. Approve its fixes, then undo them. Only the Milestone date moves; no Task date does.
    approve(&f, &fix_proposal).await;
    assert_eq!(target_date(&f, milestone).await, "2027-01-31");
    assert_eq!(due_dates(&f, project).await, dates_before);
    undo(&f, &fix_proposal).await;
    assert_eq!(target_date(&f, milestone).await, "2026-12-15");

    // 6. Finish the work: the Milestone asks a Manager to confirm and never completes itself.
    set_status(&f, a, "completed").await;
    set_status(&f, b, "completed").await;
    let done = json_get(&f, &f.owner, &format!("/milestones/{milestone}")).await;
    assert_eq!(done["state"], "planned", "{done}");
    assert_eq!(done["progress"]["percent"], 100);
    assert_eq!(done["progress"]["ready_to_confirm"], true);
    let (status, confirmed) = send_json(
        &f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/milestones/{milestone}/confirm-delivery"),
        json!({"expected_version":done["version"]}),
    )
    .await;
    assert_eq!(status, 200, "{confirmed}");
    assert_eq!(confirmed["state"], "completed");
    let (status, back) = send_json(
        &f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/milestones/{milestone}/undo-delivery"),
        json!({"expected_version":confirmed["version"]}),
    )
    .await;
    assert_eq!(status, 200, "{back}");
    assert_eq!(back["state"], "planned");
    cleanup(f).await;
}

/// A Restricted Project with one of everything, and an open Project the outsider may read.
struct World {
    open: Uuid,
    hidden: Uuid,
    milestone: Uuid,
    open_task: Uuid,
    hidden_a: Uuid,
    hidden_b: Uuid,
}

const SECRETS: [&str; 4] = [
    "LEAK-MILESTONE",
    "LEAK-TASK-A",
    "LEAK-TASK-B",
    "LEAK-PROJECT",
];

async fn world(f: &Fixture) -> World {
    let open = add_project(
        f,
        "Open",
        "workspace",
        &[(&f.owner, "manager"), (&f.outsider, "viewer")],
    )
    .await;
    let hidden = add_project(f, "LEAK-PROJECT", "restricted", &[(&f.owner, "manager")]).await;
    let milestone = add_milestone(f, hidden, "LEAK-MILESTONE").await;
    let open_task = add_task(f, open, "Open work", Some("2026-11-03"), Some("2026-11-05")).await;
    let hidden_a = add_task(
        f,
        hidden,
        "LEAK-TASK-A",
        Some("2026-11-10"),
        Some("2026-11-12"),
    )
    .await;
    let hidden_b = add_task(
        f,
        hidden,
        "LEAK-TASK-B",
        Some("2026-11-13"),
        Some("2026-11-14"),
    )
    .await;
    for task in [hidden_a, hidden_b] {
        sqlx::query("UPDATE tasks SET milestone_id=$1 WHERE id=$2")
            .bind(milestone)
            .bind(task)
            .execute(&f.db)
            .await
            .unwrap();
    }
    // Edges in both directions across the access boundary.
    relate(f, hidden_a, open_task).await;
    relate(f, open_task, hidden_b).await;
    World {
        open,
        hidden,
        milestone,
        open_task,
        hidden_a,
        hidden_b,
    }
}

fn assert_clean(label: &str, body: &str, w: &World) {
    for secret in SECRETS {
        assert!(!body.contains(secret), "{label} leaks {secret}: {body}");
    }
    for id in [w.hidden, w.milestone, w.hidden_a, w.hidden_b] {
        assert!(
            !body.contains(&id.to_string()),
            "{label} leaks the id {id}: {body}"
        );
    }
}

/// A Restricted resource answers exactly like one that does not exist.
async fn assert_same_as_missing(f: &Fixture, who: &Who, real: &str, missing: &str, label: &str) {
    let (status, body) = get(f, who, real).await;
    let (missing_status, missing_body) = get(f, who, missing).await;
    assert_eq!(status, missing_status, "{label}: {body}");
    assert_eq!(status, 404, "{label}: {body}");
    assert_eq!(body, missing_body, "{label} differs from a missing id");
}

#[tokio::test(flavor = "multi_thread")]
async fn no_planning_surface_leaks_a_restricted_source_to_a_member_without_access() {
    let f = fixture().await;
    let w = world(&f).await;
    let me = &f.outsider;
    let ws = f.workspace;
    let ghost = Uuid::new_v4();

    // Milestones, progress, history and archive preview: the same answer as a missing id.
    assert_same_as_missing(
        &f,
        me,
        &format!("/projects/{}/milestones", w.hidden),
        &format!("/projects/{ghost}/milestones"),
        "milestone list",
    )
    .await;
    for suffix in ["", "/history", "/archive-preview"] {
        assert_same_as_missing(
            &f,
            me,
            &format!("/milestones/{}{suffix}", w.milestone),
            &format!("/milestones/{ghost}{suffix}"),
            &format!("milestone{suffix}"),
        )
        .await;
    }
    assert_same_as_missing(
        &f,
        me,
        &format!("/projects/{}/overview", w.hidden),
        &format!("/projects/{ghost}/overview"),
        "overview",
    )
    .await;
    // The writes refuse the same way and change nothing.
    let (status, body) = send_json(
        &f,
        me,
        reqwest::Method::PATCH,
        &format!("/milestones/{}", w.milestone),
        json!({"expected_version":1,"name":"taken"}),
    )
    .await;
    assert_eq!(status, 404, "{body}");
    let (status, body) = send_json(
        &f,
        me,
        reqwest::Method::POST,
        &format!("/milestones/{}/confirm-delivery", w.milestone),
        json!({"expected_version":1}),
    )
    .await;
    assert_eq!(status, 404, "{body}");
    let name: String = sqlx::query_scalar("SELECT name FROM milestones WHERE id=$1")
        .bind(w.milestone)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(name, "LEAK-MILESTONE");

    // The open Project's overview shows nothing of the hidden one.
    let (_, overview) = get(&f, me, &format!("/projects/{}/overview", w.open)).await;
    assert_clean("open overview", &overview, &w);

    // Blocker view: the open Task is blocked by something unreadable, with no title or id.
    let (status, blockers) = get(&f, me, &format!("/workspaces/{ws}/blockers")).await;
    assert_eq!(status, 200);
    assert_clean("blocker view", &blockers, &w);
    let parsed: Value = serde_json::from_str(&blockers).unwrap();
    assert_eq!(parsed["blocked"].as_array().unwrap().len(), 1, "{blockers}");
    assert_eq!(parsed["blocked"][0]["task"]["title"], "Open work");

    // Calendar: the date window holds only the open Task and counts only what the viewer reads.
    let (status, calendar) = get(
        &f,
        me,
        &format!("/workspaces/{ws}/tasks?from=2026-11-01&to=2026-11-30"),
    )
    .await;
    assert_eq!(status, 200);
    assert_clean("calendar", &calendar, &w);
    let parsed: Value = serde_json::from_str(&calendar).unwrap();
    assert_eq!(parsed["tasks"].as_array().unwrap().len(), 1, "{calendar}");
    let (_, all_tasks) = get(&f, me, &format!("/workspaces/{ws}/tasks")).await;
    assert_clean("task list", &all_tasks, &w);
    let (_, by_milestone) = get(
        &f,
        me,
        &format!("/workspaces/{ws}/tasks?milestone_id={}", w.milestone),
    )
    .await;
    assert_clean("milestone filter", &by_milestone, &w);

    // Timeline: edges to hidden Tasks are neutral stubs.
    let (status, timeline) = get(&f, me, &format!("/workspaces/{ws}/timeline-links")).await;
    assert_eq!(status, 200);
    assert_clean("timeline", &timeline, &w);

    // Smart Lists: a list the owner built over everything runs with the viewer's own access.
    let (status, list) = send_json(
        &f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/workspaces/{ws}/lists"),
        json!({"name":"Planning list","kind":"smart","query":{"logic":"and","filters":[{"field":"milestone_state","op":"eq","value":"planned"}],"sort":[],"group":null,"columns":["title"]}}),
    )
    .await;
    assert_eq!(status, 201, "{list}");
    let list_id = list["id"].as_str().unwrap();
    let (owner_status, owner_run) =
        get(&f, &f.owner, &format!("/workspaces/{ws}/lists/{list_id}")).await;
    assert_eq!(owner_status, 200);
    assert!(
        owner_run.contains("LEAK-TASK-A"),
        "the owner sees their own data"
    );
    let (_, my_run) = get(&f, me, &format!("/workspaces/{ws}/lists/{list_id}")).await;
    assert_clean("smart list run", &my_run, &w);
    let (_, my_lists) = get(&f, me, &format!("/workspaces/{ws}/lists")).await;
    assert!(
        !my_lists.contains("LEAK-TASK") && !my_lists.contains(&w.milestone.to_string()),
        "{my_lists}"
    );
    // Exporting the owner's list as the outsider never carries the hidden rows.
    let response = call(
        &f,
        me,
        reqwest::Method::POST,
        &format!("/workspaces/{ws}/tasks/export.csv"),
    )
    .json(&json!({"list_id":list_id}))
    .send()
    .await
    .unwrap();
    let csv = response.text().await.unwrap();
    assert_clean("csv from a list", &csv, &w);

    // CSV of the whole view: only the rows the exporter reads.
    let response = call(
        &f,
        me,
        reqwest::Method::POST,
        &format!("/workspaces/{ws}/tasks/export.csv"),
    )
    .json(&json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let csv = response.text().await.unwrap();
    assert_clean("csv", &csv, &w);
    assert!(csv.contains("Open work"));
    assert_eq!(
        csv.lines().filter(|line| !line.trim().is_empty()).count(),
        3,
        "header, the one readable row and the not-a-backup note: {csv}"
    );
    let _ = w.open_task;
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ai_context_never_carries_a_restricted_source_to_a_member_without_access() {
    let f = fixture().await;
    let w = world(&f).await;
    let runner = pair(&f).await;
    // The outsider cannot even scope a run to the hidden Project.
    let (status, body) = start_run(&f, &f.outsider, "plan", &[w.hidden]).await;
    assert!(!status.is_success(), "{status} {body}");
    assert_clean("refused run", &body.to_string(), &w);
    // A run over the open Project reads only what the outsider reads.
    for (capability, tool) in [
        ("plan", "list_milestones"),
        ("progress_review", "list_progress_risks"),
    ] {
        let (status, started) = start_run(&f, &f.outsider, capability, &[w.open]).await;
        assert!(status.is_success(), "{started}");
        let job = runner.lease().await;
        let (status, reply) = runner.tool(&job, json!({"tool":tool})).await;
        assert_eq!(status, 200, "{reply}");
        assert_clean(tool, &reply.to_string(), &w);
        let (_, hidden_read) = runner
            .tool(&job, json!({"tool":"get_task","task_id":w.hidden_a}))
            .await;
        assert_clean("hidden task read", &hidden_read.to_string(), &w);
        let run = json_get(
            &f,
            &f.outsider,
            &format!("/ai/runs/{}", started["id"].as_str().unwrap()),
        )
        .await;
        assert_clean("run record", &run.to_string(), &w);
        runner
            .complete(&job, json!({"summary":"done","outcome":"completed"}))
            .await;
    }
    cleanup(f).await;
}

async fn service_principal(f: &Fixture) -> Uuid {
    let (status, body) = send_json(
        f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/service-principals", f.workspace),
        json!({"name":"Weekly reviewer"}),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    body["id"].as_str().unwrap().parse().unwrap()
}

async fn schedule(f: &Fixture, principal: Uuid, project: Uuid) -> Uuid {
    let (status, body) = send_json(
        f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules", f.workspace),
        json!({"name":"Weekly review","principal_id":principal,"connection_id":f.connection,
            "scope":{"projects":[project]},"frequency":{"kind":"daily","time":"09:00"},
            "limits":{"runs_per_day":3,"characters":50000,"tool_calls":10}}),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["state"], "off", "a Schedule is off by default: {body}");
    let id: Uuid = body["id"].as_str().unwrap().parse().unwrap();
    let (status, body) = send_json(
        f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/enable", f.workspace),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    sqlx::query(
        "UPDATE ai_schedules SET next_run_at='2026-06-01T09:00:00Z'::timestamptz WHERE id=$1",
    )
    .bind(id)
    .execute(&f.db)
    .await
    .unwrap();
    id
}

#[tokio::test(flavor = "multi_thread")]
async fn schedule_output_is_invisible_to_a_member_without_access() {
    let f = fixture().await;
    let w = world(&f).await;
    let principal = service_principal(&f).await;
    grant(&f, w.hidden, principal, "manager").await;
    let id = schedule(&f, principal, w.hidden).await;
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    let runner = pair(&f).await;
    let job = runner.lease().await;
    let version = version_of(&f, "milestones", w.milestone).await;
    let items = json!([{"id":"tmp-mu","kind":"milestone_update","milestone_id":w.milestone,"expected_version":version,"target_date":"2027-01-31","reason":"LEAK-MILESTONE is behind","sources":[]}]);
    let done = runner
        .complete(&job, json!({"summary":"LEAK-MILESTONE review","outcome":"waiting_for_approval","proposal":{"schema_version":1,"items":items,"assumptions":[],"open_questions":[]}}))
        .await;
    assert!(done.is_success(), "{done}");
    let (_, queue) = get(
        &f,
        &f.owner,
        &format!("/workspaces/{}/proposal-queue", f.workspace),
    )
    .await;
    let queued: Value = serde_json::from_str(&queue).unwrap();
    assert_eq!(queued["proposals"].as_array().unwrap().len(), 1, "{queue}");
    let proposal_id = queued["proposals"][0]["id"].as_str().unwrap().to_owned();

    let me = &f.outsider;
    let (status, queue) = get(
        &f,
        me,
        &format!("/workspaces/{}/proposal-queue", f.workspace),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&queue).unwrap()["proposals"],
        json!([]),
        "no entry and no count of the queue"
    );
    assert_clean("queue", &queue, &w);
    assert_same_as_missing(
        &f,
        me,
        &format!("/workspaces/{}/proposals/{proposal_id}", f.workspace),
        &format!("/workspaces/{}/proposals/{}", f.workspace, Uuid::new_v4()),
        "scheduled proposal",
    )
    .await;
    // Schedule screens are Admin-only: a plain member gets a refusal that names nothing.
    for path in [
        format!("/workspaces/{}/ai/schedules", f.workspace),
        format!("/workspaces/{}/ai/schedules/{id}", f.workspace),
        format!("/workspaces/{}/ai/schedules/{id}/runs", f.workspace),
        format!("/workspaces/{}/ai/schedules/{id}/audit", f.workspace),
    ] {
        let (status, body) = get(&f, me, &path).await;
        assert!(!status.is_success(), "{path}: {status} {body}");
        assert_clean(&path, &body, &w);
    }
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_schedule_runs_as_its_principal_never_writes_and_stops_when_revoked() {
    let f = fixture().await;
    let w = world(&f).await;
    let principal = service_principal(&f).await;
    grant(&f, w.hidden, principal, "manager").await;
    let id = schedule(&f, principal, w.hidden).await;
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();

    // The run belongs to the principal, never to the admin who configured it or to anyone's sign-in.
    let initiator: Uuid =
        sqlx::query_scalar("SELECT initiator_id FROM ai_runs WHERE schedule_id=$1")
            .bind(id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(initiator, principal);
    assert_ne!(initiator, f.owner.id);
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id=$1")
        .bind(principal)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(sessions, 0, "a service principal has no sign-in");

    // It only proposes: nothing is applied by the run, and a late write after the emergency switch is refused.
    let runner = pair(&f).await;
    let job = runner.lease().await;
    let state: String = sqlx::query_scalar("SELECT state FROM ai_runs WHERE schedule_id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(state, "running");
    let (status, body) = send_json(
        &f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/disable", f.workspace),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "stopped");
    let state: String = sqlx::query_scalar("SELECT state FROM ai_runs WHERE schedule_id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(state, "canceled", "emergency disable cancels a running run");
    let version = version_of(&f, "milestones", w.milestone).await;
    let items = json!([{"id":"tmp-mu","kind":"milestone_update","milestone_id":w.milestone,"expected_version":version,"target_date":"2027-01-31","reason":"late","sources":[]}]);
    let late = runner
        .complete(&job, json!({"summary":"late","outcome":"waiting_for_approval","proposal":{"schema_version":1,"items":items,"assumptions":[],"open_questions":[]}}))
        .await;
    assert!(!late.is_success(), "a canceled run cannot be revived");
    assert_eq!(target_date(&f, w.milestone).await, "2026-12-01");
    let applied: i64 = sqlx::query_scalar("SELECT count(*) FROM proposals WHERE status='applied'")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(applied, 0, "a scheduled run never applies anything");
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM security_audit_events WHERE event='ai.schedule.disabled' AND subject_id=$1",
    )
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(audited, 1);

    // Enabling again is its own action; revoking the principal then stops the Schedule at the next tick.
    let (status, _) = send_json(
        &f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/enable", f.workspace),
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    sqlx::query(
        "UPDATE ai_schedules SET next_run_at='2026-06-02T09:00:00Z'::timestamptz WHERE id=$1",
    )
    .bind(id)
    .execute(&f.db)
    .await
    .unwrap();
    let (status, _) = send_json(
        &f,
        &f.owner,
        reqwest::Method::POST,
        &format!(
            "/workspaces/{}/ai/service-principals/{principal}/revoke",
            f.workspace
        ),
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    weft_server::run_due_schedules(&f.db, "2026-06-02T09:01:00Z")
        .await
        .unwrap();
    let stopped = json_get(
        &f,
        &f.owner,
        &format!("/workspaces/{}/ai/schedules/{id}", f.workspace),
    )
    .await;
    assert_eq!(stopped["state"], "stopped", "{stopped}");
    assert_eq!(stopped["stop_reason"], "principal_revoked");
    let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_runs WHERE schedule_id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(runs, 1, "no new run after revocation");
    cleanup(f).await;
}

// Release names never appear in code, API paths, configuration or tags, and the version is unchanged.
#[test]
fn release_names_stay_out_of_code_paths_configuration_and_the_version() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for dir in [
        "crates",
        "apps/web/src",
        "apps/web/public",
        "docker",
        "scripts",
    ] {
        collect(&root.join(dir), &mut files);
    }
    for name in [
        "Cargo.toml",
        "apps/web/package.json",
        "apps/web/index.html",
        "apps/web/vite.config.ts",
    ] {
        files.push(root.join(name));
    }
    let release = |text: &str| {
        let lower = text.to_lowercase();
        ["alpha", "beta"].iter().any(|name| {
            lower.match_indices(name).any(|(at, _)| {
                let before = lower[..at].chars().next_back();
                let after = lower[at + name.len()..].chars().next();
                // A separate word, identifier part or path segment, not part of a longer word.
                !before.is_some_and(char::is_alphanumeric)
                    && !after.is_some_and(char::is_alphabetic)
            })
        })
    };
    let mut offenders = Vec::new();
    for file in &files {
        let shown = file
            .strip_prefix(&root)
            .unwrap_or(file)
            .display()
            .to_string();
        if release(&shown) {
            offenders.push(format!("file name {shown}"));
        }
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        for (number, line) in text.lines().enumerate() {
            let in_test_fixture = shown.contains("/tests/") || line.contains("assert");
            let names_a_route_or_config = line.contains("\"/")
                || line.contains("WEFT_")
                || line.contains("env!(")
                || shown.ends_with(".toml")
                || shown.ends_with("package.json")
                || shown.ends_with(".yml")
                || shown.ends_with("Dockerfile");
            if release(line) && names_a_route_or_config && !in_test_fixture {
                offenders.push(format!("{shown}:{}: {}", number + 1, line.trim()));
            }
        }
    }
    assert!(offenders.is_empty(), "release names found: {offenders:#?}");
    let manifest = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(
        manifest.contains("version = \"0.1.0\""),
        "crate version changed: {manifest}"
    );
    let package = std::fs::read_to_string(root.join("apps/web/package.json")).unwrap();
    assert!(package.contains("\"version\": \"0.1.0\""));
    let routes = std::fs::read_to_string(root.join("crates/weft-server/src/lib.rs")).unwrap();
    assert!(routes.contains("/api/v1"));
    if let Ok(tags) = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .arg("tag")
        .output()
    {
        let tags = String::from_utf8_lossy(&tags.stdout).to_lowercase();
        assert!(
            !tags.contains("alpha") && !tags.contains("beta"),
            "release tag found: {tags}"
        );
    }
}

fn collect(dir: &Path, files: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), "target" | "node_modules" | "dist" | ".git") {
            continue;
        }
        if path.is_dir() {
            collect(&path, files);
        } else {
            files.push(path);
        }
    }
}
