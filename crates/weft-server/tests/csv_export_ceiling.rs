use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    _user_id: Uuid,
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
    let schema = format!("csvx_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
        _user_id: user,
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

async fn create(
    client: &reqwest::Client,
    origin: &str,
    workspace: Uuid,
    who: &Session,
    project: &str,
    title: &str,
) {
    let response = request(
        client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        who,
    )
    .json(&serde_json::json!({"project_id":project,"title":title}))
    .send()
    .await
    .unwrap();
    assert!(response.status().is_success());
}

#[tokio::test(flavor = "multi_thread")]
async fn export_stops_at_the_row_ceiling_and_says_so() {
    std::env::set_var("WEFT_EXPORT_ROW_CEILING", "3");
    let (origin, server, schema, admin, workspace, owner, _member) = setup().await;
    let client = reqwest::Client::new();
    let project: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &owner,
    )
    .json(&serde_json::json!({"name":"P","visibility":"workspace"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let project = project["id"].as_str().unwrap();
    for n in 0..5 {
        create(
            &client,
            &origin,
            workspace,
            &owner,
            project,
            &format!("Task {n}"),
        )
        .await;
    }
    let response = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/export.csv"),
        &owner,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.headers()["x-weft-export-truncated"], "true");
    assert_eq!(response.headers()["x-weft-export-rows"], "3");
    let text = response.text().await.unwrap();
    assert_eq!(text.lines().count(), 1 + 3 + 1);
    assert!(text.contains("Task 2") && !text.contains("Task 3"));
    let last = text.lines().last().unwrap();
    assert!(
        last.contains("stopped at the 3 row limit") && last.contains("not a backup"),
        "{last}"
    );
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn more_concurrent_exports_than_pool_connections_all_finish() {
    // Same value as the ceiling test: both set it process-wide.
    std::env::set_var("WEFT_EXPORT_ROW_CEILING", "3");
    let (origin, server, schema, admin, workspace, owner, _member) = setup().await;
    let client = reqwest::Client::new();
    let project: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &owner,
    )
    .json(&serde_json::json!({"name":"P","visibility":"workspace"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let project = project["id"].as_str().unwrap();
    for n in 0..5 {
        create(
            &client,
            &origin,
            workspace,
            &owner,
            project,
            &format!("Task {n}"),
        )
        .await;
    }
    let exports = (0..300).map(|_| {
        let client = client.clone();
        let url = format!("{origin}/api/v1/workspaces/{workspace}/tasks/export.csv");
        let req = request(&client, reqwest::Method::POST, url, &owner).json(&serde_json::json!({}));
        async move {
            let response = req.send().await.unwrap();
            let status = response.status();
            (status, response.text().await.unwrap())
        }
    });
    for (status, text) in futures_util::future::join_all(exports).await {
        assert!(status.is_success(), "{status}");
        assert_eq!(text.lines().count(), 1 + 3 + 1);
    }
    cleanup(server, schema, admin).await;
}
