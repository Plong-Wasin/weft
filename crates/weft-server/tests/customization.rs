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
    sqlx::PgPool,
    Uuid,
    Session,
) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("custom_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
    let (workspace,owner):(Uuid,Uuid)=sqlx::query_as("SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'").fetch_one(&pool).await.unwrap();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')").bind(Uuid::new_v4()).bind(owner).bind(hash).bind(&csrf).execute(&pool).await.unwrap();
    (
        origin,
        server,
        schema,
        admin,
        pool,
        workspace,
        Session {
            cookie: format!("weft_session={token}; weft_csrf={csrf}"),
            csrf,
        },
    )
}
fn request(
    c: &reqwest::Client,
    m: reqwest::Method,
    u: String,
    s: &Session,
) -> reqwest::RequestBuilder {
    c.request(m, u)
        .header(reqwest::header::COOKIE, &s.cookie)
        .header("x-csrf-token", &s.csrf)
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
async fn statuses_attributes_filtering_history_and_completed_time_work_through_api() {
    let (origin, server, schema, admin, _pool, workspace, owner) = setup().await;
    let client = reqwest::Client::new();
    let statuses = format!("{origin}/api/v1/workspaces/{workspace}/statuses");
    let initial: serde_json::Value =
        request(&client, reqwest::Method::GET, statuses.clone(), &owner)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
    assert!(initial["statuses"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["key"] == "backlog" && s["category"] == "not_started"));
    let custom: serde_json::Value =
        request(&client, reqwest::Method::POST, statuses.clone(), &owner)
            .json(&serde_json::json!({"name":"Ready","category":"active"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
    let task_list: serde_json::Value =
        request(&client, reqwest::Method::GET, statuses.clone(), &owner)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
    let replacement = task_list["statuses"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == "backlog")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let project: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Roadmap","visibility":"workspace"}))
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
    .json(&serde_json::json!({"project_id":project_id,"title":"Review","status":custom["key"]}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let task_id = task["id"].as_str().unwrap();
    let custom_id = custom["id"].as_str().unwrap();
    let url = format!(
        "{origin}/api/v1/workspaces/{workspace}/tasks/{}",
        task["number"]
    );
    let rejected = request(
        &client,
        reqwest::Method::POST,
        format!("{statuses}/{custom_id}/archive"),
        &owner,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(rejected.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let preview: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{statuses}/{custom_id}/archive-preview"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(preview["affected_tasks"], 1);
    let _: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{statuses}/{custom_id}/archive"),
        &owner,
    )
    .json(&serde_json::json!({"replacement_id":replacement}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let completed: serde_json::Value =
        request(&client, reqwest::Method::PATCH, url.clone(), &owner)
            .json(&serde_json::json!({"expected_version":2,"status":"completed"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
    assert!(!completed["completed_at"].is_null());
    let reopened: serde_json::Value = request(&client, reqwest::Method::PATCH, url.clone(), &owner)
        .json(&serde_json::json!({"expected_version":3,"status":"backlog"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(reopened["completed_at"].is_null());
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
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    let undone: serde_json::Value = request(&client, reqwest::Method::GET, url, &owner)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(undone["status"], "completed");
    assert!(!undone["completed_at"].is_null());
    let attrs = format!("{origin}/api/v1/workspaces/{workspace}/attributes");
    let attr:serde_json::Value=request(&client,reqwest::Method::POST,attrs,&owner).json(&serde_json::json!({"name":"Estimate","value_type":"number","project_ids":[project_id]})).send().await.unwrap().json().await.unwrap();
    let attr_id = attr["id"].as_str().unwrap();
    let write = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{task_id}/attributes"),
        &owner,
    )
    .json(&serde_json::json!({"values":[{"attribute_id":attr_id,"value":5}]}))
    .send()
    .await
    .unwrap();
    assert_eq!(write.status(), reqwest::StatusCode::OK);
    let list:serde_json::Value=request(&client,reqwest::Method::GET,format!("{origin}/api/v1/workspaces/{workspace}/tasks?attribute_id={attr_id}&attribute_value=5&sort=title&group_by=status&columns=title,status"),&owner).send().await.unwrap().json().await.unwrap();
    assert_eq!(list["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(list["columns"], serde_json::json!(["title", "status"]));
    let clear = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{task_id}/attributes"),
        &owner,
    )
    .json(&serde_json::json!({"values":[{"attribute_id":attr_id,"value":null}]}))
    .send()
    .await
    .unwrap();
    assert_eq!(clear.status(), reqwest::StatusCode::OK);
    let history: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{task_id}/history"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(!history["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|op| op["field"] == format!("attribute/{attr_id}")));
    cleanup(server, schema, admin).await;
}
