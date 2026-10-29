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
    let schema = format!("collab_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
        if let Err(error) = serve(listener, ServerConfig::new(server_db, root)).await {
            eprintln!("test server exited: {error}");
        }
    });
    let origin = format!("http://{address}");
    let client = reqwest::Client::new();
    let mut ready = false;
    for _ in 0..3000 {
        if client
            .get(format!("{origin}/health/ready"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            ready = true;
            break;
        }
        if server.is_finished() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(ready, "test server failed to become ready");
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
    (
        origin,
        server,
        schema,
        admin,
        workspace,
        session(&pool, owner).await,
        session(&pool, member).await,
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
async fn session(pool: &sqlx::PgPool, user: Uuid) -> Session {
    let id = Uuid::new_v4();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')").bind(id).bind(user).bind(hash).bind(&csrf).execute(pool).await.unwrap();
    Session {
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}
fn req(
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
async fn comments_are_idempotent_editable_and_search_respects_restricted_projects() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let project: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &member,
    )
    .json(&serde_json::json!({"name":"Private","visibility":"restricted"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let task: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":project["id"],"title":"ประเทศไทยเรื่อง"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let task_id = task["id"].as_str().unwrap();
    let attr:serde_json::Value=req(&client,reqwest::Method::POST,format!("{origin}/api/v1/workspaces/{workspace}/attributes"),&owner).json(&serde_json::json!({"name":"Thai marker","value_type":"text","project_ids":[project["id"]]})).send().await.unwrap().json().await.unwrap();
    let attr_write = req(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{task_id}/attributes"),
        &member,
    )
    .json(&serde_json::json!({"values":[{"attribute_id":attr["id"],"value":"ค่าเฉพาะ"}]}))
    .send()
    .await
    .unwrap();
    assert_eq!(attr_write.status(), reqwest::StatusCode::OK);
    let uploaded = req(&client, reqwest::Method::POST, format!("{origin}/api/v1/tasks/{task_id}/attachments"), &member)
        .json(&serde_json::json!({"file_name":"proof.bin","content_type":"application/octet-stream","content_hex":"0001ff"}))
        .send().await.unwrap();
    assert_eq!(uploaded.status(), reqwest::StatusCode::CREATED);
    let command = Uuid::new_v4();
    let comment_url = format!("{origin}/api/v1/tasks/{task_id}/comments");
    let first = req(&client, reqwest::Method::POST, comment_url.clone(), &member)
        .json(&serde_json::json!({"request_id":command,"body":"สวัสดีประเทศไทย"}))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), reqwest::StatusCode::CREATED);
    let comment: serde_json::Value = first.json().await.unwrap();
    let comment_id = comment["id"].as_str().unwrap();
    let retry = req(&client, reqwest::Method::POST, comment_url.clone(), &member)
        .json(&serde_json::json!({"request_id":command,"body":"สวัสดีประเทศไทย"}))
        .send()
        .await
        .unwrap();
    assert_eq!(retry.status(), reqwest::StatusCode::OK);
    assert_eq!(
        retry.json::<serde_json::Value>().await.unwrap()["id"],
        comment["id"]
    );
    let edited = req(
        &client,
        reqwest::Method::PATCH,
        format!("{comment_url}/{comment_id}"),
        &member,
    )
    .json(&serde_json::json!({"body":"แก้ไขแล้ว"}))
    .send()
    .await
    .unwrap();
    let edited_status = edited.status();
    let edited_body = edited.text().await.unwrap();
    assert_eq!(edited_status, reqwest::StatusCode::OK, "{edited_body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&edited_body).unwrap()["edited"],
        true
    );
    let search_url = format!("{origin}/api/v1/workspaces/{workspace}/search?q=ไทย&page=1&limit=10");
    let visible = req(&client, reqwest::Method::GET, search_url.clone(), &member)
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert!(visible["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["task_number"] == task["number"]));
    let exact = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/search?q={}",
            task["number"]
        ),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert_eq!(exact["count"], 1);
    let attribute = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/search?q=ค่าเฉพาะ"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert_eq!(attribute["count"], 1);
    let hidden = req(&client, reqwest::Method::GET, search_url, &owner)
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(hidden["count"], 0);
    assert!(hidden["results"].as_array().unwrap().is_empty());
    let too_complex = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/search?q={}",
            "ก".repeat(101)
        ),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(
        too_complex.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    // Export only holds Projects the exporting admin can read, so open the Project first.
    let opened = req(
        &client,
        reqwest::Method::PATCH,
        format!(
            "{origin}/api/v1/projects/{}",
            project["id"].as_str().unwrap()
        ),
        &member,
    )
    .json(&serde_json::json!({"visibility":"workspace"}))
    .send()
    .await
    .unwrap();
    assert_eq!(opened.status(), reqwest::StatusCode::OK);
    let denied = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/export"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    let exported: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/export"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(exported["schema_version"], "1.0");
    assert_eq!(exported["tasks"][0]["title"], "ประเทศไทยเรื่อง");
    assert_eq!(exported["comments"][0]["body"], "แก้ไขแล้ว");
    assert_eq!(exported["attachments"][0]["content_hex"], "0001ff");
    let denied_delete = req(
        &client,
        reqwest::Method::DELETE,
        format!("{comment_url}/{comment_id}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(denied_delete.status(), reqwest::StatusCode::NOT_FOUND);
    let deleted = req(
        &client,
        reqwest::Method::DELETE,
        format!("{comment_url}/{comment_id}"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(deleted.status(), reqwest::StatusCode::NO_CONTENT);
    let after_delete = req(&client, reqwest::Method::GET, comment_url, &member)
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert!(after_delete["comments"].as_array().unwrap().is_empty());
    cleanup(server, schema, admin).await;
}
