use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    cookie: String,
    csrf: String,
}

async fn setup() -> (
    String,
    tokio::task::JoinHandle<()>,
    String,
    sqlx::PgPool,
    Uuid,
    Session,
    Session,
) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("lists_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'member@example.com','unused')",
    )
    .bind(member)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(member)
    .execute(&pool)
    .await
    .unwrap();
    let owner = session(&pool, owner).await;
    let member = session(&pool, member).await;
    (origin, server, schema, admin, workspace, owner, member)
}

async fn session(pool: &sqlx::PgPool, user: Uuid) -> Session {
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')").bind(Uuid::new_v4()).bind(user).bind(hash).bind(&csrf).execute(pool).await.unwrap();
    Session {
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    who: &Session,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf)
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
async fn shared_manual_list_filters_by_viewer_access_and_membership_is_undoable() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let project: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Restricted","visibility":"restricted"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let project_id = project["id"].as_str().unwrap();
    let task: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &owner,
    )
    .json(&serde_json::json!({"project_id":project_id,"title":"Secret"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let created = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/lists"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Shared"}))
    .send()
    .await
    .unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let list: serde_json::Value = created.json().await.unwrap();
    let list_id = list["id"].as_str().unwrap();
    let add = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/lists/{list_id}/tasks"),
        &owner,
    )
    .json(&serde_json::json!({"task_id":task["id"],"request_id":Uuid::new_v4()}))
    .send()
    .await
    .unwrap();
    assert!(add.status().is_success());
    let statuses: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/statuses"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let status = statuses["statuses"]
        .as_array()
        .unwrap()
        .iter()
        .find(|status| status["key"] == task["status"])
        .unwrap();
    let smart = request(&client, reqwest::Method::POST, format!("{origin}/api/v1/workspaces/{workspace}/lists"), &owner).json(&serde_json::json!({"name":"By stable Status","kind":"smart","query":{"filters":[{"field":"status","op":"eq","value":status["id"]}],"logic":"and","sort":[],"group":null,"columns":["title","status"]}})).send().await.unwrap();
    assert_eq!(smart.status(), reqwest::StatusCode::CREATED);
    let smart: serde_json::Value = smart.json().await.unwrap();
    let smart_id = smart["id"].as_str().unwrap();
    let member_smart: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/lists/{smart_id}"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(member_smart["tasks"].as_array().unwrap().is_empty());
    let renamed = request(
        &client,
        reqwest::Method::PATCH,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/statuses/{}",
            status["id"].as_str().unwrap()
        ),
        &owner,
    )
    .json(&serde_json::json!({"name":"Renamed status"}))
    .send()
    .await
    .unwrap();
    assert!(renamed.status().is_success());
    let owner_smart: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/lists/{smart_id}"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(owner_smart["tasks"].as_array().unwrap().len(), 1);
    let archive_preview: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/statuses/{}/archive-preview",
            status["id"].as_str().unwrap()
        ),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(archive_preview["affected_views"], 1);
    let member_list: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/lists/{list_id}"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(member_list["tasks"].as_array().unwrap().is_empty());
    let history: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/tasks/{}/history",
            task["id"].as_str().unwrap()
        ),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(history["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|operation| operation["field"] == format!("list_membership:{list_id}")));
    let undo = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &owner,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert!(
        undo.status().is_success(),
        "undo failed: {}",
        undo.text().await.unwrap()
    );
    let owner_list: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/lists/{list_id}"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(owner_list["tasks"].as_array().unwrap().is_empty());
    let redo = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/redo"),
        &owner,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert!(redo.status().is_success());
    let remove = request(
        &client,
        reqwest::Method::DELETE,
        format!(
            "{origin}/api/v1/lists/{list_id}/tasks/{}",
            task["id"].as_str().unwrap()
        ),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(remove.status(), reqwest::StatusCode::NO_CONTENT);
    let history: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/tasks/{}/history",
            task["id"].as_str().unwrap()
        ),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        history["operations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|operation| operation["field"] == format!("list_membership:{list_id}"))
            .count(),
        0
    );
    let undo_remove = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &owner,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert!(undo_remove.status().is_success());
    let owner_list: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/lists/{list_id}"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(owner_list["tasks"].as_array().unwrap().len(), 1);
    cleanup(server, schema, admin).await;
}
