use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    user: Uuid,
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
    let schema = format!("history_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
        user,
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

async fn project(origin: &str, workspace: Uuid, who: &Session) -> Uuid {
    request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        who,
    )
    .json(&serde_json::json!({"name":"History","visibility":"workspace"}))
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

async fn task(origin: &str, workspace: Uuid, project: Uuid, who: &Session) -> serde_json::Value {
    request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        who,
    )
    .json(&serde_json::json!({"project_id":project,"title":"A","status":"backlog"}))
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
async fn timeline_compacts_same_actor_net_changes_and_undo_redo_projects_activity() {
    let (origin, server, schema, admin, workspace, _owner, member) = fixture().await;
    let project = project(&origin, workspace, &member).await;
    let task = task(&origin, workspace, project, &member).await;
    let id = task["id"].as_str().unwrap();
    let url = format!("{origin}/api/v1/tasks/{id}");
    let client = reqwest::Client::new();
    let patch = |version, title: &str, who: &Session| {
        request(&client, reqwest::Method::PATCH, url.clone(), who)
            .json(&serde_json::json!({"expected_version":version,"title":title}))
    };
    let first = patch(1, "B", &member).send().await.unwrap();
    assert_eq!(first.status(), reqwest::StatusCode::OK);
    let second = patch(2, "A", &member).send().await.unwrap();
    assert_eq!(second.status(), reqwest::StatusCode::OK);
    let timeline = request(
        &client,
        reqwest::Method::GET,
        format!("{url}/history"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(timeline.status(), reqwest::StatusCode::OK);
    assert!(
        timeline.json::<serde_json::Value>().await.unwrap()["operations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let noop = patch(3, "A", &member).send().await.unwrap();
    assert_eq!(noop.status(), reqwest::StatusCode::OK);
    assert_eq!(
        noop.json::<serde_json::Value>().await.unwrap()["version"],
        3
    );
    let changed = patch(3, "B", &member).send().await.unwrap();
    assert_eq!(changed.status(), reqwest::StatusCode::OK);
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
        undo.json::<serde_json::Value>().await.unwrap()["task"]["title"],
        "A"
    );
    let redo = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/redo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(redo.status(), reqwest::StatusCode::OK);
    assert_eq!(
        redo.json::<serde_json::Value>().await.unwrap()["task"]["title"],
        "B"
    );
    let third = patch(6, "C", &member).send().await.unwrap();
    assert_eq!(third.status(), reqwest::StatusCode::OK);
    let compacted: serde_json::Value = request(
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
    assert_eq!(compacted["operations"].as_array().unwrap().len(), 1);
    assert_eq!(compacted["operations"][0]["before"], "A");
    assert_eq!(compacted["operations"][0]["after"], "C");
    let status = request(&client, reqwest::Method::PATCH, url, &member)
        .json(&serde_json::json!({"expected_version":7,"status":"active"}))
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), reqwest::StatusCode::OK);
    assert_eq!(
        status.json::<serde_json::Value>().await.unwrap()["version"],
        8
    );
    let status_undo = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(status_undo.status(), reqwest::StatusCode::OK);
    assert_eq!(
        status_undo.json::<serde_json::Value>().await.unwrap()["task"]["status"],
        "backlog"
    );
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn interleaved_actor_edits_remain_visible_and_conflicts_apply_nothing() {
    let (origin, server, schema, admin, workspace, owner, member) = fixture().await;
    let project = project(&origin, workspace, &member).await;
    let mut tx = admin.begin().await.unwrap();
    sqlx::query(&format!("SET LOCAL search_path TO {schema}"))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'contributor')")
        .bind(workspace).bind(project).bind(owner.user).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let created = task(&origin, workspace, project, &member).await;
    let url = format!("{origin}/api/v1/tasks/{}", created["id"].as_str().unwrap());
    let client = reqwest::Client::new();
    let patch = |version, title: &str, who: &Session| {
        request(&client, reqwest::Method::PATCH, url.clone(), who)
            .json(&serde_json::json!({"expected_version":version,"title":title}))
    };
    assert_eq!(
        patch(1, "B", &member).send().await.unwrap().status(),
        reqwest::StatusCode::OK
    );
    assert_eq!(
        patch(2, "C", &owner).send().await.unwrap().status(),
        reqwest::StatusCode::OK
    );
    assert_eq!(
        patch(3, "A", &member).send().await.unwrap().status(),
        reqwest::StatusCode::OK
    );
    let timeline: serde_json::Value = request(
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
    assert_eq!(timeline["operations"].as_array().unwrap().len(), 3);
    let patch_other = request(&client, reqwest::Method::PATCH, url.clone(), &owner)
        .json(&serde_json::json!({"expected_version":4,"priority":"high"}))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_other.status(), reqwest::StatusCode::OK);
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
        undo.json::<serde_json::Value>().await.unwrap()["task"]["title"],
        "C"
    );
    let redo = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/redo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(redo.status(), reqwest::StatusCode::OK);
    let owner_edit = request(&client, reqwest::Method::PATCH, url.clone(), &owner)
        .json(&serde_json::json!({"expected_version":7,"title":"D"}))
        .send()
        .await
        .unwrap();
    assert_eq!(owner_edit.status(), reqwest::StatusCode::OK);
    let conflict = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(conflict.status(), reqwest::StatusCode::CONFLICT);
    let current: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/1"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(current["title"], "D");
    assert_eq!(current["priority"], "high");
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn bulk_edits_undo_as_one_atomic_group() {
    let (origin, server, schema, admin, workspace, owner, member) = fixture().await;
    let project = project(&origin, workspace, &member).await;
    let mut acl = admin.begin().await.unwrap();
    sqlx::query(&format!("SET LOCAL search_path TO {schema}"))
        .execute(&mut *acl)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'contributor')")
        .bind(workspace).bind(project).bind(owner.user).execute(&mut *acl).await.unwrap();
    acl.commit().await.unwrap();
    let first = task(&origin, workspace, project, &member).await;
    let second = request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":project,"title":"Second"}))
    .send()
    .await
    .unwrap()
    .json::<serde_json::Value>()
    .await
    .unwrap();
    let bulk=request(&reqwest::Client::new(),reqwest::Method::POST,format!("{origin}/api/v1/workspaces/{workspace}/tasks/bulk"),&member)
        .json(&serde_json::json!({"items":[{"task_id":first["id"],"expected_version":1,"title":"First edited"},{"task_id":second["id"],"expected_version":1,"title":"Second edited"}]})).send().await.unwrap();
    assert_eq!(bulk.status(), reqwest::StatusCode::OK);
    let group = bulk.json::<serde_json::Value>().await.unwrap()["group_id"].clone();
    let undo = request(
        &reqwest::Client::new(),
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
        undo.json::<serde_json::Value>().await.unwrap()["group_id"],
        group
    );
    let get = |n| {
        request(
            &reqwest::Client::new(),
            reqwest::Method::GET,
            format!("{origin}/api/v1/workspaces/{workspace}/tasks/{n}"),
            &member,
        )
    };
    assert_eq!(
        get(1)
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap()["title"],
        "A"
    );
    assert_eq!(
        get(2)
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap()["title"],
        "Second"
    );
    let second_bulk=request(&reqwest::Client::new(),reqwest::Method::POST,format!("{origin}/api/v1/workspaces/{workspace}/tasks/bulk"),&member)
        .json(&serde_json::json!({"items":[{"task_id":first["id"],"expected_version":3,"title":"First bulk 2"},{"task_id":second["id"],"expected_version":3,"title":"Second bulk 2"}]})).send().await.unwrap();
    assert_eq!(second_bulk.status(), reqwest::StatusCode::OK);
    let other = request(
        &reqwest::Client::new(),
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{}", second["id"].as_str().unwrap()),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":4,"title":"Other edit"}))
    .send()
    .await
    .unwrap();
    assert_eq!(other.status(), reqwest::StatusCode::OK);
    let blocked = request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(blocked.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        get(1)
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap()["title"],
        "First bulk 2"
    );
    assert_eq!(
        get(2)
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap()["title"],
        "Other edit"
    );
    cleanup(server, schema, admin).await;
}
