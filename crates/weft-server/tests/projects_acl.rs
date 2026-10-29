use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct UserSession {
    id: Uuid,
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
    UserSession,
) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!(
        "projects_{}_{}",
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
    let root = std::env::temp_dir().join(format!("weft-projects-{schema}"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("index.html"), "Weft").unwrap();
    let server_db = scoped.clone();
    let server = tokio::spawn(async move {
        let r = serve(listener, ServerConfig::new(server_db, root)).await;
        eprintln!("SERVE ENDED: {r:?}");
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
    let workspace: Uuid = sqlx::query_scalar("SELECT id FROM workspaces")
        .fetch_one(&pool)
        .await
        .unwrap();
    let owner: Uuid =
        sqlx::query_scalar("SELECT user_id FROM workspace_memberships WHERE role='owner'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let member = add_user(&pool, workspace, "member@example.com", "member").await;
    let viewer = add_user(&pool, workspace, "viewer@example.com", "viewer").await;
    let owner_session = session(&pool, owner).await;
    let member_session = session(&pool, member).await;
    let viewer_session = session(&pool, viewer).await;
    (
        origin,
        server,
        schema,
        admin,
        workspace,
        owner_session,
        member_session,
        viewer_session,
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
        id: user,
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
    let r = client
        .request(method, url)
        .header(reqwest::header::COOKIE, &who.cookie);
    if r.try_clone().is_some() {
        r.header("x-csrf-token", &who.csrf)
    } else {
        r
    }
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
async fn members_create_projects_and_viewers_cannot_write() {
    let (origin, server, schema, admin, workspace, _owner, member, viewer) = setup().await;
    let client = reqwest::Client::new();
    let created = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &member,
    )
    .json(&serde_json::json!({"name":"Roadmap","visibility":"restricted"}))
    .send()
    .await
    .unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let project: serde_json::Value = created.json().await.unwrap();
    assert_eq!(project["visibility"], "restricted");
    let denied = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &viewer,
    )
    .json(&serde_json::json!({"name":"Nope","visibility":"workspace"}))
    .send()
    .await
    .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    cleanup(server, schema, admin).await;
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

#[tokio::test(flavor = "multi_thread")]
async fn project_grants_are_capped_by_workspace_viewer_and_admin_self_grant_is_audited() {
    let (origin, server, schema, admin, workspace, owner, member, viewer) = setup().await;
    let client = reqwest::Client::new();
    let restricted = create_project(&origin, workspace, &member, "Private", "restricted").await;
    let project_id = restricted["id"].as_str().unwrap();

    let hidden = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/projects/{project_id}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(hidden.status(), reqwest::StatusCode::NOT_FOUND);
    let owner_projects: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(!owner_projects["projects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == project_id));
    let admin_self_add = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/projects/{project_id}/members"),
        &owner,
    )
    .json(&serde_json::json!({"user_id":owner.id,"role":"manager"}))
    .send()
    .await
    .unwrap();
    assert_eq!(admin_self_add.status(), reqwest::StatusCode::NO_CONTENT);
    let now_readable: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/projects/{project_id}"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(now_readable["role"], "manager");
    let audit: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/auth/audit-events"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["event"] == "project.admin_self_membership"
            && event["subject_id"] == project_id));

    let add_viewer = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/projects/{project_id}/members"),
        &member,
    )
    .json(&serde_json::json!({"user_id":viewer.id,"role":"manager"}))
    .send()
    .await
    .unwrap();
    assert_eq!(add_viewer.status(), reqwest::StatusCode::NO_CONTENT);
    let ceiling: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/projects/{project_id}"),
        &viewer,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(ceiling["role"], "viewer");
    let denied = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/projects/{project_id}"),
        &viewer,
    )
    .json(&serde_json::json!({"name":"Changed"}))
    .send()
    .await
    .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::NOT_FOUND);

    let visible = create_project(&origin, workspace, &member, "Open", "workspace").await;
    let visible_id = visible["id"].as_str().unwrap();
    let visible_read = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/projects/{visible_id}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(visible_read.status(), reqwest::StatusCode::OK);
    let add_contributor = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/projects/{visible_id}/members"),
        &member,
    )
    .json(&serde_json::json!({"user_id":owner.id,"role":"contributor"}))
    .send()
    .await
    .unwrap();
    assert_eq!(add_contributor.status(), reqwest::StatusCode::NO_CONTENT);
    let union: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/projects/{visible_id}"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(union["role"], "contributor");

    let rename = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/projects/{project_id}"),
        &member,
    )
    .json(&serde_json::json!({"name":"Private renamed","visibility":"workspace"}))
    .send()
    .await
    .unwrap();
    assert_eq!(rename.status(), reqwest::StatusCode::OK);
    let archived = request(
        &client,
        reqwest::Method::DELETE,
        format!("{origin}/api/v1/projects/{project_id}"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(archived.status(), reqwest::StatusCode::NO_CONTENT);
    let archived_hidden = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/projects/{project_id}"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(archived_hidden.status(), reqwest::StatusCode::NOT_FOUND);
    cleanup(server, schema, admin).await;
}
