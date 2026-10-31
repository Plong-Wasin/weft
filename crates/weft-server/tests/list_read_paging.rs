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
    let schema = format!("lpag_{}_{}", std::process::id(), Uuid::new_v4().simple());
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

#[tokio::test(flavor = "multi_thread")]
async fn a_manual_list_response_is_capped_and_total_stays_true() {
    let (origin, server, schema, admin, workspace, owner, _member) = setup().await;
    let client = reqwest::Client::new();
    let base = format!("{origin}/api/v1/workspaces/{workspace}");
    let project: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{base}/projects"),
        &owner,
    )
    .json(&serde_json::json!({"name":"P","visibility":"workspace"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let project: Uuid = project["id"].as_str().unwrap().parse().unwrap();
    let list: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{base}/lists"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Big"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let list: Uuid = list["id"].as_str().unwrap().parse().unwrap();
    let pool = sqlx::PgPool::connect(&format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    ))
    .await
    .unwrap();
    let creator: Uuid =
        sqlx::query_scalar("SELECT user_id FROM workspace_memberships WHERE role='owner'")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,created_by) SELECT gen_random_uuid(),$1,g,$2,'Bulk '||g,$3 FROM generate_series(1,5100) g")
        .bind(workspace).bind(project).bind(creator).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO task_list_memberships(workspace_id,list_id,task_id,position) SELECT $1,$2,t.id,t.number FROM tasks t WHERE t.workspace_id=$1")
        .bind(workspace).bind(list).execute(&pool).await.unwrap();
    let read: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{base}/lists/{list}"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(read["total"], 5100);
    assert_eq!(read["tasks"].as_array().unwrap().len(), 5000);
    assert_eq!(read["limit"], 5000);
    // An explicit page still works past the cap.
    let tail: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{base}/lists/{list}?limit=500&offset=5000"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(tail["tasks"].as_array().unwrap().len(), 100);
    assert_eq!(tail["total"], 5100);
    cleanup(server, schema, admin).await;
}
