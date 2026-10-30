use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct UserSession {
    user_id: Uuid,
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
) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!(
        "realtime_{}_{}",
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
    let root = std::env::temp_dir().join(format!("weft-realtime-{schema}"));
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
    let member = add_user(&pool, workspace, "member@example.com", "member").await;
    let owner_session = session(&pool, owner).await;
    let member_session = session(&pool, member).await;
    (
        origin,
        server,
        schema,
        admin,
        workspace,
        owner_session,
        member_session,
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
        user_id: user,
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
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf)
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

async fn cleanup(server: tokio::task::JoinHandle<()>, schema: String, admin: sqlx::PgPool) {
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

fn url(origin: &str, path: &str) -> String {
    format!("{origin}/api/v1{path}")
}

async fn json_of(response: reqwest::Response) -> serde_json::Value {
    response.json().await.unwrap()
}

async fn open_stream(
    client: &reqwest::Client,
    origin: &str,
    workspace: Uuid,
    who: &UserSession,
    after: i64,
) -> reqwest::Response {
    let stream = request(
        client,
        reqwest::Method::GET,
        url(
            origin,
            &format!("/workspaces/{workspace}/realtime/events?after={after}"),
        ),
        who,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(stream.status(), reqwest::StatusCode::OK);
    stream
}

async fn snapshot(
    client: &reqwest::Client,
    origin: &str,
    workspace: Uuid,
    who: &UserSession,
    after: i64,
) -> serde_json::Value {
    json_of(
        request(
            client,
            reqwest::Method::GET,
            url(
                origin,
                &format!("/workspaces/{workspace}/realtime/snapshot?after={after}"),
            ),
            who,
        )
        .send()
        .await
        .unwrap(),
    )
    .await
}

struct Feed {
    response: reqwest::Response,
    body: String,
}

impl Feed {
    fn new(response: reqwest::Response) -> Self {
        Feed {
            response,
            body: String::new(),
        }
    }
}

/// Reads the stream until `done` accepts every event received so far (the feed keeps its buffer).
async fn read_until(
    feed: &mut Feed,
    done: impl Fn(&[serde_json::Value]) -> bool,
) -> Vec<serde_json::Value> {
    let Feed {
        response: stream,
        body,
    } = feed;
    let mut events = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            events = body
                .split("\n\n")
                .filter_map(|block| {
                    let kind = block
                        .lines()
                        .find_map(|line| line.strip_prefix("event: "))?;
                    let data = block.lines().find_map(|line| line.strip_prefix("data: "))?;
                    let id = block.lines().find_map(|line| line.strip_prefix("id: "));
                    let mut value: serde_json::Value = serde_json::from_str(data).ok()?;
                    value["event"] = kind.into();
                    value["event_id"] = id.map(|id| id.parse::<i64>().unwrap()).into();
                    Some(value)
                })
                .collect();
            if done(&events) {
                return;
            }
            match stream.chunk().await.unwrap() {
                Some(chunk) => body.push_str(&String::from_utf8_lossy(&chunk)),
                None => return,
            }
        }
    })
    .await;
    assert!(
        result.is_ok(),
        "expected realtime events did not arrive; saw {events:?}"
    );
    events
}

fn has(events: &[serde_json::Value], kind: &str, id: &str, change: &str) -> bool {
    events.iter().any(|event| {
        event["entity_type"] == kind && event["entity_id"] == id && event["change"] == change
    })
}

async fn restricted_project_with_viewer(
    origin: &str,
    workspace: Uuid,
    owner: &UserSession,
    viewer: Uuid,
    admin_pool: &str,
) -> (String, sqlx::PgPool) {
    let project = create_project(origin, workspace, owner, "Restricted", "restricted").await;
    let id = project["id"].as_str().unwrap().to_string();
    let pool = sqlx::PgPool::connect(admin_pool).await.unwrap();
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')")
        .bind(workspace).bind(id.parse::<Uuid>().unwrap()).bind(viewer).execute(&pool).await.unwrap();
    (id, pool)
}

fn scoped_url(schema: &str) -> String {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    format!("{base}?options=-csearch_path%3D{schema}")
}

#[tokio::test(flavor = "multi_thread")]
async fn two_sessions_converge_after_comment_edit_undo_and_delete() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let (project, pool) = restricted_project_with_viewer(
        &origin,
        workspace,
        &owner,
        member.user_id,
        &scoped_url(&schema),
    )
    .await;
    let task = json_of(
        request(
            &client,
            reqwest::Method::POST,
            url(&origin, &format!("/workspaces/{workspace}/tasks")),
            &owner,
        )
        .json(&serde_json::json!({"project_id":project,"title":"Shared"}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    let task_id = task["id"].as_str().unwrap().to_string();
    let start = snapshot(&client, &origin, workspace, &member, 0).await;
    assert!(start["visible_task_ids"]
        .as_array()
        .unwrap()
        .iter()
        .any(|id| id == &task["id"]));
    let mut stream = Feed::new(
        open_stream(
            &client,
            &origin,
            workspace,
            &member,
            start["cursor"].as_i64().unwrap(),
        )
        .await,
    );

    let comment = json_of(
        request(
            &client,
            reqwest::Method::POST,
            url(&origin, &format!("/tasks/{task_id}/comments")),
            &owner,
        )
        .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"hello"}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    let comment_id = comment["id"].as_str().unwrap().to_string();
    let seen = read_until(&mut stream, |events| {
        has(events, "comment", &comment_id, "insert")
    })
    .await;
    let created = seen
        .iter()
        .find(|event| event["entity_id"] == comment_id.as_str())
        .unwrap();
    assert_eq!(created["task_id"], task_id.as_str());
    assert!(created["operation_id"].is_string());
    assert!(created["version"].as_i64().unwrap() >= 1);

    let patched = request(
        &client,
        reqwest::Method::PATCH,
        url(&origin, &format!("/tasks/{task_id}")),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":task["version"],"title":"Renamed"}))
    .send()
    .await
    .unwrap();
    assert_eq!(patched.status(), reqwest::StatusCode::OK);
    let seen = read_until(&mut stream, |events| {
        events
            .iter()
            .any(|e| e["change"] == "operation" && e["entity_id"] == task_id.as_str())
    })
    .await;
    let edit_operation = seen
        .iter()
        .rev()
        .find(|e| e["change"] == "operation")
        .unwrap()["operation_id"]
        .clone();

    let undo = request(
        &client,
        reqwest::Method::POST,
        url(&origin, &format!("/workspaces/{workspace}/history/undo")),
        &owner,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    let seen = read_until(&mut stream, |events| {
        events
            .iter()
            .any(|e| e["change"] == "undo" && e["entity_id"] == task_id.as_str())
    })
    .await;
    let undo_event = seen.iter().rev().find(|e| e["change"] == "undo").unwrap();
    assert_eq!(
        undo_event["operation_id"], edit_operation,
        "undo names the Operation it reverted"
    );
    assert!(seen.iter().any(|e| e["entity_type"] == "task"
        && e["change"] == "update"
        && e["entity_id"] == task_id.as_str()
        && e["version"].as_i64().unwrap() > task["version"].as_i64().unwrap()));

    let deleted = request(
        &client,
        reqwest::Method::DELETE,
        url(&origin, &format!("/tasks/{task_id}/comments/{comment_id}")),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert!(deleted.status().is_success(), "{}", deleted.status());
    read_until(&mut stream, |events| {
        has(events, "comment", &comment_id, "delete")
    })
    .await;

    // Replaying from the start delivers the same ids again (at least once), so a client must deduplicate.
    let mut replay = Feed::new(open_stream(&client, &origin, workspace, &member, 0).await);
    let first = read_until(&mut replay, |events| {
        has(events, "comment", &comment_id, "delete")
    })
    .await;
    let ids: Vec<i64> = first
        .iter()
        .filter_map(|e| e["event_id"].as_i64())
        .collect();
    assert!(
        ids.windows(2).all(|pair| pair[0] < pair[1]),
        "event ids are strictly increasing"
    );
    pool.close().await;
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reconnect_snapshot_carries_tombstones_for_removed_and_invisible_items() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let (project, pool) = restricted_project_with_viewer(
        &origin,
        workspace,
        &owner,
        member.user_id,
        &scoped_url(&schema),
    )
    .await;
    let mk = |title: &'static str| {
        request(
            &client,
            reqwest::Method::POST,
            url(&origin, &format!("/workspaces/{workspace}/tasks")),
            &owner,
        )
        .json(&serde_json::json!({"project_id":project,"title":title}))
    };
    let keep = json_of(mk("Keep").send().await.unwrap()).await;
    let archive = json_of(mk("Archive me").send().await.unwrap()).await;
    let comment = json_of(
        request(
            &client,
            reqwest::Method::POST,
            url(
                &origin,
                &format!("/tasks/{}/comments", keep["id"].as_str().unwrap()),
            ),
            &owner,
        )
        .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"bye"}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    let before = snapshot(&client, &origin, workspace, &member, 0).await;
    let cursor = before["cursor"].as_i64().unwrap();
    assert_eq!(before["visible_task_ids"].as_array().unwrap().len(), 2);
    assert!(before["tombstones"].as_array().unwrap().is_empty());

    // The member is offline: a comment is deleted and a Task archived.
    let gone = request(
        &client,
        reqwest::Method::DELETE,
        url(
            &origin,
            &format!(
                "/tasks/{}/comments/{}",
                keep["id"].as_str().unwrap(),
                comment["id"].as_str().unwrap()
            ),
        ),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert!(gone.status().is_success());
    let archived = request(
        &client,
        reqwest::Method::POST,
        url(
            &origin,
            &format!(
                "/workspaces/{workspace}/tasks/{}/archive",
                archive["number"]
            ),
        ),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":archive["version"]}))
    .send()
    .await
    .unwrap();
    assert_eq!(archived.status(), reqwest::StatusCode::OK);

    let after = snapshot(&client, &origin, workspace, &member, cursor).await;
    let tombstones = after["tombstones"].as_array().unwrap();
    assert!(
        tombstones.iter().any(|t| t["entity_type"] == "comment"
            && t["entity_id"] == comment["id"]
            && t["reason"] == "deleted"),
        "{after}"
    );
    assert!(
        tombstones.iter().any(|t| t["entity_type"] == "task"
            && t["entity_id"] == archive["id"]
            && t["reason"] == "archived"),
        "{after}"
    );
    assert_eq!(after["visible_task_ids"].as_array().unwrap().len(), 1);
    assert!(after["cursor"].as_i64().unwrap() > cursor);

    // Offline again: access to the project is removed. The Task is no longer visible, with no content.
    let revoke = request(
        &client,
        reqwest::Method::DELETE,
        url(
            &origin,
            &format!("/projects/{project}/members/{}", member.user_id),
        ),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(revoke.status(), reqwest::StatusCode::NO_CONTENT);
    let hidden = snapshot(&client, &origin, workspace, &member, cursor).await;
    assert!(hidden["visible_task_ids"].as_array().unwrap().is_empty());
    assert!(
        hidden["tombstones"].as_array().unwrap().is_empty(),
        "hidden items are never named: {hidden}"
    );
    pool.close().await;
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_access_stops_the_subscription_and_refuses_attachments() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let (project, pool) = restricted_project_with_viewer(
        &origin,
        workspace,
        &owner,
        member.user_id,
        &scoped_url(&schema),
    )
    .await;
    let task = json_of(
        request(
            &client,
            reqwest::Method::POST,
            url(&origin, &format!("/workspaces/{workspace}/tasks")),
            &owner,
        )
        .json(&serde_json::json!({"project_id":project,"title":"Secret"}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    let task_id = task["id"].as_str().unwrap().to_string();
    let comment = json_of(
        request(
            &client,
            reqwest::Method::POST,
            url(&origin, &format!("/tasks/{task_id}/comments")),
            &owner,
        )
        .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"evidence"}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    let attachment = json_of(
        request(&client, reqwest::Method::POST, url(&origin, &format!("/tasks/{task_id}/comments/{}/attachments", comment["id"].as_str().unwrap())), &owner)
            .json(&serde_json::json!({"file_name":"a.txt","content_type":"text/plain","content_hex":"6869"}))
            .send().await.unwrap(),
    )
    .await;
    let download = url(
        &origin,
        &format!(
            "/attachments/{}",
            attachment["storage_key"].as_str().unwrap()
        ),
    );
    let fetch = |suffix: &str| {
        request(
            &client,
            reqwest::Method::GET,
            format!("{download}{suffix}"),
            &member,
        )
        .send()
    };
    assert_eq!(fetch("").await.unwrap().status(), reqwest::StatusCode::OK);

    let start = snapshot(&client, &origin, workspace, &member, 0).await;
    let mut stream = Feed::new(
        open_stream(
            &client,
            &origin,
            workspace,
            &member,
            start["cursor"].as_i64().unwrap(),
        )
        .await,
    );
    let revoke = request(
        &client,
        reqwest::Method::DELETE,
        url(
            &origin,
            &format!("/projects/{project}/members/{}", member.user_id),
        ),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(revoke.status(), reqwest::StatusCode::NO_CONTENT);
    let seen = read_until(&mut stream, |events| {
        events.iter().any(|e| e["event"] == "scope_revoked")
    })
    .await;
    let revoked = seen.iter().find(|e| e["event"] == "scope_revoked").unwrap();
    assert!(revoked["project_ids"]
        .as_array()
        .unwrap()
        .iter()
        .any(|id| id == project.as_str()));

    // A change after the revoke never reaches the revoked member.
    let late = json_of(
        request(
            &client,
            reqwest::Method::POST,
            url(&origin, &format!("/tasks/{task_id}/comments")),
            &owner,
        )
        .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"after revoke"}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    while let Ok(Ok(Some(chunk))) =
        tokio::time::timeout(Duration::from_millis(300), stream.response.chunk()).await
    {
        stream.body.push_str(&String::from_utf8_lossy(&chunk));
    }
    assert!(
        !stream.body.contains(late["id"].as_str().unwrap()),
        "revoked member received {}",
        stream.body
    );
    assert_eq!(
        fetch("").await.unwrap().status(),
        reqwest::StatusCode::NOT_FOUND
    );
    assert_eq!(
        fetch("?preview=true").await.unwrap().status(),
        reqwest::StatusCode::NOT_FOUND
    );

    // Removing the member from the Workspace ends the stream itself.
    let mut open = Feed::new(open_stream(&client, &origin, workspace, &member, 0).await);
    let removed = request(
        &client,
        reqwest::Method::DELETE,
        url(
            &origin,
            &format!("/workspaces/{workspace}/members/{}", member.user_id),
        ),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(removed.status(), reqwest::StatusCode::NO_CONTENT);
    let seen = read_until(&mut open, |events| {
        events
            .iter()
            .any(|e| e["event"] == "scope_revoked" && e["workspace"] == true)
    })
    .await;
    assert!(!seen.is_empty());
    let end = tokio::time::timeout(Duration::from_secs(3), async {
        while open.response.chunk().await.unwrap().is_some() {}
    })
    .await;
    assert!(
        end.is_ok(),
        "stream stays open after the Workspace membership was removed"
    );
    let denied = request(
        &client,
        reqwest::Method::GET,
        url(&origin, &format!("/workspaces/{workspace}/realtime/events")),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::NOT_FOUND);
    pool.close().await;
    cleanup(server, schema, admin).await;
}
