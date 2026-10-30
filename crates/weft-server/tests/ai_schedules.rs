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
    let schema = format!("ai_sched_{}", Uuid::new_v4().simple());
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

type Json = serde_json::Value;

struct World {
    client: reqwest::Client,
    root: String,
    project: Uuid,
    secret: Uuid,
    service: Uuid,
    member: Member,
}

struct Member {
    id: Uuid,
    cookie: String,
    csrf: String,
}

fn send(w: &World, f: &Fixture, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    request(&w.client, method, format!("{}{path}", w.root), f)
}

async fn call(
    w: &World,
    f: &Fixture,
    method: reqwest::Method,
    path: &str,
    body: Option<Json>,
) -> (reqwest::StatusCode, Json) {
    let mut builder = send(w, f, method, path);
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    let response = builder.send().await.unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

async fn add_project(f: &Fixture, name: &str, visibility: &str, manager: bool) -> Uuid {
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
    if manager {
        grant(f, id, f.user, "manager").await;
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

async fn world(f: &Fixture) -> World {
    let client = reqwest::Client::new();
    let member_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'member@example.com','unused')",
    )
    .bind(member_id)
    .execute(&f.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    )
    .bind(f.workspace)
    .bind(member_id)
    .execute(&f.db)
    .await
    .unwrap();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(member_id).bind(format!("{:x}", Sha256::digest(token.as_bytes()))).bind(&csrf)
        .execute(&f.db).await.unwrap();
    let project = add_project(f, "Release", "restricted", true).await;
    let secret = add_project(f, "Secret roadmap", "restricted", true).await;
    let mut w = World {
        client,
        root: format!("{}/api/v1", f.origin),
        project,
        secret,
        service: Uuid::nil(),
        member: Member {
            id: member_id,
            cookie: format!("weft_session={token}; weft_csrf={csrf}"),
            csrf,
        },
    };
    let (status, body) = call(
        &w,
        f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/service-principals", f.workspace),
        Some(serde_json::json!({"name":"Weekly reviewer"})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    w.service = body["id"].as_str().unwrap().parse().unwrap();
    // The principal's explicit grant is the ceiling: it reads Release but not Secret roadmap.
    grant(f, project, w.service, "viewer").await;
    w
}

fn daily(time: &str) -> Json {
    serde_json::json!({"kind":"daily","time":time})
}

fn limits() -> Json {
    serde_json::json!({"runs_per_day":3,"characters":50000,"tool_calls":10})
}

async fn create(
    w: &World,
    f: &Fixture,
    frequency: Json,
    limits: Json,
) -> (reqwest::StatusCode, Json) {
    call(
        w,
        f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules", f.workspace),
        Some(serde_json::json!({
        "name":"Weekly review","principal_id":w.service,"connection_id":f.connection,
        "scope":{"projects":[w.project]},"frequency":frequency,"limits":limits})),
    )
    .await
}

/// Creates and enables a Schedule, then makes it due at `due` (an instant passed in by the test).
async fn active_schedule(w: &World, f: &Fixture, frequency: Json, limits: Json, due: &str) -> Uuid {
    let (status, body) = create(w, f, frequency, limits).await;
    assert_eq!(status, 201, "{body}");
    let id: Uuid = body["id"].as_str().unwrap().parse().unwrap();
    let (status, body) = call(
        w,
        f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/enable", f.workspace),
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    sqlx::query("UPDATE ai_schedules SET next_run_at=$2::timestamptz WHERE id=$1")
        .bind(id)
        .bind(due)
        .execute(&f.db)
        .await
        .unwrap();
    id
}

async fn schedule(w: &World, f: &Fixture, id: Uuid) -> Json {
    call(
        w,
        f,
        reqwest::Method::GET,
        &format!("/workspaces/{}/ai/schedules/{id}", f.workspace),
        None,
    )
    .await
    .1
}

async fn runs(f: &Fixture, id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM ai_runs WHERE schedule_id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

async fn finish_runs(f: &Fixture, id: Uuid) {
    sqlx::query("UPDATE ai_runs SET state='completed' WHERE schedule_id=$1")
        .bind(id)
        .execute(&f.db)
        .await
        .unwrap();
}

async fn same_instant(f: &Fixture, got: &str, expected: &str) -> bool {
    sqlx::query_scalar("SELECT $1::timestamptz=$2::timestamptz")
        .bind(got)
        .bind(expected)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_schedule_is_off_by_default_and_only_an_admin_can_manage_it() {
    let f = fixture().await;
    let w = world(&f).await;
    let path = format!("/workspaces/{}/ai/schedules", f.workspace);
    // A plain member cannot create, list or read; nothing about Schedules is visible to them.
    let attempt = w.client.post(format!("{}{path}", w.root))
        .header(reqwest::header::COOKIE, &w.member.cookie).header("x-csrf-token", &w.member.csrf)
        .json(&serde_json::json!({"name":"x","principal_id":w.service,"connection_id":f.connection,"scope":{"projects":[w.project]},"frequency":daily("09:00"),"limits":limits()}))
        .send().await.unwrap();
    assert_eq!(attempt.status(), 403);
    let (status, body) = create(&w, &f, daily("09:00"), limits()).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["state"], "off");
    assert!(body["next_run_at"].is_null());
    let id: Uuid = body["id"].as_str().unwrap().parse().unwrap();
    for target in [
        path.clone(),
        format!("{path}/{id}"),
        format!("{path}/{id}/runs"),
    ] {
        let listed = w
            .client
            .get(format!("{}{target}", w.root))
            .header(reqwest::header::COOKIE, &w.member.cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(listed.status(), 403, "{target}");
    }
    // An off Schedule never runs, however late it is.
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2099-01-01T00:00:00Z")
            .await
            .unwrap(),
        0
    );
    assert_eq!(runs(&f, id).await, 0);
    let (status, body) = call(
        &w,
        &f,
        reqwest::Method::POST,
        &format!("{path}/{id}/enable"),
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["state"], "active");
    assert!(body["next_run_at"].is_string());
    cleanup(f).await;
}

#[tokio::test]
async fn creation_refuses_what_exceeds_the_principals_grants_or_the_limits() {
    let f = fixture().await;
    let w = world(&f).await;
    let path = format!("/workspaces/{}/ai/schedules", f.workspace);
    let post = |scope: Json, connection: Uuid, principal: Uuid, frequency: Json, limits: Json| {
        let body = serde_json::json!({"name":"r","principal_id":principal,"connection_id":connection,"scope":scope,"frequency":frequency,"limits":limits});
        call(&w, &f, reqwest::Method::POST, &path, Some(body))
    };
    // The principal has no grant on the secret Project: the Schedule may not name it.
    let (status, body) = post(
        serde_json::json!({"projects":[w.project,w.secret]}),
        f.connection,
        w.service,
        daily("09:00"),
        limits(),
    )
    .await;
    assert_eq!(status, 422, "{body}");
    assert_eq!(body["reason"], "access_lost");
    // Nothing reads the whole Installation by default: an empty scope is refused.
    let (status, _) = post(
        serde_json::json!({}),
        f.connection,
        w.service,
        daily("09:00"),
        limits(),
    )
    .await;
    assert_eq!(status, 422);
    // A Connection the principal may not use (someone else's personal Connection).
    let personal = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_connections(id,scope,owner_id,provider,auth_mode,billing_mode,state,state_reason,created_by) VALUES($1,'personal',$2,'scripted','provider_cli','api','ready','ready',$2)")
        .bind(personal).bind(f.user).execute(&f.db).await.unwrap();
    let (status, body) = post(
        serde_json::json!({"projects":[w.project]}),
        personal,
        w.service,
        daily("09:00"),
        limits(),
    )
    .await;
    assert_eq!(status, 422, "{body}");
    assert_eq!(body["reason"], "connection_unavailable");
    // A principal outside the Workspace.
    let (status, body) = post(
        serde_json::json!({"projects":[w.project]}),
        f.connection,
        Uuid::new_v4(),
        daily("09:00"),
        limits(),
    )
    .await;
    assert_eq!(status, 422, "{body}");
    assert_eq!(body["reason"], "principal_revoked");
    for frequency in [
        serde_json::json!({"kind":"daily","time":"25:00"}),
        serde_json::json!({"kind":"weekly","weekday":9,"time":"09:00"}),
        serde_json::json!({"kind":"every-second"}),
    ] {
        let (status, _) = post(
            serde_json::json!({"projects":[w.project]}),
            f.connection,
            w.service,
            frequency,
            limits(),
        )
        .await;
        assert_eq!(status, 422);
    }
    for bad in [
        serde_json::json!({"runs_per_day":0,"characters":5000,"tool_calls":5}),
        serde_json::json!({"runs_per_day":2,"characters":5000}),
        serde_json::json!({"runs_per_day":2,"characters":5000,"tool_calls":9999}),
    ] {
        let (status, body) = post(
            serde_json::json!({"projects":[w.project]}),
            f.connection,
            w.service,
            daily("09:00"),
            bad,
        )
        .await;
        assert_eq!(status, 422);
        assert_eq!(body["error"], "invalid_limits");
    }
    cleanup(f).await;
}

#[tokio::test]
async fn a_due_run_is_a_normal_run_started_as_the_principal_within_its_limits() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    // Not due yet.
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2026-06-01T08:59:00Z")
            .await
            .unwrap(),
        0
    );
    assert_eq!(runs(&f, id).await, 0);
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
            .await
            .unwrap(),
        1
    );
    let run = sqlx::query("SELECT initiator_id,capability,scope,run_limits,state,connection_id FROM ai_runs WHERE schedule_id=$1")
        .bind(id).fetch_one(&f.db).await.unwrap();
    use sqlx::Row;
    // Started as the principal, never as the admin who set it up.
    assert_eq!(run.get::<Uuid, _>("initiator_id"), w.service);
    assert_ne!(run.get::<Uuid, _>("initiator_id"), f.user);
    assert_eq!(run.get::<String, _>("capability"), "progress_review");
    assert_eq!(run.get::<String, _>("state"), "queued");
    assert_eq!(run.get::<Uuid, _>("connection_id"), f.connection);
    let scope: Json = run.get("scope");
    assert_eq!(scope["projects"], serde_json::json!([w.project]));
    assert_eq!(scope["vaults"], serde_json::json!([]));
    let run_limits: Json = run.get("run_limits");
    assert_eq!(run_limits["tool_calls"], 10);
    assert_eq!(run_limits["context_characters"], 50000);
    // The same instant never starts a second run, and the next time moves to the next day.
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
            .await
            .unwrap(),
        0
    );
    let body = schedule(&w, &f, id).await;
    assert!(
        same_instant(
            &f,
            body["next_run_at"].as_str().unwrap(),
            "2026-06-02T09:00:00Z"
        )
        .await,
        "{body}"
    );
    cleanup(f).await;
}

async fn pair_and_lease(f: &Fixture) -> (reqwest::Client, String, String) {
    let client = reqwest::Client::new();
    let root = format!("{}/api/v1/ai", f.origin);
    let code: Json = request(
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
    let paired: Json = client.post(format!("{root}/agent/pair"))
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
    let lease: Json = client
        .post(format!("{root}/agent/jobs/lease"))
        .header("authorization", &bearer)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (
        client,
        bearer,
        lease["job"]["id"].as_str().unwrap().to_owned(),
    )
}

#[tokio::test]
async fn a_scheduled_run_only_puts_a_labelled_proposal_in_the_queue_that_others_may_not_see() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    let milestone = Uuid::new_v4();
    sqlx::query("INSERT INTO milestones(id,workspace_id,project_id,name,target_date,created_by) VALUES($1,$2,$3,'Public beta','2026-12-01',$4)")
        .bind(milestone).bind(f.workspace).bind(w.project).bind(f.user).execute(&f.db).await.unwrap();
    // Fixing a Milestone needs write access, which the principal holds only by explicit grant.
    sqlx::query("UPDATE project_memberships SET role='manager' WHERE project_id=$1 AND user_id=$2")
        .bind(w.project)
        .bind(w.service)
        .execute(&f.db)
        .await
        .unwrap();
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    let (client, bearer, job) = pair_and_lease(&f).await;
    let version: i64 = sqlx::query_scalar("SELECT version FROM milestones WHERE id=$1")
        .bind(milestone)
        .fetch_one(&f.db)
        .await
        .unwrap();
    let items = serde_json::json!([{"id":"tmp-mu","kind":"milestone_update","milestone_id":milestone,"expected_version":version,"target_date":"2027-01-31","reason":"Behind","sources":[]}]);
    let done = client.post(format!("{}/api/v1/ai/agent/jobs/{job}/result", f.origin)).header("authorization", &bearer)
        .json(&serde_json::json!({"result":{"summary":"done","outcome":"waiting_for_approval","proposal":{"schema_version":1,"items":items,"assumptions":[],"open_questions":[]}}}))
        .send().await.unwrap();
    assert!(done.status().is_success(), "{}", done.status());
    // The admin sees it in the approval queue, labelled with its origin.
    let queue_path = format!("/workspaces/{}/proposal-queue", f.workspace);
    let (status, queue) = call(&w, &f, reqwest::Method::GET, &queue_path, None).await;
    assert_eq!(status, 200);
    let entries = queue["proposals"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "{queue}");
    assert_eq!(entries[0]["origin"]["kind"], "schedule");
    assert_eq!(entries[0]["origin"]["schedule_id"], id.to_string());
    let proposal = entries[0]["id"].as_str().unwrap();
    let (_, detail) = call(
        &w,
        &f,
        reqwest::Method::GET,
        &format!("/workspaces/{}/proposals/{proposal}", f.workspace),
        None,
    )
    .await;
    assert_eq!(detail["origin"]["name"], "Weekly review");
    assert_eq!(detail["status"], "ready");
    // Nothing was applied: the run only proposed.
    let target: String = sqlx::query_scalar("SELECT target_date::text FROM milestones WHERE id=$1")
        .bind(milestone)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(target, "2026-12-01");
    let applied: i64 = sqlx::query_scalar("SELECT count(*) FROM proposals WHERE status='applied'")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(applied, 0);
    // A member without access to the Project sees neither the Proposal nor any count of the queue.
    let hidden = w
        .client
        .get(format!("{}{queue_path}", w.root))
        .header(reqwest::header::COOKIE, &w.member.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(hidden.status(), 200);
    let hidden: Json = hidden.json().await.unwrap();
    assert_eq!(hidden["proposals"], serde_json::json!([]));
    let direct = w
        .client
        .get(format!(
            "{}/workspaces/{}/proposals/{proposal}",
            w.root, f.workspace
        ))
        .header(reqwest::header::COOKIE, &w.member.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(direct.status(), 404);
    // The admin sees the run with its state, result and usage.
    let (_, listed) = call(
        &w,
        &f,
        reqwest::Method::GET,
        &format!("/workspaces/{}/ai/schedules/{id}/runs", f.workspace),
        None,
    )
    .await;
    let run = &listed["runs"][0];
    assert_eq!(run["state"], "started");
    assert_eq!(run["run_state"], "waiting_for_approval");
    assert_eq!(run["proposal_id"], proposal);
    assert!(run["result"].is_string());
    assert!(run["usage"]["tool_calls"].is_number());
    cleanup(f).await;
}

async fn stopped_with(w: &World, f: &Fixture, id: Uuid, reason: &str) {
    let body = schedule(w, f, id).await;
    assert_eq!(body["state"], "stopped", "{body}");
    assert_eq!(body["stop_reason"], reason, "{body}");
    assert!(body["stop_detail"]
        .as_str()
        .is_some_and(|text| !text.is_empty()));
    assert!(body["next_run_at"].is_null());
}

#[tokio::test]
async fn a_revoked_principal_stops_the_schedule_and_it_does_not_resume_by_itself() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    let (status, _) = call(
        &w,
        &f,
        reqwest::Method::POST,
        &format!(
            "/workspaces/{}/ai/service-principals/{}/revoke",
            f.workspace, w.service
        ),
        None,
    )
    .await;
    assert_eq!(status, 200);
    // Revoking stops the Schedule in the same transaction: no tick is needed and none runs it.
    stopped_with(&w, &f, id, "principal_revoked").await;
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
            .await
            .unwrap(),
        0
    );
    assert_eq!(runs(&f, id).await, 0);
    // Later ticks do nothing, and enabling again re-checks the principal first.
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2026-06-05T09:01:00Z")
            .await
            .unwrap(),
        0
    );
    let (status, body) = call(
        &w,
        &f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/enable", f.workspace),
        None,
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["reason"], "principal_revoked");
    cleanup(f).await;
}

#[tokio::test]
async fn a_revoked_or_disabled_connection_stops_the_schedule_with_a_reason() {
    let f = fixture().await;
    let w = world(&f).await;
    let first = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    sqlx::query("UPDATE ai_connections SET revoked_at=now() WHERE id=$1")
        .bind(f.connection)
        .execute(&f.db)
        .await
        .unwrap();
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    assert_eq!(runs(&f, first).await, 0);
    stopped_with(&w, &f, first, "connection_revoked").await;
    // Disabled (emergency switch on the Connection) is a different visible reason.
    sqlx::query("UPDATE ai_connections SET revoked_at=NULL WHERE id=$1")
        .bind(f.connection)
        .execute(&f.db)
        .await
        .unwrap();
    let second = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    sqlx::query("UPDATE ai_connections SET enabled=false,state='disabled' WHERE id=$1")
        .bind(f.connection)
        .execute(&f.db)
        .await
        .unwrap();
    weft_server::run_due_schedules(&f.db, "2026-06-02T09:01:00Z")
        .await
        .unwrap();
    assert_eq!(runs(&f, second).await, 0);
    stopped_with(&w, &f, second, "connection_unavailable").await;
    // The principal losing its grant to use the Connection stops it the same way.
    sqlx::query("UPDATE ai_connections SET enabled=true,state='ready' WHERE id=$1")
        .bind(f.connection)
        .execute(&f.db)
        .await
        .unwrap();
    let third = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-02T09:00:00Z").await;
    sqlx::query("DELETE FROM ai_connection_grants WHERE connection_id=$1")
        .bind(f.connection)
        .execute(&f.db)
        .await
        .unwrap();
    weft_server::run_due_schedules(&f.db, "2026-06-02T09:02:00Z")
        .await
        .unwrap();
    stopped_with(&w, &f, third, "connection_unavailable").await;
    cleanup(f).await;
}

#[tokio::test]
async fn a_principal_that_loses_access_to_the_scope_stops_the_schedule() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(w.project)
        .bind(w.service)
        .execute(&f.db)
        .await
        .unwrap();
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    assert_eq!(runs(&f, id).await, 0);
    stopped_with(&w, &f, id, "access_lost").await;
    cleanup(f).await;
}

#[tokio::test]
async fn hitting_a_limit_stops_the_schedule_until_an_admin_enables_it_again() {
    let f = fixture().await;
    let w = world(&f).await;
    let two = serde_json::json!({"runs_per_day":2,"characters":50000,"tool_calls":10});
    let id = active_schedule(
        &w,
        &f,
        serde_json::json!({"kind":"hourly","minute":0}),
        two,
        "2026-06-01T01:00:00Z",
    )
    .await;
    for hour in ["01", "02"] {
        assert_eq!(
            weft_server::run_due_schedules(&f.db, &format!("2026-06-01T{hour}:00:30Z"))
                .await
                .unwrap(),
            1
        );
        finish_runs(&f, id).await;
    }
    assert_eq!(runs(&f, id).await, 2);
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2026-06-01T03:00:30Z")
            .await
            .unwrap(),
        1
    );
    assert_eq!(runs(&f, id).await, 2, "the third run of the day is refused");
    stopped_with(&w, &f, id, "limit_reached").await;
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2026-06-02T03:00:30Z")
            .await
            .unwrap(),
        0
    );
    // A run that exceeded its own tool or character budget also stops the Schedule.
    let (status, body) = call(
        &w,
        &f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/enable", f.workspace),
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    sqlx::query("UPDATE ai_schedules SET next_run_at='2026-06-02T01:00:00Z' WHERE id=$1")
        .bind(id)
        .execute(&f.db)
        .await
        .unwrap();
    weft_server::run_due_schedules(&f.db, "2026-06-02T01:00:30Z")
        .await
        .unwrap();
    sqlx::query("UPDATE ai_runs SET state='failed',summary='Run exceeded its context or tool budget' WHERE schedule_id=$1 AND state='queued'").bind(id).execute(&f.db).await.unwrap();
    sqlx::query("UPDATE ai_schedules SET next_run_at='2026-06-02T02:00:00Z' WHERE id=$1")
        .bind(id)
        .execute(&f.db)
        .await
        .unwrap();
    weft_server::run_due_schedules(&f.db, "2026-06-02T02:00:30Z")
        .await
        .unwrap();
    stopped_with(&w, &f, id, "limit_reached").await;
    cleanup(f).await;
}

#[tokio::test]
async fn a_run_that_is_still_active_is_skipped_not_doubled() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(
        &w,
        &f,
        serde_json::json!({"kind":"hourly","minute":0}),
        limits(),
        "2026-06-01T01:00:00Z",
    )
    .await;
    weft_server::run_due_schedules(&f.db, "2026-06-01T01:00:30Z")
        .await
        .unwrap();
    weft_server::run_due_schedules(&f.db, "2026-06-01T02:00:30Z")
        .await
        .unwrap();
    assert_eq!(runs(&f, id).await, 1);
    let (_, listed) = call(
        &w,
        &f,
        reqwest::Method::GET,
        &format!("/workspaces/{}/ai/schedules/{id}/runs", f.workspace),
        None,
    )
    .await;
    assert_eq!(listed["runs"][0]["state"], "skipped");
    assert_eq!(schedule(&w, &f, id).await["state"], "active");
    cleanup(f).await;
}

#[tokio::test]
async fn the_emergency_switch_stops_queued_work_blocks_new_runs_and_is_audited() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    let (status, body) = call(
        &w,
        &f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/disable", f.workspace),
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "stopped");
    assert_eq!(body["stop_reason"], "disabled_by_admin");
    let state: String = sqlx::query_scalar("SELECT state FROM ai_runs WHERE schedule_id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(state, "canceled");
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2026-06-03T09:01:00Z")
            .await
            .unwrap(),
        0
    );
    assert_eq!(runs(&f, id).await, 1);
    let audited: i64 = sqlx::query_scalar("SELECT count(*) FROM security_audit_events WHERE event='ai.schedule.disabled' AND subject_id=$1").bind(id).fetch_one(&f.db).await.unwrap();
    assert_eq!(audited, 1);
    // Re-enabling is its own explicit action.
    let (status, body) = call(
        &w,
        &f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/enable", f.workspace),
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["state"], "active");
    cleanup(f).await;
}

#[tokio::test]
async fn service_principals_cannot_sign_in() {
    let f = fixture().await;
    let w = world(&f).await;
    let email: String = sqlx::query_scalar("SELECT email FROM users WHERE id=$1")
        .bind(w.service)
        .fetch_one(&f.db)
        .await
        .unwrap();
    let response = reqwest::Client::new()
        .post(format!("{}/api/v1/auth/login", f.origin))
        .json(&serde_json::json!({"email":email,"password":"!"}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_client_error(), "{}", response.status());
    cleanup(f).await;
}

#[tokio::test]
async fn run_times_follow_the_workspace_wall_clock_across_daylight_saving() {
    let f = fixture().await;
    let zone = "America/New_York";
    let next = |after: &'static str, frequency: Json| {
        let db = f.db.clone();
        async move {
            weft_server::next_schedule_run(&db, after, zone, &frequency)
                .await
                .unwrap()
                .unwrap()
        }
    };
    // 09:00 local is 14:00Z on the winter side and 13:00Z after the clocks go forward (2026-03-08).
    assert!(
        same_instant(
            &f,
            &next("2026-03-06T15:00:00Z", daily("09:00")).await,
            "2026-03-07T14:00:00Z"
        )
        .await
    );
    assert!(
        same_instant(
            &f,
            &next("2026-03-07T15:00:00Z", daily("09:00")).await,
            "2026-03-08T13:00:00Z"
        )
        .await
    );
    assert!(
        same_instant(
            &f,
            &next("2026-03-08T14:00:00Z", daily("09:00")).await,
            "2026-03-09T13:00:00Z"
        )
        .await
    );
    // Clocks go back on 2026-11-01.
    assert!(
        same_instant(
            &f,
            &next("2026-10-31T14:00:00Z", daily("09:00")).await,
            "2026-11-01T14:00:00Z"
        )
        .await
    );
    assert!(
        same_instant(
            &f,
            &next("2026-11-01T15:00:00Z", daily("09:00")).await,
            "2026-11-02T14:00:00Z"
        )
        .await
    );
    // The 02:30 that does not exist on the spring-forward day still runs once, after the gap.
    let gap = next("2026-03-07T12:00:00Z", daily("02:30")).await;
    assert!(
        same_instant(&f, &gap, "2026-03-08T07:30:00Z").await,
        "{gap}"
    );
    // Weekly: Monday 09:00 (weekday 1) after the change, then a week later.
    assert!(
        same_instant(
            &f,
            &next(
                "2026-03-05T00:00:00Z",
                serde_json::json!({"kind":"weekly","weekday":1,"time":"09:00"})
            )
            .await,
            "2026-03-09T13:00:00Z"
        )
        .await
    );
    assert!(
        same_instant(
            &f,
            &next(
                "2026-03-09T13:00:00Z",
                serde_json::json!({"kind":"weekly","weekday":1,"time":"09:00"})
            )
            .await,
            "2026-03-16T13:00:00Z"
        )
        .await
    );
    // Hourly at :30 in a half-hour zone follows the local clock.
    let kolkata = weft_server::next_schedule_run(
        &f.db,
        "2026-06-01T00:10:00Z",
        "Asia/Kolkata",
        &serde_json::json!({"kind":"hourly","minute":15}),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        same_instant(&f, &kolkata, "2026-06-01T00:45:00Z").await,
        "{kolkata}"
    );
    cleanup(f).await;
}

#[tokio::test]
async fn a_tick_across_the_clock_change_schedules_the_next_run_at_the_same_local_time() {
    let f = fixture().await;
    let w = world(&f).await;
    sqlx::query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1")
        .bind(f.workspace)
        .execute(&f.db)
        .await
        .unwrap();
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-03-07T14:00:00Z").await;
    weft_server::run_due_schedules(&f.db, "2026-03-07T14:00:10Z")
        .await
        .unwrap();
    let body = schedule(&w, &f, id).await;
    assert!(
        same_instant(
            &f,
            body["next_run_at"].as_str().unwrap(),
            "2026-03-08T13:00:00Z"
        )
        .await,
        "{body}"
    );
    finish_runs(&f, id).await;
    weft_server::run_due_schedules(&f.db, "2026-03-08T13:00:10Z")
        .await
        .unwrap();
    assert_eq!(runs(&f, id).await, 2);
    let body = schedule(&w, &f, id).await;
    assert!(
        same_instant(
            &f,
            body["next_run_at"].as_str().unwrap(),
            "2026-03-09T13:00:00Z"
        )
        .await,
        "{body}"
    );
    cleanup(f).await;
}

// ---- emergency disable -------------------------------------------------------------------

async fn run_state(f: &Fixture, schedule: Uuid) -> (String, String) {
    sqlx::query_as("SELECT state,summary FROM ai_runs WHERE schedule_id=$1")
        .bind(schedule)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

async fn disable_schedule(w: &World, f: &Fixture, id: Uuid) -> (reqwest::StatusCode, Json) {
    call(
        w,
        f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/disable", f.workspace),
        None,
    )
    .await
}

#[tokio::test]
async fn disabling_a_schedule_cancels_queued_work_and_blocks_new_runs_until_an_explicit_enable() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    assert_eq!(run_state(&f, id).await.0, "queued");
    // A plain member is refused and the queued run is untouched.
    let refused = w
        .client
        .post(format!(
            "{}/workspaces/{}/ai/schedules/{id}/disable",
            w.root, f.workspace
        ))
        .header(reqwest::header::COOKIE, &w.member.cookie)
        .header("x-csrf-token", &w.member.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 403);
    assert_eq!(run_state(&f, id).await.0, "queued");
    let (status, body) = disable_schedule(&w, &f, id).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "stopped");
    assert_eq!(body["stop_reason"], "disabled_by_admin");
    let (state, summary) = run_state(&f, id).await;
    assert_eq!(state, "canceled");
    assert!(summary.contains("disabled"), "{summary}");
    let job_status: String = sqlx::query_scalar(
        "SELECT status FROM ai_runner_jobs WHERE run_id=(SELECT id FROM ai_runs WHERE schedule_id=$1)",
    )
    .bind(id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(job_status, "paused");
    // Nothing starts again by itself, however late it is.
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2099-01-01T00:00:00Z")
            .await
            .unwrap(),
        0
    );
    assert_eq!(runs(&f, id).await, 1);
    // The audit trail says who did it and when; enabling is a separate, audited action.
    let audit_path = format!("/workspaces/{}/ai/schedules/{id}/audit", f.workspace);
    let (status, audit) = call(&w, &f, reqwest::Method::GET, &audit_path, None).await;
    assert_eq!(status, 200, "{audit}");
    let disabled = audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["event"] == "ai.schedule.disabled")
        .expect("disable is audited");
    assert_eq!(disabled["actor_id"], f.user.to_string());
    assert!(disabled["created_at"].is_string());
    let (status, _) = call(
        &w,
        &f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/enable", f.workspace),
        None,
    )
    .await;
    assert_eq!(status, 200);
    let (_, audit) = call(&w, &f, reqwest::Method::GET, &audit_path, None).await;
    let events: Vec<&str> = audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["event"].as_str().unwrap())
        .collect();
    assert!(events.contains(&"ai.schedule.enabled"), "{events:?}");
    // A member cannot read the audit trail.
    let hidden = w
        .client
        .get(format!("{}{audit_path}", w.root))
        .header(reqwest::header::COOKIE, &w.member.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(hidden.status(), 403);
    cleanup(f).await;
}

#[tokio::test]
async fn disabling_mid_flight_cancels_a_running_run_even_when_the_provider_never_answers() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    let (client, bearer, job) = pair_and_lease(&f).await;
    assert_eq!(run_state(&f, id).await.0, "running");
    // The provider is unreachable: it never reports a result. Disabling must not wait for it.
    let (status, _) = disable_schedule(&w, &f, id).await;
    assert_eq!(status, 200);
    let (state, summary) = run_state(&f, id).await;
    assert_eq!(state, "canceled");
    assert!(!summary.is_empty());
    // The runner sees the cancel request on its next status poll and stops.
    let polled: Json = client
        .get(format!("{}/api/v1/ai/agent/jobs/{job}/status", f.origin))
        .header("authorization", &bearer)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(polled["run_state"], "canceled", "{polled}");
    assert_eq!(polled["status"], "paused", "{polled}");
    // A late result from the provider cannot revive the run.
    let late = client
        .post(format!("{}/api/v1/ai/agent/jobs/{job}/result", f.origin))
        .header("authorization", &bearer)
        .json(&serde_json::json!({"result":{"summary":"late","outcome":"completed"}}))
        .send()
        .await
        .unwrap();
    assert!(!late.status().is_success(), "{}", late.status());
    assert_eq!(run_state(&f, id).await.0, "canceled");
    // The run history shows the cancel and its reason.
    let (_, listed) = call(
        &w,
        &f,
        reqwest::Method::GET,
        &format!("/workspaces/{}/ai/schedules/{id}/runs", f.workspace),
        None,
    )
    .await;
    assert_eq!(listed["runs"][0]["run_state"], "canceled");
    assert!(listed["runs"][0]["result"]
        .as_str()
        .unwrap()
        .contains("disabled"));
    cleanup(f).await;
}

#[tokio::test]
async fn a_disable_that_lands_after_a_run_was_claimed_still_starts_nothing() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    // Disabled between the due query and the claim: the claim fails and no run is created.
    let (status, _) = disable_schedule(&w, &f, id).await;
    assert_eq!(status, 200);
    sqlx::query("UPDATE ai_schedules SET next_run_at='2026-06-01T09:00:00Z' WHERE id=$1")
        .bind(id)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(
        weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
            .await
            .unwrap(),
        0
    );
    assert_eq!(runs(&f, id).await, 0);
    cleanup(f).await;
}

#[tokio::test]
async fn disabling_a_connection_cancels_its_runs_stops_schedules_and_is_limited_to_admin_or_owner()
{
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    let (client, bearer, job) = pair_and_lease(&f).await;
    let path = format!("/ai/connections/{}/disable", f.connection);
    // A member who does not own the Connection is refused; the running run continues.
    let refused = w
        .client
        .post(format!("{}{path}", w.root))
        .header(reqwest::header::COOKIE, &w.member.cookie)
        .header("x-csrf-token", &w.member.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 403);
    assert_eq!(run_state(&f, id).await.0, "running");
    let (status, body) = call(&w, &f, reqwest::Method::POST, &path, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "disabled");
    assert_eq!(body["enabled"], false);
    let (state, summary) = run_state(&f, id).await;
    assert_eq!(state, "canceled");
    assert!(summary.contains("disabled"), "{summary}");
    let polled: Json = client
        .get(format!("{}/api/v1/ai/agent/jobs/{job}/status", f.origin))
        .header("authorization", &bearer)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(polled["run_state"], "canceled", "{polled}");
    // The Schedule stopped in the same transaction, with a visible reason and no tick needed.
    assert_eq!(runs(&f, id).await, 1);
    stopped_with(&w, &f, id, "connection_unavailable").await;
    // The action is audited with the actor; re-enabling is separate and never automatic.
    let audited: (Option<Uuid>, i64) = sqlx::query_as(
        "SELECT actor_id,count(*) OVER () FROM security_audit_events WHERE event='ai.connection.disabled' AND subject_id=$1",
    )
    .bind(f.connection)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(audited.0, Some(f.user));
    // A personal Connection can be disabled by its owner, a plain member.
    let personal = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_connections(id,scope,owner_id,provider,auth_mode,billing_mode,state,state_reason,created_by) VALUES($1,'personal',$2,'scripted','provider_cli','api','ready','ready',$2)")
        .bind(personal).bind(w.member.id).execute(&f.db).await.unwrap();
    let own = w
        .client
        .post(format!("{}/ai/connections/{personal}/disable", w.root))
        .header(reqwest::header::COOKIE, &w.member.cookie)
        .header("x-csrf-token", &w.member.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(own.status(), 200);
    cleanup(f).await;
}

// ---- outsider review fixes (set A) -------------------------------------------------------

/// A second Workspace user with a session, and no Project grant at all.
async fn extra_user(f: &Fixture, email: &str, role: &str) -> Member {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(id)
        .bind(email)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)")
        .bind(f.workspace)
        .bind(id)
        .bind(role)
        .execute(&f.db)
        .await
        .unwrap();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(id).bind(format!("{:x}", Sha256::digest(token.as_bytes()))).bind(&csrf)
        .execute(&f.db).await.unwrap();
    Member {
        id,
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

async fn as_member(
    w: &World,
    who: &Member,
    method: reqwest::Method,
    path: &str,
    extra: Option<(&str, &str)>,
    body: Option<Json>,
) -> (reqwest::StatusCode, Json) {
    let mut builder = w
        .client
        .request(method, format!("{}{path}", w.root))
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf);
    if let Some((name, value)) = extra {
        builder = builder.header(name, value);
    }
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    let response = builder.send().await.unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

/// Runs a due Schedule over a Milestone the principal may fix and returns the Proposal it made.
async fn scheduled_proposal(w: &World, f: &Fixture) -> (Uuid, Uuid) {
    active_schedule(w, f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    let milestone = Uuid::new_v4();
    sqlx::query("INSERT INTO milestones(id,workspace_id,project_id,name,target_date,created_by) VALUES($1,$2,$3,'Public beta','2026-12-01',$4)")
        .bind(milestone).bind(f.workspace).bind(w.project).bind(f.user).execute(&f.db).await.unwrap();
    sqlx::query("UPDATE project_memberships SET role='manager' WHERE project_id=$1 AND user_id=$2")
        .bind(w.project)
        .bind(w.service)
        .execute(&f.db)
        .await
        .unwrap();
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    let (client, bearer, job) = pair_and_lease(f).await;
    let version: i64 = sqlx::query_scalar("SELECT version FROM milestones WHERE id=$1")
        .bind(milestone)
        .fetch_one(&f.db)
        .await
        .unwrap();
    let items = serde_json::json!([{"id":"tmp-mu","kind":"milestone_update","milestone_id":milestone,"expected_version":version,"target_date":"2027-01-31","reason":"Behind","sources":[]}]);
    let done = client.post(format!("{}/api/v1/ai/agent/jobs/{job}/result", f.origin)).header("authorization", &bearer)
        .json(&serde_json::json!({"result":{"summary":"done","outcome":"waiting_for_approval","proposal":{"schema_version":1,"items":items,"assumptions":[],"open_questions":[]}}}))
        .send().await.unwrap();
    assert!(done.status().is_success(), "{}", done.status());
    let proposal = sqlx::query_scalar("SELECT id FROM proposals")
        .fetch_one(&f.db)
        .await
        .unwrap();
    (proposal, milestone)
}

#[tokio::test]
async fn a_reader_of_the_scope_can_approve_a_scheduled_proposal_and_others_cannot() {
    let f = fixture().await;
    let w = world(&f).await;
    let (proposal, milestone) = scheduled_proposal(&w, &f).await;
    let base = format!("/workspaces/{}/proposals/{proposal}", f.workspace);
    // A member without access to the Project may neither edit, validate nor approve it.
    for (method, path, body, key) in [
        (
            reqwest::Method::PATCH,
            base.clone(),
            serde_json::json!({"expected_revision":1,"items":[]}),
            None,
        ),
        (
            reqwest::Method::POST,
            format!("{base}/validate"),
            serde_json::json!({}),
            None,
        ),
        (
            reqwest::Method::POST,
            format!("{base}/approve"),
            serde_json::json!({"revision":1}),
            Some(("idempotency-key", "outsider")),
        ),
    ] {
        let (status, _) = as_member(&w, &w.member, method, &path, key, Some(body)).await;
        assert!(
            status == 403 || status == 404,
            "{path} gave {status} to a member without scope access"
        );
    }
    let initiator: Uuid = sqlx::query_scalar("SELECT initiator_id FROM proposals WHERE id=$1")
        .bind(proposal)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(initiator, w.service);
    // A reader of the scope approves it and becomes its initiator.
    let owner = Member {
        id: f.user,
        cookie: f.cookie.clone(),
        csrf: f.csrf.clone(),
    };
    let (status, body) = as_member(
        &w,
        &owner,
        reqwest::Method::POST,
        &format!("{base}/approve"),
        Some(("idempotency-key", "approve-scheduled")),
        Some(serde_json::json!({"revision":1})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let target: String = sqlx::query_scalar("SELECT target_date::text FROM milestones WHERE id=$1")
        .bind(milestone)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(target, "2027-01-31");
    let initiator: Uuid = sqlx::query_scalar("SELECT initiator_id FROM proposals WHERE id=$1")
        .bind(proposal)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(initiator, f.user);
    cleanup(f).await;
}

#[tokio::test]
async fn a_schedule_cannot_run_as_another_member_or_over_a_scope_its_author_cannot_read() {
    let f = fixture().await;
    let w = world(&f).await;
    let path = format!("/workspaces/{}/ai/schedules", f.workspace);
    let body = |principal: Uuid| serde_json::json!({"name":"r","principal_id":principal,"connection_id":f.connection,"scope":{"projects":[w.project]},"frequency":daily("09:00"),"limits":limits()});
    // Another member with full access is still not an allowed execution principal.
    grant(&f, w.project, w.member.id, "viewer").await;
    let (status, reply) = call(
        &w,
        &f,
        reqwest::Method::POST,
        &path,
        Some(body(w.member.id)),
    )
    .await;
    assert_eq!(status, 422, "{reply}");
    assert_eq!(reply["reason"], "principal_not_allowed");
    // The acting admin may name themselves.
    let (status, reply) = call(&w, &f, reqwest::Method::POST, &path, Some(body(f.user))).await;
    assert_eq!(status, 201, "{reply}");
    // A second admin with no grant on the Restricted Project cannot create over it ...
    let admin2 = extra_user(&f, "admin2@example.com", "admin").await;
    let (status, reply) = as_member(
        &w,
        &admin2,
        reqwest::Method::POST,
        &path,
        None,
        Some(body(w.service)),
    )
    .await;
    assert_eq!(status, 422, "{reply}");
    assert_eq!(reply["reason"], "scope_not_readable");
    // ... nor enable an existing one, nor read its run summaries.
    let (status, created) = create(&w, &f, daily("09:00"), limits()).await;
    assert_eq!(status, 201, "{created}");
    let id: Uuid = created["id"].as_str().unwrap().parse().unwrap();
    let (status, reply) = as_member(
        &w,
        &admin2,
        reqwest::Method::POST,
        &format!("{path}/{id}/enable"),
        None,
        None,
    )
    .await;
    assert_eq!(status, 409, "{reply}");
    assert_eq!(reply["reason"], "scope_not_readable");
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    sqlx::query("UPDATE ai_runs SET summary='Task RELEASE-1 is overdue' WHERE schedule_id=$1")
        .bind(id)
        .execute(&f.db)
        .await
        .unwrap();
    let runs_path = format!("{path}/{id}/runs");
    let (status, hidden) =
        as_member(&w, &admin2, reqwest::Method::GET, &runs_path, None, None).await;
    assert_eq!(status, 200);
    assert_eq!(hidden["runs"][0]["state"], "started");
    assert!(hidden["runs"][0]["result"].is_null(), "{hidden}");
    let (_, shown) = call(&w, &f, reqwest::Method::GET, &runs_path, None).await;
    assert_eq!(shown["runs"][0]["result"], "Task RELEASE-1 is overdue");
    cleanup(f).await;
}

#[tokio::test]
async fn a_service_principal_needs_an_explicit_grant_not_workspace_visibility() {
    let f = fixture().await;
    let w = world(&f).await;
    let open = add_project(&f, "Open to all", "workspace", true).await;
    let path = format!("/workspaces/{}/ai/schedules", f.workspace);
    let body = serde_json::json!({"name":"r","principal_id":w.service,"connection_id":f.connection,"scope":{"projects":[open]},"frequency":daily("09:00"),"limits":limits()});
    let (status, reply) = call(&w, &f, reqwest::Method::POST, &path, Some(body.clone())).await;
    assert_eq!(status, 422, "{reply}");
    assert_eq!(reply["reason"], "access_lost");
    grant(&f, open, w.service, "viewer").await;
    let (status, reply) = call(&w, &f, reqwest::Method::POST, &path, Some(body)).await;
    assert_eq!(status, 201, "{reply}");
    cleanup(f).await;
}

#[tokio::test]
async fn a_result_that_lands_after_an_emergency_disable_does_not_requeue_the_run() {
    let f = fixture().await;
    let w = world(&f).await;
    let id = active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    weft_server::run_due_schedules(&f.db, "2026-06-01T09:01:00Z")
        .await
        .unwrap();
    let (_client, _bearer, _job) = pair_and_lease(&f).await;
    let run: Uuid = sqlx::query_scalar("SELECT id FROM ai_runs WHERE schedule_id=$1")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap();
    let (status, _) = call(
        &w,
        &f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/schedules/{id}/disable", f.workspace),
        None,
    )
    .await;
    assert_eq!(status, 200);
    // The provider's rate-limit result was already past its lease check when the disable landed.
    weft_server::accept_runner_result(
        &f.db,
        run,
        serde_json::json!({"outcome":"rate_limited","retry_after_seconds":5}),
        false,
    )
    .await;
    let state: String = sqlx::query_scalar("SELECT state FROM ai_runs WHERE id=$1")
        .bind(run)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(state, "canceled");
    let job: String = sqlx::query_scalar("SELECT status FROM ai_runner_jobs WHERE run_id=$1")
        .bind(run)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(job, "paused");
    cleanup(f).await;
}

#[tokio::test]
async fn revoking_a_principal_or_disabling_a_connection_stops_schedules_at_once() {
    let f = fixture().await;
    let w = world(&f).await;
    let by_principal =
        active_schedule(&w, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    call(
        &w,
        &f,
        reqwest::Method::POST,
        &format!(
            "/workspaces/{}/ai/service-principals/{}/revoke",
            f.workspace, w.service
        ),
        None,
    )
    .await;
    // No tick has run: the Schedule is already stopped with its reason.
    stopped_with(&w, &f, by_principal, "principal_revoked").await;

    let second = world_service(&w, &f, "Second reviewer").await;
    let w2 = World {
        service: second,
        ..clone_world(&w)
    };
    let by_disable =
        active_schedule(&w2, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    let connection_path = |action: &str| {
        format!(
            "{}/api/v1/ai/connections/{}/{action}",
            f.origin, f.connection
        )
    };
    let disabled = request(
        &w.client,
        reqwest::Method::POST,
        connection_path("disable"),
        &f,
    )
    .send()
    .await
    .unwrap();
    assert!(disabled.status().is_success(), "{}", disabled.status());
    stopped_with(&w2, &f, by_disable, "connection_unavailable").await;

    let enabled = request(
        &w.client,
        reqwest::Method::POST,
        connection_path("enable"),
        &f,
    )
    .send()
    .await
    .unwrap();
    assert!(enabled.status().is_success());
    let by_revoke =
        active_schedule(&w2, &f, daily("09:00"), limits(), "2026-06-01T09:00:00Z").await;
    let revoked = request(
        &w.client,
        reqwest::Method::POST,
        connection_path("revoke"),
        &f,
    )
    .send()
    .await
    .unwrap();
    assert!(revoked.status().is_success(), "{}", revoked.status());
    stopped_with(&w2, &f, by_revoke, "connection_revoked").await;
    cleanup(f).await;
}

fn clone_world(w: &World) -> World {
    World {
        client: w.client.clone(),
        root: w.root.clone(),
        project: w.project,
        secret: w.secret,
        service: w.service,
        member: Member {
            id: w.member.id,
            cookie: w.member.cookie.clone(),
            csrf: w.member.csrf.clone(),
        },
    }
}

/// A second service principal with a viewer grant on the Release Project.
async fn world_service(w: &World, f: &Fixture, name: &str) -> Uuid {
    let (status, body) = call(
        w,
        f,
        reqwest::Method::POST,
        &format!("/workspaces/{}/ai/service-principals", f.workspace),
        Some(serde_json::json!({"name":name})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let id: Uuid = body["id"].as_str().unwrap().parse().unwrap();
    grant(f, w.project, id, "viewer").await;
    id
}

#[tokio::test]
async fn the_proposal_queue_filters_before_it_limits() {
    let f = fixture().await;
    let w = world(&f).await;
    grant(&f, w.project, w.member.id, "viewer").await;
    let visible = Uuid::new_v4();
    sqlx::query("INSERT INTO proposals(id,workspace_id,initiator_id,scope,items,status,created_at) VALUES($1,$2,$3,$4,'[]','ready',now()-interval '1 day')")
        .bind(visible).bind(f.workspace).bind(f.user).bind(serde_json::json!({"project_ids":[w.project]}))
        .execute(&f.db).await.unwrap();
    // More newer Proposals than the page size, all over a Project the member cannot read.
    sqlx::query("INSERT INTO proposals(id,workspace_id,initiator_id,scope,items,status) SELECT gen_random_uuid(),$1,$2,$3,'[]','ready' FROM generate_series(1,120)")
        .bind(f.workspace).bind(f.user).bind(serde_json::json!({"project_ids":[w.secret]}))
        .execute(&f.db).await.unwrap();
    let (status, queue) = as_member(
        &w,
        &w.member,
        reqwest::Method::GET,
        &format!("/workspaces/{}/proposal-queue", f.workspace),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let ids: Vec<&str> = queue["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![visible.to_string()], "{queue}");
    cleanup(f).await;
}
