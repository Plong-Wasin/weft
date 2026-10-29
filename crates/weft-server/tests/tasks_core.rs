use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct UserSession {
    user_id: Uuid,
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
        "tasks_{}_{}",
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
    let root = std::env::temp_dir().join(format!("weft-tasks-{schema}"));
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
        user_id: user,
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

#[tokio::test(flavor = "multi_thread")]
async fn task_numbers_conflicts_archive_restore_duplicate_and_acl_work_through_api() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let project = create_project(&origin, workspace, &member, "Roadmap", "workspace").await;
    let project_id = project["id"].as_str().unwrap();
    let client = reqwest::Client::new();
    let create = |title: &str| {
        request(&client, reqwest::Method::POST, format!("{origin}/api/v1/workspaces/{workspace}/tasks"), &member)
        .json(&serde_json::json!({"project_id":project_id,"title":title,"priority":"high","due_date":"2026-12-01","watchers":[owner.user_id],"description":"**Markdown**"}))
    };
    let first = create("Ship tasks").send().await.unwrap();
    assert_eq!(first.status(), reqwest::StatusCode::CREATED);
    let first: serde_json::Value = first.json().await.unwrap();
    assert_eq!(first["number"], 1);
    assert_eq!(first["status"], "backlog");
    assert_eq!(first["priority"], "high");
    assert_eq!(first["description"], "**Markdown**");
    assert_eq!(first["due_date"], "2026-12-01");
    assert_eq!(first["watchers"][0], owner.user_id.to_string());
    let second: serde_json::Value = create("Second").send().await.unwrap().json().await.unwrap();
    assert_eq!(second["number"], 2);
    let url = format!("{origin}/api/v1/workspaces/{workspace}/tasks/1");
    let stale = request(&client, reqwest::Method::PATCH, url.clone(), &member)
        .json(&serde_json::json!({"expected_version":0,"title":"Mine"}))
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), reqwest::StatusCode::CONFLICT);
    let conflict: serde_json::Value = stale.json().await.unwrap();
    assert_eq!(conflict["current"]["title"], "Ship tasks");
    let rename = request(&client, reqwest::Method::PATCH, url.clone(), &member)
        .json(&serde_json::json!({"expected_version":1,"title":"Renamed"}))
        .send()
        .await
        .unwrap();
    assert_eq!(rename.status(), reqwest::StatusCode::OK);
    let stable = request(&client, reqwest::Method::GET, url.clone(), &member)
        .send()
        .await
        .unwrap();
    assert_eq!(stable.status(), reqwest::StatusCode::OK);
    assert_eq!(
        stable.json::<serde_json::Value>().await.unwrap()["title"],
        "Renamed"
    );

    let archive = request(
        &client,
        reqwest::Method::POST,
        format!("{url}/archive"),
        &member,
    )
    .json(&serde_json::json!({"expected_version":2}))
    .send()
    .await
    .unwrap();
    assert_eq!(archive.status(), reqwest::StatusCode::OK);
    let archived_read = request(&client, reqwest::Method::GET, url.clone(), &member)
        .send()
        .await
        .unwrap();
    assert_eq!(archived_read.status(), reqwest::StatusCode::OK);
    assert!(!archived_read.json::<serde_json::Value>().await.unwrap()["archived_at"].is_null());
    let restore = request(
        &client,
        reqwest::Method::POST,
        format!("{url}/restore"),
        &member,
    )
    .json(&serde_json::json!({"expected_version":3}))
    .send()
    .await
    .unwrap();
    assert_eq!(restore.status(), reqwest::StatusCode::OK);
    let undo_restore = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(undo_restore.status(), reqwest::StatusCode::OK);
    let rearchived = request(&client, reqwest::Method::GET, url.clone(), &member)
        .send()
        .await
        .unwrap();
    assert_eq!(rearchived.status(), reqwest::StatusCode::OK);
    assert!(!rearchived.json::<serde_json::Value>().await.unwrap()["archived_at"].is_null());
    let redo_restore = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/redo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(redo_restore.status(), reqwest::StatusCode::OK);
    let duplicate = request(
        &client,
        reqwest::Method::POST,
        format!("{url}/duplicate"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(duplicate.status(), reqwest::StatusCode::CREATED);
    assert_eq!(
        duplicate.json::<serde_json::Value>().await.unwrap()["number"],
        3
    );

    let restricted = create_project(&origin, workspace, &member, "Secret", "restricted").await;
    let secret_id = restricted["id"].as_str().unwrap();
    let secret_task: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":secret_id,"title":"Private task"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let hidden = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert!(!hidden["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|task| task["number"] == secret_task["number"]));
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn project_move_preview_reports_access_subtasks_and_relations_before_move() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let from = create_project(&origin, workspace, &member, "From", "workspace").await;
    let to = create_project(&origin, workspace, &member, "To", "restricted").await;
    let from_id = from["id"].as_str().unwrap();
    let to_id = to["id"].as_str().unwrap();
    let client = reqwest::Client::new();
    let parent: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":from_id,"title":"Parent"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let child: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":from_id,"parent_task_id":parent["id"],"title":"Child"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let relation = request(
        &client,
        reqwest::Method::POST,
        format!(
            "{origin}/api/v1/tasks/{}/relations",
            parent["id"].as_str().unwrap()
        ),
        &member,
    )
    .json(&serde_json::json!({"target_task_id":child["id"],"kind":"related"}))
    .send()
    .await
    .unwrap();
    assert_eq!(relation.status(), reqwest::StatusCode::CREATED);
    let preview = request(
        &client,
        reqwest::Method::POST,
        format!(
            "{origin}/api/v1/tasks/{}/move-preview",
            parent["id"].as_str().unwrap()
        ),
        &member,
    )
    .json(&serde_json::json!({"project_id":to_id}))
    .send()
    .await
    .unwrap();
    assert_eq!(preview.status(), reqwest::StatusCode::OK);
    let effects: serde_json::Value = preview.json().await.unwrap();
    assert_eq!(effects["subtasks_affected"], 1);
    assert_eq!(effects["relations_affected"], 1);
    assert_eq!(effects["destination_visibility"], "restricted");
    let move_task = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{}", parent["id"].as_str().unwrap()),
        &member,
    )
    .json(&serde_json::json!({"expected_version":2,"project_id":to_id,"confirm_move":true}))
    .send()
    .await
    .unwrap();
    assert_eq!(move_task.status(), reqwest::StatusCode::OK);
    let moved_child: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/2"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(moved_child["project_id"], to_id);
    cleanup(server, schema, admin).await;
}
