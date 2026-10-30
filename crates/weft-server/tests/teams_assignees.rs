use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    user: Uuid,
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
    Session,
) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("teams_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
            .is_ok_and(|response| response.status().is_success())
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
    let (workspace, owner): (Uuid, Uuid) = sqlx::query_as(
        "SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let member = add_user(&pool, workspace, "member@example.com", "member").await;
    let viewer = add_user(&pool, workspace, "viewer@example.com", "viewer").await;
    (
        origin,
        server,
        schema,
        admin,
        workspace,
        session(&pool, owner).await,
        session(&pool, member).await,
        session(&pool, viewer).await,
    )
}

async fn add_user(pool: &sqlx::PgPool, workspace: Uuid, email: &str, role: &str) -> Uuid {
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(user)
        .bind(email)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    user
}

async fn session(pool: &sqlx::PgPool, user: Uuid) -> Session {
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4())
        .bind(user)
        .bind(hash)
        .bind(&csrf)
        .execute(pool)
        .await
        .unwrap();
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

async fn create_project(origin: &str, workspace: Uuid, who: &Session) -> Uuid {
    request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        who,
    )
    .json(&serde_json::json!({"name":"Team project","visibility":"restricted"}))
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
    .json(&serde_json::json!({"project_id":project,"title":"Assigned work"}))
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
async fn assigned_inbox_entries_are_access_filtered_and_can_be_read_dismissed_and_muted() {
    let (origin, server, schema, admin, workspace, owner, member, viewer) = setup().await;
    let project = create_project(&origin, workspace, &owner).await;
    let client = reqwest::Client::new();
    let access = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/projects/{project}/members"),
        &owner,
    )
    .json(&serde_json::json!({"user_id":member.user,"role":"contributor"}))
    .send()
    .await
    .unwrap();
    assert!(access.status().is_success());
    let created = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &owner,
    )
    .json(&serde_json::json!({
        "project_id": project,
        "title": "Private assignment",
        "assignees": [{"type":"user","id":member.user}]
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let task: serde_json::Value = created.json().await.unwrap();

    let inbox: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/inbox"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(inbox["entries"].as_array().unwrap().len(), 1);
    let entry = &inbox["entries"][0];
    assert_eq!(entry["reason"], "assigned");
    assert_eq!(entry["task"]["title"], "Private assignment");
    assert!(entry["operation_group_id"].is_string());
    let entry_id = entry["id"].as_str().unwrap();

    let read = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/inbox/{entry_id}"),
        &member,
    )
    .json(&serde_json::json!({"read":true}))
    .send()
    .await
    .unwrap();
    assert_eq!(read.status(), reqwest::StatusCode::OK);
    let dismissed = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/inbox/{entry_id}"),
        &member,
    )
    .json(&serde_json::json!({"dismissed":true}))
    .send()
    .await
    .unwrap();
    assert_eq!(dismissed.status(), reqwest::StatusCode::OK);

    let muted = request(
        &client,
        reqwest::Method::PUT,
        format!(
            "{origin}/api/v1/tasks/{}/watch",
            task["id"].as_str().unwrap()
        ),
        &member,
    )
    .json(&serde_json::json!({"events":[],"muted":true}))
    .send()
    .await
    .unwrap();
    assert_eq!(muted.status(), reqwest::StatusCode::OK);

    let denied = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/inbox"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::OK);
    let denied: serde_json::Value = denied.json().await.unwrap();
    assert!(denied["entries"].as_array().unwrap().is_empty());

    let make_assigned_task = |title: &'static str| {
        request(
            &client,
            reqwest::Method::POST,
            format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
            &owner,
        )
        .json(&serde_json::json!({
            "project_id": project,
            "title": title,
            "assignees": [{"type":"user","id":member.user}]
        }))
    };
    let unread_task: serde_json::Value = make_assigned_task("Undo unread assignment")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let unread_inbox: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/inbox"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let unread_entry = unread_inbox["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["task"]["id"] == unread_task["id"])
        .unwrap();
    let unread_entry_id = unread_entry["id"].as_str().unwrap();
    let undone = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &owner,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(undone.status(), reqwest::StatusCode::OK);
    let after_unread_undo: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/inbox"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(!after_unread_undo["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == unread_entry_id));

    let read_task: serde_json::Value = make_assigned_task("Undo read assignment")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let read_inbox: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/inbox"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let read_entry = read_inbox["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["task"]["id"] == read_task["id"])
        .unwrap();
    let read_entry_id = read_entry["id"].as_str().unwrap();
    let read = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/inbox/{read_entry_id}"),
        &member,
    )
    .json(&serde_json::json!({"read":true}))
    .send()
    .await
    .unwrap();
    assert_eq!(read.status(), reqwest::StatusCode::OK);
    let undone_read = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &owner,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(undone_read.status(), reqwest::StatusCode::OK);
    let after_read_undo: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/inbox"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(after_read_undo["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == read_entry_id && entry["read"] == true));

    let revoked = request(
        &client,
        reqwest::Method::DELETE,
        format!("{origin}/api/v1/projects/{project}/members/{}", member.user),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(revoked.status(), reqwest::StatusCode::NO_CONTENT);
    let after_revocation: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/inbox"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(after_revocation["entries"].as_array().unwrap().is_empty());
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mentions_replies_and_member_selected_watcher_events_reach_the_inbox() {
    let (origin, server, schema, admin, workspace, owner, member, _) = setup().await;
    let project = create_project(&origin, workspace, &owner).await;
    let client = reqwest::Client::new();
    let grant = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/projects/{project}/members"),
        &owner,
    )
    .json(&serde_json::json!({"user_id":member.user,"role":"contributor"}))
    .send()
    .await
    .unwrap();
    assert!(grant.status().is_success());
    let created: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &owner,
    )
    .json(&serde_json::json!({"project_id":project,"title":"Discussion notifications"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let task_id = created["id"].as_str().unwrap();

    let watching = request(
        &client,
        reqwest::Method::PUT,
        format!("{origin}/api/v1/tasks/{task_id}/watch"),
        &member,
    )
    .json(&serde_json::json!({"events":["updated","comment","reply","mention"]}))
    .send()
    .await
    .unwrap();
    assert_eq!(watching.status(), reqwest::StatusCode::OK);

    let mentioned = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &owner,
    )
    .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"Hello @member@example.com"}))
    .send()
    .await
    .unwrap();
    assert_eq!(mentioned.status(), reqwest::StatusCode::CREATED);
    let parent: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &member,
    )
    .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"A reply target"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let reply = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &owner,
    )
    .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"Replying here","reply_to":parent["id"]}))
    .send().await.unwrap();
    assert_eq!(reply.status(), reqwest::StatusCode::CREATED);

    let updated = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{task_id}"),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":created["version"],"title":"Updated discussion notifications"}))
    .send().await.unwrap();
    assert_eq!(updated.status(), reqwest::StatusCode::OK);

    let inbox: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/inbox"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let entry = inbox["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["task"]["id"] == task_id)
        .unwrap();
    let reasons = entry["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(serde_json::Value::as_str)
        .collect::<Vec<_>>();
    assert!(reasons.contains(&"mentioned"), "{entry}");
    assert!(reasons.contains(&"replied"), "{entry}");
    assert!(reasons.contains(&"watched"), "{entry}");
    assert!(entry["operation_group_id"].is_string());
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_admin_manages_teams_and_every_member_can_see_them() {
    let (origin, server, schema, admin, workspace, owner, member, viewer) = setup().await;
    let client = reqwest::Client::new();
    let denied = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/teams"),
        &member,
    )
    .json(&serde_json::json!({"name":"Design"}))
    .send()
    .await
    .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);

    let created = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/teams"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Design"}))
    .send()
    .await
    .unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let team: serde_json::Value = created.json().await.unwrap();
    assert_eq!(team["name"], "Design");
    let id = team["id"].as_str().unwrap();

    let visible: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/teams"),
        &viewer,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(visible["teams"][0]["id"], id);
    assert_eq!(visible["teams"][0]["name"], "Design");
    let add_member = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/teams/{id}/members"),
        &owner,
    )
    .json(&serde_json::json!({"user_id":member.user}))
    .send()
    .await
    .unwrap();
    assert_eq!(add_member.status(), reqwest::StatusCode::NO_CONTENT);
    let member_list: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/teams/{id}/members"),
        &viewer,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(member_list["members"][0]["id"], member.user.to_string());

    let renamed = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/teams/{id}"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Product Design"}))
    .send()
    .await
    .unwrap();
    assert_eq!(renamed.status(), reqwest::StatusCode::OK);
    assert_eq!(
        renamed.json::<serde_json::Value>().await.unwrap()["name"],
        "Product Design"
    );
    let remove_member = request(
        &client,
        reqwest::Method::DELETE,
        format!("{origin}/api/v1/teams/{id}/members/{}", member.user),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(remove_member.status(), reqwest::StatusCode::NO_CONTENT);
    let removed = request(
        &client,
        reqwest::Method::DELETE,
        format!("{origin}/api/v1/teams/{id}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(removed.status(), reqwest::StatusCode::NO_CONTENT);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn team_project_grant_changes_access_immediately_and_is_capped_by_workspace_role() {
    let (origin, server, schema, admin, workspace, owner, member, viewer) = setup().await;
    let project = create_project(&origin, workspace, &member).await;
    let item = task(&origin, workspace, project, &member).await;
    let task_number = item["number"].as_i64().unwrap();
    let client = reqwest::Client::new();
    let direct_owner_grant = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/projects/{project}/members"),
        &member,
    )
    .json(&serde_json::json!({"user_id":owner.user,"role":"viewer"}))
    .send()
    .await
    .unwrap();
    assert!(direct_owner_grant.status().is_success());

    let team: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/teams"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Design"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let team_id = team["id"].as_str().unwrap();
    let add_owner = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/teams/{team_id}/members"),
        &owner,
    )
    .json(&serde_json::json!({"user_id":owner.user}))
    .send()
    .await
    .unwrap();
    assert!(add_owner.status().is_success());
    let add_viewer = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/teams/{team_id}/members"),
        &owner,
    )
    .json(&serde_json::json!({"user_id":viewer.user}))
    .send()
    .await
    .unwrap();
    assert!(add_viewer.status().is_success());

    let before = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{task_number}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(before.status(), reqwest::StatusCode::OK);
    let viewer_before = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{task_number}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(viewer_before.status(), reqwest::StatusCode::NOT_FOUND);

    let grant = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/projects/{project}/teams"),
        &member,
    )
    .json(&serde_json::json!({"team_id":team_id,"role":"contributor"}))
    .send()
    .await
    .unwrap();
    assert!(grant.status().is_success());
    let after = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{task_number}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(after.status(), reqwest::StatusCode::OK);
    let owner_write = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{task_number}"),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":1,"title":"Team access raised the direct grant"}))
    .send()
    .await
    .unwrap();
    assert_eq!(owner_write.status(), reqwest::StatusCode::OK);
    let viewer_after = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{task_number}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(viewer_after.status(), reqwest::StatusCode::OK);
    let viewer_write = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{task_number}"),
        &viewer,
    )
    .json(&serde_json::json!({"expected_version":2,"title":"Viewer ceiling"}))
    .send()
    .await
    .unwrap();
    assert_eq!(viewer_write.status(), reqwest::StatusCode::NOT_FOUND);

    let remove = request(
        &client,
        reqwest::Method::DELETE,
        format!("{origin}/api/v1/projects/{project}/teams/{team_id}"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert!(remove.status().is_success());
    let revoked = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{task_number}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(revoked.status(), reqwest::StatusCode::OK);
    let viewer_revoked = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{task_number}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(viewer_revoked.status(), reqwest::StatusCode::NOT_FOUND);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn task_assignees_support_direct_and_team_queue_take_and_undo() {
    let (origin, server, schema, admin, workspace, owner, member, viewer) = setup().await;
    let project = create_project(&origin, workspace, &member).await;
    let item = task(&origin, workspace, project, &member).await;
    let number = item["number"].as_i64().unwrap();
    let task_id = item["id"].as_str().unwrap();
    let client = reqwest::Client::new();
    let team: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/teams"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Design"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let team_id = team["id"].as_str().unwrap();
    request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/teams/{team_id}/members"),
        &owner,
    )
    .json(&serde_json::json!({"user_id":member.user}))
    .send()
    .await
    .unwrap();
    request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/teams/{team_id}/members"),
        &owner,
    )
    .json(&serde_json::json!({"user_id":viewer.user}))
    .send()
    .await
    .unwrap();

    let assigned = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{task_id}"),
        &member,
    )
    .json(&serde_json::json!({"expected_version":1,"assignees":[{"type":"team","id":team_id}]}))
    .send()
    .await
    .unwrap();
    assert_eq!(assigned.status(), reqwest::StatusCode::OK);
    let assigned: serde_json::Value = assigned.json().await.unwrap();
    assert_eq!(assigned["assignees"][0]["type"], "team");
    let assigned_team_does_not_grant_access = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{number}"),
        &viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(
        assigned_team_does_not_grant_access.status(),
        reqwest::StatusCode::NOT_FOUND
    );
    let queue: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/teams/{team_id}/queue"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(queue["tasks"][0]["number"], number);

    let my_work: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/my-work"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(my_work["tasks"], serde_json::json!([]));
    assert_eq!(my_work["via_team_tasks"][0]["number"], number);
    let my_work_with_teams: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/my-work?include_via_team=true"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(my_work_with_teams["tasks"][0]["number"], number);

    let taken = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{number}/take"),
        &member,
    )
    .json(&serde_json::json!({"expected_version":assigned["version"]}))
    .send()
    .await
    .unwrap();
    assert_eq!(taken.status(), reqwest::StatusCode::OK);
    let taken: serde_json::Value = taken.json().await.unwrap();
    assert!(taken["assignees"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["type"] == "user" && a["id"] == member.user.to_string()));
    assert!(!taken["assignees"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["type"] == "team"));
    let history: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{task_id}/history"),
        &member,
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
        .any(|operation| operation["field"] == "assignees"));

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
    let restored: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{number}"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        restored["assignees"],
        serde_json::json!([{"type":"team","id":team_id,"name":"Design"}])
    );

    let scoped = format!(
        "{}?options=-csearch_path%3D{}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into()),
        schema
    );
    let test_pool = sqlx::PgPool::connect(&scoped).await.unwrap();
    let notification_count: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_intents")
        .fetch_one(&test_pool)
        .await
        .unwrap();
    assert_eq!(
        notification_count, 0,
        "assigning a Team must not notify every member"
    );

    let invalid_direct_assignee = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{task_id}"),
        &member,
    )
    .json(&serde_json::json!({"expected_version":restored["version"],"assignees":[{"type":"team","id":team_id},{"type":"user","id":viewer.user}]}))
    .send()
    .await
    .unwrap();
    assert_eq!(
        invalid_direct_assignee.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    let direct_access = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/projects/{project}/members"),
        &member,
    )
    .json(&serde_json::json!({"user_id":owner.user,"role":"viewer"}))
    .send()
    .await
    .unwrap();
    assert_eq!(direct_access.status(), reqwest::StatusCode::NO_CONTENT);

    let with_direct_user = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{task_id}"),
        &member,
    )
    .json(&serde_json::json!({"expected_version":restored["version"],"assignees":[{"type":"team","id":team_id},{"type":"user","id":owner.user}]}))
    .send()
    .await
    .unwrap();
    assert_eq!(with_direct_user.status(), reqwest::StatusCode::OK);
    let with_direct_user: serde_json::Value = with_direct_user.json().await.unwrap();
    let notification_count: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_intents")
        .fetch_one(&test_pool)
        .await
        .unwrap();
    assert_eq!(
        notification_count, 1,
        "direct assignment records one notification intent"
    );
    let assignee_access = request(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/{number}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(assignee_access.status(), reqwest::StatusCode::OK);

    let removed_assignee = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{task_id}"),
        &member,
    )
    .json(&serde_json::json!({"expected_version":with_direct_user["version"],"assignees":[{"type":"team","id":team_id}]}))
    .send()
    .await
    .unwrap();
    assert_eq!(removed_assignee.status(), reqwest::StatusCode::OK);
    let revoked_user_access = request(
        &client,
        reqwest::Method::DELETE,
        format!("{origin}/api/v1/projects/{project}/members/{}", owner.user),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(
        revoked_user_access.status(),
        reqwest::StatusCode::NO_CONTENT
    );
    let undo_after_revocation = request(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(
        undo_after_revocation.status(),
        reqwest::StatusCode::CONFLICT
    );
    test_pool.close().await;
    cleanup(server, schema, admin).await;
}
