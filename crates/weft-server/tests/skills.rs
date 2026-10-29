use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    cookie: String,
    csrf: String,
}

async fn fixture() -> (
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
    let schema = format!("skills_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
    let viewer = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'viewer@example.com','unused')",
    )
    .bind(viewer)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",
    )
    .bind(workspace)
    .bind(viewer)
    .execute(&pool)
    .await
    .unwrap();
    (
        origin,
        server,
        schema,
        admin,
        workspace,
        session(&pool, owner).await,
        session(&pool, viewer).await,
    )
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
fn req(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    session: &Session,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
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
async fn workspace_skills_are_seeded_readable_managed_versioned_and_configurable() {
    let (origin, server, schema, admin, workspace, owner, viewer) = fixture().await;
    let client = reqwest::Client::new();
    let list_url = format!("{origin}/api/v1/workspaces/{workspace}/skills");
    let list = req(&client, reqwest::Method::GET, list_url.clone(), &viewer)
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), reqwest::StatusCode::OK);
    let seeded: serde_json::Value = list.json().await.unwrap();
    let default_skill = seeded["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "How this Workspace works")
        .unwrap();
    let id = default_skill["id"].as_str().unwrap();
    let get = req(
        &client,
        reqwest::Method::GET,
        format!("{list_url}/{id}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(get.status(), reqwest::StatusCode::OK);
    assert!(get.json::<serde_json::Value>().await.unwrap()["body"]
        .as_str()
        .unwrap()
        .contains("list_teams"));
    let created = req(&client, reqwest::Method::POST, list_url.clone(), &owner).json(&serde_json::json!({"name":"Review process","description":"When to review","body":"Check #123 with @team"})).send().await.unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let created: serde_json::Value = created.json().await.unwrap();
    let created_id = created["id"].as_str().unwrap();
    let duplicate = req(&client, reqwest::Method::POST, list_url.clone(), &owner)
        .json(&serde_json::json!({"name":"Review process","description":"Duplicate name","body":"Ignored"}))
        .send().await.unwrap();
    assert_eq!(duplicate.status(), reqwest::StatusCode::CONFLICT);
    let create_undo = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}/undo"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(create_undo.status(), reqwest::StatusCode::OK);
    let hidden = req(
        &client,
        reqwest::Method::GET,
        format!("{list_url}/{created_id}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(hidden.status(), reqwest::StatusCode::NOT_FOUND);
    let create_redo = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}/redo"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(create_redo.status(), reqwest::StatusCode::OK);
    let read = req(
        &client,
        reqwest::Method::GET,
        format!("{list_url}/{created_id}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(read.status(), reqwest::StatusCode::OK);
    let denied = req(&client, reqwest::Method::POST, list_url.clone(), &viewer)
        .json(&serde_json::json!({"name":"Forbidden","description":"x","body":"x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);

    let updated = req(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}"),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":3,"body":"Updated #123 and @team"}))
    .send()
    .await
    .unwrap();
    assert_eq!(updated.status(), reqwest::StatusCode::OK);
    let history_url = format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}/history");
    let history: serde_json::Value = req(&client, reqwest::Method::GET, history_url, &viewer)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(history["operations"].as_array().unwrap().len(), 2);
    let undo = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}/undo"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    assert_eq!(
        undo.json::<serde_json::Value>().await.unwrap()["body"],
        "Check #123 with @team"
    );
    let redo = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}/redo"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(redo.status(), reqwest::StatusCode::OK);
    assert_eq!(
        redo.json::<serde_json::Value>().await.unwrap()["body"],
        "Updated #123 and @team"
    );
    let disabled = req(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}"),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":6,"enabled":false}))
    .send()
    .await
    .unwrap();
    assert_eq!(disabled.status(), reqwest::StatusCode::OK);
    let hidden_disabled = req(
        &client,
        reqwest::Method::GET,
        format!("{list_url}/{created_id}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(hidden_disabled.status(), reqwest::StatusCode::NOT_FOUND);
    let enabled = req(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}"),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":7,"enabled":true}))
    .send()
    .await
    .unwrap();
    assert_eq!(enabled.status(), reqwest::StatusCode::OK);

    let changed_default = req(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{id}"),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":1,"body":"Workspace specific content"}))
    .send()
    .await
    .unwrap();
    assert_eq!(changed_default.status(), reqwest::StatusCode::OK);
    let settings = req(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/settings"),
        &owner,
    )
    .json(&serde_json::json!({"max_body_chars":3}))
    .send()
    .await
    .unwrap();
    assert_eq!(settings.status(), reqwest::StatusCode::OK);
    let oversized = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/skills"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Too large","description":"Small","body":"More than three"}))
    .send()
    .await
    .unwrap();
    assert_eq!(
        oversized.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );

    let scoped_pool = sqlx::PgPool::connect(&format!(
        "postgres://weft:weft@127.0.0.1:55432/postgres?options=-csearch_path%3D{schema}"
    ))
    .await
    .unwrap();
    let second_owner = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'second-owner@example.com','unused')",
    )
    .bind(second_owner)
    .execute(&scoped_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    )
    .bind(workspace)
    .bind(second_owner)
    .execute(&scoped_pool)
    .await
    .unwrap();
    let default_again: String = sqlx::query_scalar("SELECT body FROM skills WHERE id=$1")
        .bind(id.parse::<Uuid>().unwrap())
        .fetch_one(&scoped_pool)
        .await
        .unwrap();
    assert_eq!(default_again, "Workspace specific content");
    let archived = req(
        &client,
        reqwest::Method::DELETE,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}"),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":8}))
    .send()
    .await
    .unwrap();
    assert_eq!(archived.status(), reqwest::StatusCode::NO_CONTENT);
    let archive_undo = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/skills/{created_id}/undo"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(archive_undo.status(), reqwest::StatusCode::OK);
    let archive_restore = req(
        &client,
        reqwest::Method::GET,
        format!("{list_url}/{created_id}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(archive_restore.status(), reqwest::StatusCode::OK);
    scoped_pool.close().await;
    cleanup(server, schema, admin).await;
}
