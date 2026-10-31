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
    let schema = format!(
        "calendar_{}_{}",
        std::process::id(),
        Uuid::new_v4().simple()
    );
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
    let member = add_member(&pool, workspace, "member@example.com", "member").await;
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

async fn add_member(pool: &sqlx::PgPool, workspace: Uuid, email: &str, role: &str) -> Uuid {
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

async fn project(
    origin: &str,
    workspace: Uuid,
    who: &Session,
    name: &str,
    visibility: &str,
) -> Uuid {
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
    .json::<serde_json::Value>()
    .await
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn task(
    origin: &str,
    workspace: Uuid,
    project: Uuid,
    who: &Session,
    title: &str,
    start: Option<&str>,
    due: Option<&str>,
) -> serde_json::Value {
    request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        who,
    )
    .json(&serde_json::json!({"project_id":project,"title":title,"status":"todo","start_date":start,"due_date":due}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap()
}

async fn window(
    origin: &str,
    workspace: Uuid,
    who: &Session,
    query: &str,
) -> (reqwest::StatusCode, serde_json::Value) {
    let response = request(
        &reqwest::Client::new(),
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks?{query}"),
        who,
    )
    .send()
    .await
    .unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

fn titles(body: &serde_json::Value) -> Vec<String> {
    let mut titles: Vec<String> = body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap().to_owned())
        .collect();
    titles.sort();
    titles
}

#[tokio::test(flavor = "multi_thread")]
async fn date_window_lists_tasks_on_start_or_due_date_and_hides_restricted_projects() {
    let (origin, server, schema, admin, workspace, owner, member) = fixture().await;
    let open = project(&origin, workspace, &member, "Open", "workspace").await;
    let secret = project(&origin, workspace, &member, "Secret", "restricted").await;
    task(
        &origin,
        workspace,
        open,
        &member,
        "starts-in",
        Some("2026-11-02"),
        None,
    )
    .await;
    task(
        &origin,
        workspace,
        open,
        &member,
        "due-in",
        None,
        Some("2026-11-10"),
    )
    .await;
    task(
        &origin,
        workspace,
        open,
        &member,
        "both-in",
        Some("2026-11-03"),
        Some("2026-11-30"),
    )
    .await;
    task(
        &origin,
        workspace,
        open,
        &member,
        "due-after",
        Some("2026-10-01"),
        Some("2026-12-01"),
    )
    .await;
    task(&origin, workspace, open, &member, "no-dates", None, None).await;
    task(
        &origin,
        workspace,
        secret,
        &member,
        "secret-in",
        None,
        Some("2026-11-10"),
    )
    .await;

    let q = "from=2026-11-01&to=2026-11-30";
    let (status, body) = window(&origin, workspace, &member, q).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(
        titles(&body),
        ["both-in", "due-in", "secret-in", "starts-in"]
    );

    // A member without access to the Restricted Project sees no title and no count of it.
    let (status, body) = window(&origin, workspace, &owner, q).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(titles(&body), ["both-in", "due-in", "starts-in"]);
    assert!(!body.to_string().contains("secret"));

    // The window composes with the active filter.
    let (_, body) = window(
        &origin,
        workspace,
        &member,
        &format!("{q}&project_id={open}"),
    )
    .await;
    assert_eq!(titles(&body), ["both-in", "due-in", "starts-in"]);
    let (_, body) = window(&origin, workspace, &member, &format!("{q}&status=done")).await;
    assert!(titles(&body).is_empty());

    // A single-day window matches only that date.
    let (_, body) = window(&origin, workspace, &member, "from=2026-11-10&to=2026-11-10").await;
    assert_eq!(titles(&body), ["due-in", "secret-in"]);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn date_window_rejects_bad_input_with_422() {
    let (origin, server, schema, admin, workspace, _owner, member) = fixture().await;
    for query in [
        "from=2026-11-01",
        "to=2026-11-30",
        "from=nope&to=2026-11-30",
        "from=2026-13-01&to=2026-12-01",
        "from=2026-11-30&to=2026-11-01",
        "from=2020-01-01&to=2030-01-01",
    ] {
        let (status, _) = window(&origin, workspace, &member, query).await;
        assert_eq!(status, reqwest::StatusCode::UNPROCESSABLE_ENTITY, "{query}");
    }
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn moving_a_date_is_one_versioned_update_one_history_entry_and_undoable() {
    let (origin, server, schema, admin, workspace, _owner, member) = fixture().await;
    let open = project(&origin, workspace, &member, "Open", "workspace").await;
    let created = task(
        &origin,
        workspace,
        open,
        &member,
        "move me",
        None,
        Some("2026-11-10"),
    )
    .await;
    let id = created["id"].as_str().unwrap();
    let client = reqwest::Client::new();
    let url = format!("{origin}/api/v1/tasks/{id}");
    let moved = request(&client, reqwest::Method::PATCH, url.clone(), &member)
        .json(&serde_json::json!({"expected_version":1,"due_date":"2026-11-11"}))
        .send()
        .await
        .unwrap();
    assert_eq!(moved.status(), reqwest::StatusCode::OK);
    let moved: serde_json::Value = moved.json().await.unwrap();
    assert_eq!(moved["due_date"], "2026-11-11");
    assert_eq!(moved["version"], 2);

    // A stale version is refused with the current value so the draft can be kept.
    let stale = request(&client, reqwest::Method::PATCH, url.clone(), &member)
        .json(&serde_json::json!({"expected_version":1,"due_date":"2026-11-15"}))
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), reqwest::StatusCode::CONFLICT);
    let stale: serde_json::Value = stale.json().await.unwrap();
    assert_eq!(stale["current"]["due_date"], "2026-11-11");

    let history: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{url}/history"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let due: Vec<_> = history["operations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["field"] == "due_date")
        .collect();
    assert_eq!(due.len(), 1);

    let undo = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    assert_eq!(
        undo.json::<serde_json::Value>().await.unwrap()["task"]["due_date"],
        "2026-11-10"
    );
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_settings_carry_week_start_and_a_time_zone_aware_today() {
    let (origin, server, schema, admin, workspace, owner, member) = fixture().await;
    let client = reqwest::Client::new();
    let url = format!("{origin}/api/v1/workspaces/{workspace}/settings");
    let read = |who: &Session| request(&client, reqwest::Method::GET, url.clone(), who).send();
    let defaults: serde_json::Value = read(&member).await.unwrap().json().await.unwrap();
    assert_eq!(defaults["time_zone"], "UTC");
    assert_eq!(defaults["week_start"], 1);
    assert!(defaults["today"].as_str().unwrap().len() == 10);

    let patch = |who: &Session, body: serde_json::Value| {
        request(&client, reqwest::Method::PATCH, url.clone(), who)
            .json(&body)
            .send()
    };
    assert_eq!(
        patch(&member, serde_json::json!({"week_start":0}))
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    for bad in [
        serde_json::json!({"week_start":7}),
        serde_json::json!({"time_zone":"Mars/Base"}),
        serde_json::json!({"time_zone":""}),
    ] {
        assert_eq!(
            patch(&owner, bad).await.unwrap().status(),
            reqwest::StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let east: serde_json::Value = patch(
        &owner,
        serde_json::json!({"time_zone":"Pacific/Kiritimati","week_start":0}),
    )
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(east["week_start"], 0);
    let east_today = read(&member)
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap()["today"]
        .clone();
    patch(&owner, serde_json::json!({"time_zone":"Etc/GMT+12"}))
        .await
        .unwrap();
    let west: serde_json::Value = read(&member).await.unwrap().json().await.unwrap();
    // UTC+14 and UTC-12 are 26 hours apart, so their calendar dates always differ.
    assert_ne!(east_today, west["today"]);
    assert_eq!(west["week_start"], 0);

    let pool = sqlx::PgPool::connect(&format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    ))
    .await
    .unwrap();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,'out@example.com','unused')")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let outsider = session(&pool, id).await;
    assert_eq!(
        read(&outsider).await.unwrap().status(),
        reqwest::StatusCode::NOT_FOUND
    );
    cleanup(server, schema, admin).await;
}

async fn cleanup(server: tokio::task::JoinHandle<()>, schema: String, admin: sqlx::PgPool) {
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
