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
    for _ in 0..100 {
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
    cleanup(server, schema, admin).await;
}
