use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct UserSession {
    cookie: String,
    csrf: String,
}

async fn setup() -> (
    String,
    tokio::task::JoinHandle<()>,
    String,
    sqlx::PgPool,
    Uuid,
    UserSession,
    UserSession,
) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!(
        "review_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let scoped = format!("{base}?options=-csearch_path%3D{schema}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    let root = std::env::temp_dir().join(format!("weft-review-{schema}"));
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
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let pool = sqlx::PgPool::connect(&scoped).await.unwrap();
    weft_server::bootstrap_admin(
        &pool,
        "owner@example.com",
        "secret password",
        "Test Workspace",
    )
    .await
    .unwrap();
    let (workspace, owner): (Uuid, Uuid) = sqlx::query_as("SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'").fetch_one(&pool).await.unwrap();
    let member = add_user(&pool, workspace, "member@example.com", "member").await;
    let owner_session = session(&pool, owner).await;
    let member_session = session(&pool, member).await;
    (
        origin,
        server,
        schema,
        admin,
        workspace,
        owner_session,
        member_session,
    )
}

async fn add_user(pool: &sqlx::PgPool, workspace: Uuid, email: &str, role: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(id)
        .bind(email)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn session(pool: &sqlx::PgPool, user: Uuid) -> UserSession {
    let id = Uuid::new_v4();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')").bind(id).bind(user).bind(hash).bind(&csrf).execute(pool).await.unwrap();
    UserSession {
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    who: &UserSession,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf)
}

async fn create_project(
    origin: &str,
    workspace: Uuid,
    who: &UserSession,
    name: &str,
    visibility: &str,
) -> serde_json::Value {
    request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        who,
    )
    .json(&serde_json::json!({"name":name,"visibility":visibility}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap()
}

async fn cleanup(server: tokio::task::JoinHandle<()>, schema: String, admin: sqlx::PgPool) {
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

fn api(origin: &str, path: &str) -> String {
    format!("{origin}/api/v1{path}")
}

async fn new_task(
    origin: &str,
    workspace: Uuid,
    who: &UserSession,
    body: serde_json::Value,
) -> reqwest::Response {
    request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        api(origin, &format!("/workspaces/{workspace}/tasks")),
        who,
    )
    .json(&body)
    .send()
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_version_requests_do_not_leak_tasks_the_caller_cannot_read() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let secret = create_project(&origin, workspace, &member, "Secret", "restricted").await;
    let created: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":secret["id"],"title":"Hidden plan"}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = created["id"].as_str().unwrap();
    let number = created["number"].as_i64().unwrap();
    // The owner is a Workspace owner, not a project member: Restricted content stays hidden.
    for (method, path, body) in [
        (
            reqwest::Method::PATCH,
            format!("/tasks/{id}"),
            serde_json::json!({"expected_version":99,"title":"x"}),
        ),
        (
            reqwest::Method::PATCH,
            format!("/workspaces/{workspace}/tasks/{number}"),
            serde_json::json!({"expected_version":99,"title":"x"}),
        ),
        (
            reqwest::Method::POST,
            format!("/workspaces/{workspace}/tasks/{number}/archive"),
            serde_json::json!({"expected_version":99}),
        ),
        (
            reqwest::Method::POST,
            format!("/workspaces/{workspace}/tasks/bulk"),
            serde_json::json!({"items":[{"task_id":id,"expected_version":99,"title":"x"}]}),
        ),
    ] {
        let response = request(&client, method, api(&origin, &path), &owner)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        assert_eq!(status, reqwest::StatusCode::NOT_FOUND, "{path}: {text}");
        assert!(!text.contains("Hidden plan"), "{path} leaked: {text}");
    }
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn moving_a_task_moves_its_subtree_and_undo_restores_every_task() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let client = reqwest::Client::new();
    let from = create_project(&origin, workspace, &member, "From", "workspace").await;
    let to = create_project(&origin, workspace, &member, "To", "workspace").await;
    let parent: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":from["id"],"title":"Parent"}),
    )
    .await
    .json()
    .await
    .unwrap();
    let child: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":from["id"],"title":"Child","parent_task_id":parent["id"]}),
    )
    .await
    .json()
    .await
    .unwrap();
    let get = |number: i64| {
        let url = api(&origin, &format!("/workspaces/{workspace}/tasks/{number}"));
        let client = client.clone();
        let member = &member;
        async move {
            request(&client, reqwest::Method::GET, url, member)
                .send()
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap()
        }
    };
    // A subtask cannot be moved away from its parent.
    let rejected = request(
        &client,
        reqwest::Method::PATCH,
        api(
            &origin,
            &format!("/tasks/{}", child["id"].as_str().unwrap()),
        ),
        &member,
    )
    .json(&serde_json::json!({"expected_version":1,"project_id":to["id"],"confirm_move":true}))
    .send()
    .await
    .unwrap();
    assert_eq!(rejected.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let moved = request(
        &client,
        reqwest::Method::PATCH,
        api(
            &origin,
            &format!("/tasks/{}", parent["id"].as_str().unwrap()),
        ),
        &member,
    )
    .json(&serde_json::json!({"expected_version":1,"project_id":to["id"],"confirm_move":true}))
    .send()
    .await
    .unwrap();
    assert_eq!(moved.status(), reqwest::StatusCode::OK);
    assert_eq!(get(2).await["project_id"], to["id"]);
    let undo = request(
        &client,
        reqwest::Method::POST,
        api(&origin, &format!("/workspaces/{workspace}/history/undo")),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    assert_eq!(get(1).await["project_id"], from["id"]);
    assert_eq!(get(2).await["project_id"], from["id"]);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_an_invite_is_listed_in_the_workspace_audit_events() {
    let (origin, server, schema, admin, _workspace, owner, _member) = setup().await;
    let client = reqwest::Client::new();
    let invite: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        api(&origin, "/auth/invites"),
        &owner,
    )
    .json(&serde_json::json!({"role":"member"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let revoked = request(
        &client,
        reqwest::Method::DELETE,
        api(
            &origin,
            &format!("/auth/invites/{}", invite["id"].as_str().unwrap()),
        ),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(revoked.status(), reqwest::StatusCode::NO_CONTENT);
    let events: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        api(&origin, "/auth/audit-events"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let names: Vec<&str> = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"invite.revoke"), "{names:?}");
    let revoke = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["event"] == "invite.revoke")
        .unwrap();
    assert!(revoke["actor_id"].is_string(), "{revoke}");
    cleanup(server, schema, admin).await;
}

async fn patch_task(
    origin: &str,
    who: &UserSession,
    id: &str,
    body: serde_json::Value,
) -> reqwest::Response {
    request(
        &reqwest::Client::new(),
        reqwest::Method::PATCH,
        api(origin, &format!("/tasks/{id}")),
        who,
    )
    .json(&body)
    .send()
    .await
    .unwrap()
}

async fn history(
    origin: &str,
    workspace: Uuid,
    who: &UserSession,
    action: &str,
) -> reqwest::Response {
    request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        api(origin, &format!("/workspaces/{workspace}/history/{action}")),
        who,
    )
    .send()
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn two_undos_can_be_redone_in_original_order() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let project = create_project(&origin, workspace, &member, "P", "workspace").await;
    let task: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":project["id"],"title":"x"}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = task["id"].as_str().unwrap();
    assert!(patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"title":"y"})
    )
    .await
    .status()
    .is_success());
    assert!(patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":2,"title":"z"})
    )
    .await
    .status()
    .is_success());
    for expected in ["y", "x"] {
        let undo: serde_json::Value = history(&origin, workspace, &member, "undo")
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(undo["task"]["title"], expected, "{undo}");
    }
    for expected in ["y", "z"] {
        let redo: serde_json::Value = history(&origin, workspace, &member, "redo")
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(redo["task"]["title"], expected, "{redo}");
    }
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn undoing_a_move_needs_write_access_to_the_destination_project() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let from = create_project(&origin, workspace, &member, "From", "workspace").await;
    let to = create_project(&origin, workspace, &member, "To", "workspace").await;
    let task: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":from["id"],"title":"T"}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = task["id"].as_str().unwrap();
    let moved = patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"project_id":to["id"],"confirm_move":true}),
    )
    .await;
    assert_eq!(moved.status(), reqwest::StatusCode::OK);
    sqlx::query(&format!(
        "DELETE FROM {schema}.project_memberships WHERE project_id=$1::uuid"
    ))
    .bind(from["id"].as_str().unwrap())
    .execute(&admin)
    .await
    .unwrap();
    let undo = history(&origin, workspace, &member, "undo").await;
    assert_eq!(undo.status(), reqwest::StatusCode::CONFLICT);
    let project: String = sqlx::query_scalar(&format!(
        "SELECT project_id::text FROM {schema}.tasks WHERE id=$1::uuid"
    ))
    .bind(id)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(project, to["id"].as_str().unwrap());
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn dates_can_be_cleared_and_unchanged_watchers_are_a_no_op() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let project = create_project(&origin, workspace, &member, "P", "workspace").await;
    let owner_id: Uuid = sqlx::query_scalar(&format!(
        "SELECT user_id FROM {schema}.workspace_memberships WHERE role='owner'"
    ))
    .fetch_one(&admin)
    .await
    .unwrap();
    let task: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":project["id"],"title":"T","due_date":"2026-12-01","watchers":[owner_id]}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = task["id"].as_str().unwrap();
    let noop: serde_json::Value = patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"watchers":[owner_id]}),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(noop["version"], 1, "{noop}");
    let cleared: serde_json::Value = patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"due_date":null}),
    )
    .await
    .json()
    .await
    .unwrap();
    assert!(cleared["due_date"].is_null(), "{cleared}");
    assert_eq!(cleared["version"], 2, "{cleared}");
    let _ = owner;
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn parallel_sign_ins_do_not_exhaust_the_connection_pool() {
    let (origin, server, schema, admin, _workspace, _owner, _member) = setup().await;
    let client = reqwest::Client::new();
    let attempts: Vec<_> = (0..16)
        .map(|_| {
            let client = client.clone();
            let url = api(&origin, "/auth/sign-in");
            tokio::spawn(async move {
                client
                    .post(url)
                    .json(&serde_json::json!({"email":"owner@example.com","password":"wrong"}))
                    .send()
                    .await
                    .unwrap()
                    .status()
            })
        })
        .collect();
    let mut unauthorized = 0;
    for attempt in attempts {
        if attempt.await.unwrap() == reqwest::StatusCode::UNAUTHORIZED {
            unauthorized += 1;
        }
    }
    assert_eq!(unauthorized, 10);
    let ready = tokio::time::timeout(
        Duration::from_secs(3),
        client.get(format!("{origin}/health/ready")).send(),
    )
    .await;
    assert!(ready.is_ok());
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn invites_of_a_removed_admin_stop_working() {
    let (origin, server, schema, admin, workspace, owner, _member) = setup().await;
    let client = reqwest::Client::new();
    let pool = sqlx::PgPool::connect(&format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    ))
    .await
    .unwrap();
    let helper = add_user(&pool, workspace, "helper@example.com", "admin").await;
    let helper_session = session(&pool, helper).await;
    let invite: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        api(&origin, "/auth/invites"),
        &helper_session,
    )
    .json(&serde_json::json!({"role":"admin"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let removed = request(
        &client,
        reqwest::Method::DELETE,
        api(
            &origin,
            &format!("/workspaces/{workspace}/members/{helper}"),
        ),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(removed.status(), reqwest::StatusCode::NO_CONTENT);
    let accepted = client
        .post(api(&origin, "/auth/invites/accept"))
        .json(&serde_json::json!({"token":invite["token"],"email":"late@example.com","password":"a long password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), reqwest::StatusCode::GONE);
    pool.close().await;
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn task_deep_links_serve_the_shell_but_unknown_api_paths_stay_404() {
    let (origin, server, schema, admin, workspace, _owner, _member) = setup().await;
    let client = reqwest::Client::new();
    let deep = client
        .get(format!("{origin}/w/{workspace}/tasks/1"))
        .send()
        .await
        .unwrap();
    assert_eq!(deep.status(), reqwest::StatusCode::OK);
    assert_eq!(deep.text().await.unwrap(), "Weft");
    for path in ["/api/v1/nope", "/health/nope"] {
        let response = client.get(format!("{origin}{path}")).send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND, "{path}");
    }
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn dates_are_canonical_in_history_and_invalid_dates_are_rejected() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let project = create_project(&origin, workspace, &member, "P", "workspace").await;
    let task: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":project["id"],"title":"T"}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = task["id"].as_str().unwrap();
    let invalid = patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"due_date":"2026-02-30"}),
    )
    .await;
    assert_eq!(invalid.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let set = patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"due_date":"2026-1-1"}),
    )
    .await;
    assert_eq!(set.status(), reqwest::StatusCode::OK);
    let undo = history(&origin, workspace, &member, "undo").await;
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn watcher_changes_are_recorded_and_undoable() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let project = create_project(&origin, workspace, &member, "P", "workspace").await;
    let owner_id: Uuid = sqlx::query_scalar(&format!(
        "SELECT user_id FROM {schema}.workspace_memberships WHERE role='owner'"
    ))
    .fetch_one(&admin)
    .await
    .unwrap();
    let task: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":project["id"],"title":"T"}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = task["id"].as_str().unwrap();
    let patched = patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"watchers":[owner_id]}),
    )
    .await;
    assert_eq!(patched.status(), reqwest::StatusCode::OK);
    let history: serde_json::Value = request(
        &reqwest::Client::new(),
        reqwest::Method::GET,
        api(&origin, &format!("/tasks/{id}/history")),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(
        history["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op["field"] == "watchers"),
        "{history}"
    );
    let undo: serde_json::Value = history_action(&origin, workspace, &member, "undo")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(undo["task"]["watchers"], serde_json::json!([]), "{undo}");
    let redo: serde_json::Value = history_action(&origin, workspace, &member, "redo")
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        redo["task"]["watchers"],
        serde_json::json!([owner_id]),
        "{redo}"
    );
    cleanup(server, schema, admin).await;
}

async fn history_action(
    origin: &str,
    workspace: Uuid,
    who: &UserSession,
    action: &str,
) -> reqwest::Response {
    history(origin, workspace, who, action).await
}

#[tokio::test(flavor = "multi_thread")]
async fn archived_tasks_stay_readable_and_listable_on_request() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let client = reqwest::Client::new();
    let project = create_project(&origin, workspace, &member, "P", "workspace").await;
    new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":project["id"],"title":"T"}),
    )
    .await;
    let archived = request(
        &client,
        reqwest::Method::POST,
        api(&origin, &format!("/workspaces/{workspace}/tasks/1/archive")),
        &member,
    )
    .json(&serde_json::json!({"expected_version":1}))
    .send()
    .await
    .unwrap();
    assert_eq!(archived.status(), reqwest::StatusCode::OK);
    let read: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        api(&origin, &format!("/workspaces/{workspace}/tasks/1")),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(!read["archived_at"].is_null(), "{read}");
    let list = |query: &'static str| {
        let url = api(&origin, &format!("/workspaces/{workspace}/tasks{query}"));
        let client = client.clone();
        let member = &member;
        async move {
            request(&client, reqwest::Method::GET, url, member)
                .send()
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len()
        }
    };
    assert_eq!(list("").await, 0);
    assert_eq!(list("?archived=true").await, 1);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn undo_preview_reports_availability_without_applying() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let project = create_project(&origin, workspace, &member, "P", "workspace").await;
    let task: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":project["id"],"title":"x"}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = task["id"].as_str().unwrap();
    patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"title":"y"}),
    )
    .await;
    let preview_url = api(&origin, &format!("/workspaces/{workspace}/history/undo"));
    let preview = request(&client, reqwest::Method::GET, preview_url.clone(), &member)
        .send()
        .await
        .unwrap();
    assert_eq!(preview.status(), reqwest::StatusCode::OK);
    let title: String = sqlx::query_scalar(&format!(
        "SELECT title FROM {schema}.tasks WHERE id=$1::uuid"
    ))
    .bind(id)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(title, "y");
    let nothing = request(&client, reqwest::Method::GET, preview_url, &owner)
        .send()
        .await
        .unwrap();
    assert_eq!(nothing.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        nothing.json::<serde_json::Value>().await.unwrap()["error"],
        "undo_unavailable"
    );
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn undoing_a_watcher_change_conflicts_when_the_watcher_lost_access() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let pool = sqlx::PgPool::connect(&format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    ))
    .await
    .unwrap();
    let watcher = add_user(&pool, workspace, "watcher@example.com", "member").await;
    let project = create_project(&origin, workspace, &member, "P", "workspace").await;
    let task: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":project["id"],"title":"T","watchers":[watcher]}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = task["id"].as_str().unwrap();
    let cleared = patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"watchers":[]}),
    )
    .await;
    assert_eq!(cleared.status(), reqwest::StatusCode::OK);
    sqlx::query("DELETE FROM workspace_memberships WHERE user_id=$1")
        .bind(watcher)
        .execute(&pool)
        .await
        .unwrap();
    let preview = request(
        &reqwest::Client::new(),
        reqwest::Method::GET,
        api(&origin, &format!("/workspaces/{workspace}/history/undo")),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(preview.status(), reqwest::StatusCode::CONFLICT);
    let undo = history(&origin, workspace, &member, "undo").await;
    assert_eq!(undo.status(), reqwest::StatusCode::CONFLICT);
    pool.close().await;
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn undo_does_not_edit_a_task_someone_else_archived() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let pool = sqlx::PgPool::connect(&format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    ))
    .await
    .unwrap();
    let other = add_user(&pool, workspace, "other@example.com", "member").await;
    let other_session = session(&pool, other).await;
    let project = create_project(&origin, workspace, &member, "P", "workspace").await;
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2::uuid,$3,'contributor')")
        .bind(workspace)
        .bind(project["id"].as_str().unwrap())
        .bind(other)
        .execute(&pool)
        .await
        .unwrap();
    let task: serde_json::Value = new_task(
        &origin,
        workspace,
        &member,
        serde_json::json!({"project_id":project["id"],"title":"orig"}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = task["id"].as_str().unwrap();
    assert!(patch_task(
        &origin,
        &member,
        id,
        serde_json::json!({"expected_version":1,"title":"edited"})
    )
    .await
    .status()
    .is_success());
    let archived = request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        api(&origin, &format!("/workspaces/{workspace}/tasks/1/archive")),
        &other_session,
    )
    .json(&serde_json::json!({"expected_version":2}))
    .send()
    .await
    .unwrap();
    assert_eq!(archived.status(), reqwest::StatusCode::OK);
    let undo = history(&origin, workspace, &member, "undo").await;
    assert_eq!(undo.status(), reqwest::StatusCode::CONFLICT);
    let title: String = sqlx::query_scalar("SELECT title FROM tasks WHERE id=$1::uuid")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(title, "edited");
    pool.close().await;
    cleanup(server, schema, admin).await;
}
