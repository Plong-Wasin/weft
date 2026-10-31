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
        "timeline_{}_{}",
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
async fn link(
    origin: &str,
    who: &Session,
    blocker: &str,
    blocked: &str,
) -> (reqwest::StatusCode, serde_json::Value) {
    let response = request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{blocker}/relations"),
        who,
    )
    .json(&serde_json::json!({"target_task_id":blocked,"kind":"blocks"}))
    .send()
    .await
    .unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

async fn links(
    origin: &str,
    workspace: Uuid,
    who: &Session,
) -> (reqwest::StatusCode, serde_json::Value) {
    let response = request(
        &reqwest::Client::new(),
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/timeline-links"),
        who,
    )
    .send()
    .await
    .unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

async fn grant(pool: &sqlx::PgPool, workspace: Uuid, project: Uuid, user: Uuid, role: &str) {
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(workspace)
        .bind(project)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn timeline_links_draw_readable_edges_and_neutral_stubs_for_hidden_tasks() {
    let (origin, server, schema, admin, workspace, owner, member) = fixture().await;
    let open = project(&origin, workspace, &member, "Open", "workspace").await;
    let secret = project(&origin, workspace, &member, "Secret", "restricted").await;
    let a = task(
        &origin,
        workspace,
        open,
        &member,
        "alpha",
        Some("2026-11-02"),
        Some("2026-11-04"),
    )
    .await;
    let b = task(
        &origin,
        workspace,
        open,
        &member,
        "beta",
        Some("2026-11-05"),
        Some("2026-11-06"),
    )
    .await;
    let hidden = task(
        &origin,
        workspace,
        secret,
        &member,
        "classified",
        Some("2026-11-01"),
        Some("2026-11-02"),
    )
    .await;
    let hidden_after = task(
        &origin,
        workspace,
        secret,
        &member,
        "classified-after",
        None,
        None,
    )
    .await;
    let (a, b) = (a["id"].as_str().unwrap(), b["id"].as_str().unwrap());
    let (hidden, hidden_after) = (
        hidden["id"].as_str().unwrap(),
        hidden_after["id"].as_str().unwrap(),
    );
    assert_eq!(
        link(&origin, &member, a, b).await.0,
        reqwest::StatusCode::CREATED
    );
    assert_eq!(
        link(&origin, &member, hidden, a).await.0,
        reqwest::StatusCode::CREATED
    );
    assert_eq!(
        link(&origin, &member, b, hidden_after).await.0,
        reqwest::StatusCode::CREATED
    );
    assert_eq!(
        link(&origin, &member, hidden, hidden_after).await.0,
        reqwest::StatusCode::CREATED
    );

    // The member reads everything, so every edge is drawn and no stub is needed.
    let (status, body) = links(&origin, workspace, &member).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["links"].as_array().unwrap().len(), 4);
    assert!(body["stubs"].as_array().unwrap().is_empty());

    // The owner has no access to the Restricted Project: one edge, two neutral stubs.
    let (status, body) = links(&origin, workspace, &owner).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(
        body["links"],
        serde_json::json!([{"blocker_id":a,"blocked_id":b}])
    );
    let mut stubs: Vec<(String, String)> = body["stubs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["task_id"].as_str().unwrap().to_owned(),
                s["direction"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    stubs.sort();
    let mut want = vec![
        (a.to_owned(), "blocked_by".to_owned()),
        (b.to_owned(), "blocks".to_owned()),
    ];
    want.sort();
    assert_eq!(stubs, want);
    for stub in body["stubs"].as_array().unwrap() {
        assert_eq!(
            stub.as_object().unwrap().len(),
            2,
            "a stub carries only the readable end and a direction"
        );
    }
    let text = body.to_string();
    assert!(!text.contains("classified") && !text.contains(hidden) && !text.contains(hidden_after));

    // A member with no access to either Project sees no edge, no stub and no count.
    let pool = sqlx::PgPool::connect(&format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    ))
    .await
    .unwrap();
    let guest_id = add_member(&pool, workspace, "guest@example.com", "member").await;
    let guest = session(&pool, guest_id).await;
    let (_, body) = links(&origin, workspace, &guest).await;
    assert_eq!(
        body["links"],
        serde_json::json!([{"blocker_id":a,"blocked_id":b}])
    );
    // Granting the Restricted Project reveals the chain, so access, not the link, decides.
    grant(&pool, workspace, secret, guest_id, "viewer").await;
    let (_, body) = links(&origin, workspace, &guest).await;
    assert_eq!(body["links"].as_array().unwrap().len(), 4);

    // A person outside the Workspace learns nothing.
    let outsider = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,'out@example.com','unused')")
        .bind(outsider)
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = links(&origin, workspace, &session(&pool, outsider).await).await;
    assert_eq!(status, reqwest::StatusCode::NOT_FOUND);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_loop_through_the_timeline_is_refused_with_a_chain_of_readable_tasks_only() {
    let (origin, server, schema, admin, workspace, _owner, member) = fixture().await;
    let open = project(&origin, workspace, &member, "Open", "workspace").await;
    let secret = project(&origin, workspace, &member, "Secret", "restricted").await;
    let a = task(&origin, workspace, open, &member, "alpha", None, None).await;
    let b = task(&origin, workspace, open, &member, "beta", None, None).await;
    let hidden = task(
        &origin,
        workspace,
        secret,
        &member,
        "classified",
        None,
        None,
    )
    .await;
    let (a, b, hidden) = (
        a["id"].as_str().unwrap(),
        b["id"].as_str().unwrap(),
        hidden["id"].as_str().unwrap(),
    );
    assert_eq!(
        link(&origin, &member, a, hidden).await.0,
        reqwest::StatusCode::CREATED
    );
    assert_eq!(
        link(&origin, &member, hidden, b).await.0,
        reqwest::StatusCode::CREATED
    );
    let pool = sqlx::PgPool::connect(&format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    ))
    .await
    .unwrap();
    let editor_id = add_member(&pool, workspace, "editor@example.com", "member").await;
    grant(&pool, workspace, open, editor_id, "contributor").await;
    let editor = session(&pool, editor_id).await;
    let (status, body) = link(&origin, &editor, b, a).await;
    assert_eq!(status, reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"], "relation_cycle");
    assert!(!body.to_string().contains("classified"));
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn moving_and_resizing_a_bar_changes_only_that_task_in_one_history_entry() {
    let (origin, server, schema, admin, workspace, owner, member) = fixture().await;
    // Around the US daylight-saving change (2026-03-08) and a month end in the Workspace zone.
    let zone = request(
        &reqwest::Client::new(),
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/workspaces/{workspace}/settings"),
        &owner,
    )
    .json(&serde_json::json!({"time_zone":"America/New_York"}))
    .send()
    .await
    .unwrap();
    assert_eq!(zone.status(), reqwest::StatusCode::OK);
    let open = project(&origin, workspace, &member, "Open", "workspace").await;
    let bar = task(
        &origin,
        workspace,
        open,
        &member,
        "bar",
        Some("2026-03-07"),
        Some("2026-03-09"),
    )
    .await;
    let after = task(
        &origin,
        workspace,
        open,
        &member,
        "after",
        Some("2026-03-10"),
        Some("2026-03-12"),
    )
    .await;
    let (bar_id, after_id) = (bar["id"].as_str().unwrap(), after["id"].as_str().unwrap());
    assert_eq!(
        link(&origin, &member, bar_id, after_id).await.0,
        reqwest::StatusCode::CREATED
    );
    let client = reqwest::Client::new();
    let patch = |id: &str, body: serde_json::Value| {
        request(
            &client,
            reqwest::Method::PATCH,
            format!("{origin}/api/v1/tasks/{id}"),
            &member,
        )
        .json(&body)
        .send()
    };
    let current = |id: &str| {
        let url = format!("{origin}/api/v1/workspaces/{workspace}/tasks?project_id={open}");
        let id = id.to_owned();
        let request = request(&client, reqwest::Method::GET, url, &member).send();
        async move {
            let body: serde_json::Value = request.await.unwrap().json().await.unwrap();
            body["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == id.as_str())
                .unwrap()
                .clone()
        }
    };
    let version = current(bar_id).await["version"].as_i64().unwrap();
    // A move sets both dates in one update, across the clock change and into the next month.
    let moved: serde_json::Value = patch(bar_id, serde_json::json!({"expected_version":version,"start_date":"2026-03-31","due_date":"2026-04-02"}))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        (moved["start_date"].as_str(), moved["due_date"].as_str()),
        (Some("2026-03-31"), Some("2026-04-02"))
    );
    // A resize changes one date.
    let resized: serde_json::Value = patch(
        bar_id,
        serde_json::json!({"expected_version":moved["version"],"due_date":"2026-04-08"}),
    )
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        (resized["start_date"].as_str(), resized["due_date"].as_str()),
        (Some("2026-03-31"), Some("2026-04-08"))
    );
    let other = current(after_id).await;
    assert_eq!(
        (other["start_date"].as_str(), other["due_date"].as_str()),
        (Some("2026-03-10"), Some("2026-03-12"))
    );
    assert_eq!(other["version"], 2, "only the link bumped the other Task");

    let undo = || {
        request(
            &client,
            reqwest::Method::POST,
            format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
            &member,
        )
        .json(&serde_json::json!({}))
        .send()
    };
    assert_eq!(undo().await.unwrap().status(), reqwest::StatusCode::OK);
    let back = current(bar_id).await;
    assert_eq!(
        (back["start_date"].as_str(), back["due_date"].as_str()),
        (Some("2026-03-31"), Some("2026-04-02"))
    );
    // One undo reverts the whole move: both dates return together.
    assert_eq!(undo().await.unwrap().status(), reqwest::StatusCode::OK);
    let original = current(bar_id).await;
    assert_eq!(
        (
            original["start_date"].as_str(),
            original["due_date"].as_str()
        ),
        (Some("2026-03-07"), Some("2026-03-09"))
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
