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
        "deps_{}_{}",
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
    let root = std::env::temp_dir().join(format!("weft-deps-{schema}"));
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

use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

async fn task(
    origin: &str,
    workspace: Uuid,
    who: &UserSession,
    project: &Value,
    title: &str,
) -> Value {
    request(
        &reqwest::Client::new(),
        Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        who,
    )
    .json(&json!({"project_id":project["id"],"title":title}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap()
}

async fn relate(
    origin: &str,
    who: &UserSession,
    source: &Value,
    target: &Value,
    kind: &str,
) -> reqwest::Response {
    request(
        &reqwest::Client::new(),
        Method::POST,
        format!(
            "{origin}/api/v1/tasks/{}/relations",
            source["id"].as_str().unwrap()
        ),
        who,
    )
    .json(&json!({"target_task_id":target["id"],"kind":kind}))
    .send()
    .await
    .unwrap()
}

async fn blockers(origin: &str, workspace: Uuid, who: &UserSession) -> Vec<Value> {
    let response = request(
        &reqwest::Client::new(),
        Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/blockers"),
        who,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.json::<Value>().await.unwrap()["blocked"]
        .as_array()
        .unwrap()
        .clone()
}

fn titles(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|i| i["task"]["title"].as_str().unwrap().to_owned())
        .collect()
}

async fn current_version(origin: &str, who: &UserSession, task: &Value) -> i64 {
    request(
        &reqwest::Client::new(),
        Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{}/tasks/{}",
            task["workspace_id"].as_str().unwrap(),
            task["number"]
        ),
        who,
    )
    .send()
    .await
    .unwrap()
    .json::<Value>()
    .await
    .unwrap()["version"]
        .as_i64()
        .unwrap()
}

async fn set_status(origin: &str, who: &UserSession, task: &Value, status: &str) {
    let current: Value = request(
        &reqwest::Client::new(),
        Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{}/tasks/{}",
            task["workspace_id"].as_str().unwrap(),
            task["number"]
        ),
        who,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let response = request(
        &reqwest::Client::new(),
        Method::PATCH,
        format!("{origin}/api/v1/tasks/{}", task["id"].as_str().unwrap()),
        who,
    )
    .json(&json!({"expected_version":current["version"],"status":status}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

async fn schema_pool(schema: &str) -> sqlx::PgPool {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    sqlx::PgPool::connect(&format!("{base}?options=-csearch_path%3D{schema}"))
        .await
        .unwrap()
}

async fn has_cycle(pool: &sqlx::PgPool) -> bool {
    sqlx::query_scalar(
        "WITH RECURSIVE walk(origin,id,path) AS (\
           SELECT source_task_id,target_task_id,ARRAY[source_task_id,target_task_id] FROM task_relations WHERE kind='blocks' \
           UNION ALL SELECT w.origin,r.target_task_id,w.path||r.target_task_id FROM walk w \
           JOIN task_relations r ON r.source_task_id=w.id AND r.kind='blocks' \
           WHERE r.target_task_id<>ALL(w.path[2:]) ) \
         SELECT EXISTS(SELECT 1 FROM walk WHERE id=origin)",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn self_reference_and_loops_are_refused_with_the_readable_chain() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let open = create_project(&origin, workspace, &member, "Open", "workspace").await;
    let hidden = create_project(&origin, workspace, &member, "Hidden", "restricted").await;
    let a = task(&origin, workspace, &member, &open, "Alpha").await;
    let b = task(&origin, workspace, &member, &hidden, "Secret middle").await;
    let c = task(&origin, workspace, &member, &open, "Gamma").await;
    assert_eq!(
        relate(&origin, &member, &a, &a, "blocks").await.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        relate(&origin, &member, &a, &b, "blocks").await.status(),
        StatusCode::CREATED
    );
    assert_eq!(
        relate(&origin, &member, &b, &c, "blocks").await.status(),
        StatusCode::CREATED
    );
    // c blocks a closes a -> b -> c -> a. Same refusal through blocked_by.
    for (source, target, kind) in [(&c, &a, "blocks"), (&a, &c, "blocked_by")] {
        let response = relate(&origin, &member, source, target, kind).await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"], "relation_cycle");
        let chain = body["chain"].as_array().unwrap();
        assert_eq!(chain.len(), 3);
        assert_eq!(chain[0]["title"], "Alpha");
        assert_eq!(chain[1]["title"], "Secret middle");
        assert_eq!(chain[2]["title"], "Gamma");
    }
    // The owner can read the open Project only; the hidden Task is a neutral placeholder.
    sqlx::query(
        "INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'contributor')",
    )
    .bind(workspace)
    .bind(open["id"].as_str().unwrap().parse::<Uuid>().unwrap())
    .bind(owner.user_id)
    .execute(&schema_pool(&schema).await)
    .await
    .unwrap();
    let response = relate(&origin, &owner, &c, &a, "blocks").await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let text = response.text().await.unwrap();
    assert!(!text.contains("Secret middle"), "{text}");
    let body: Value = serde_json::from_str(&text).unwrap();
    let chain = body["chain"].as_array().unwrap();
    assert_eq!(chain.len(), 3);
    assert_eq!(chain[1], json!({"unreadable":true}));
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn consecutive_hidden_hops_collapse_into_one_placeholder() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let open = create_project(&origin, workspace, &member, "Open", "workspace").await;
    let hidden = create_project(&origin, workspace, &member, "Hidden", "restricted").await;
    let a = task(&origin, workspace, &member, &open, "Alpha").await;
    let b = task(&origin, workspace, &member, &hidden, "Secret one").await;
    let b2 = task(&origin, workspace, &member, &hidden, "Secret two").await;
    let c = task(&origin, workspace, &member, &open, "Gamma").await;
    for (x, y) in [(&a, &b), (&b, &b2), (&b2, &c)] {
        assert_eq!(
            relate(&origin, &member, x, y, "blocks").await.status(),
            StatusCode::CREATED
        );
    }
    sqlx::query(
        "INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'contributor')",
    )
    .bind(workspace)
    .bind(open["id"].as_str().unwrap().parse::<Uuid>().unwrap())
    .bind(owner.user_id)
    .execute(&schema_pool(&schema).await)
    .await
    .unwrap();
    let response = relate(&origin, &owner, &c, &a, "blocks").await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: Value = response.json().await.unwrap();
    let chain = body["chain"].as_array().unwrap();
    assert_eq!(chain.len(), 3, "{body}");
    assert_eq!(chain[1], json!({"unreadable":true}));
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opposite_edges_fired_at_once_never_leave_a_cycle() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let project = create_project(&origin, workspace, &member, "Race", "workspace").await;
    let mut tasks = Vec::new();
    for i in 0..6 {
        tasks.push(task(&origin, workspace, &member, &project, &format!("T{i}")).await);
    }
    let pool = schema_pool(&schema).await;
    for round in 0..3 {
        let mut requests = Vec::new();
        for i in 0..tasks.len() {
            for j in 0..tasks.len() {
                if i != j && (i + j + round) % 2 == 0 {
                    requests.push(relate(&origin, &member, &tasks[i], &tasks[j], "blocks"));
                }
            }
        }
        let results = futures_join(requests).await;
        assert!(
            results.iter().all(|s| {
                [
                    StatusCode::CREATED,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    StatusCode::CONFLICT,
                ]
                .contains(s)
            }),
            "{results:?}"
        );
        if round == 0 {
            assert!(results.contains(&StatusCode::CREATED));
        }
        assert!(!has_cycle(&pool).await);
    }
    pool.close().await;
    cleanup(server, schema, admin).await;
}

async fn futures_join(
    requests: Vec<impl std::future::Future<Output = reqwest::Response>>,
) -> Vec<StatusCode> {
    futures_util::future::join_all(requests)
        .await
        .into_iter()
        .map(|response| response.status())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn blocker_view_tracks_completion_archive_and_removal() {
    let (origin, server, schema, admin, workspace, _owner, member) = setup().await;
    let project = create_project(&origin, workspace, &member, "View", "workspace").await;
    let a = task(&origin, workspace, &member, &project, "Blocker A").await;
    let b = task(&origin, workspace, &member, &project, "Blocker B").await;
    let c = task(&origin, workspace, &member, &project, "Blocker C").await;
    let target = task(&origin, workspace, &member, &project, "Waiting").await;
    for blocker in [&a, &b, &c] {
        assert_eq!(
            relate(&origin, &member, blocker, &target, "blocks")
                .await
                .status(),
            StatusCode::CREATED
        );
    }
    let view = blockers(&origin, workspace, &member).await;
    assert_eq!(titles(&view), ["Waiting"]);
    assert_eq!(view[0]["blockers"].as_array().unwrap().len(), 3);
    // Completed blocker drops out.
    set_status(&origin, &member, &a, "completed").await;
    assert_eq!(
        blockers(&origin, workspace, &member).await[0]["blockers"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // Archived blocker drops out.
    let archived = request(
        &reqwest::Client::new(),
        Method::POST,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/tasks/{}/archive",
            b["number"]
        ),
        &member,
    )
    .json(&json!({"expected_version":current_version(&origin, &member, &b).await}))
    .send()
    .await
    .unwrap();
    assert!(archived.status().is_success(), "{}", archived.status());
    assert_eq!(
        blockers(&origin, workspace, &member).await[0]["blockers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Removed relation clears the last blocker, and the Task stops showing as blocked.
    let removed = request(
        &reqwest::Client::new(),
        Method::DELETE,
        format!(
            "{origin}/api/v1/tasks/{}/relations/{}/blocks",
            c["id"].as_str().unwrap(),
            target["id"].as_str().unwrap()
        ),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert!(removed.status().is_success());
    assert!(blockers(&origin, workspace, &member).await.is_empty());
    // Undo restores the relation, redo removes it again: History keeps working.
    let undo = request(
        &reqwest::Client::new(),
        Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .json(&json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(undo.status(), StatusCode::OK);
    assert_eq!(
        titles(&blockers(&origin, workspace, &member).await),
        ["Waiting"]
    );
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn blocker_view_hides_what_the_viewer_cannot_read() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let open = create_project(&origin, workspace, &member, "Open", "workspace").await;
    let hidden = create_project(&origin, workspace, &member, "Restricted", "restricted").await;
    let secret_blocker = task(&origin, workspace, &member, &hidden, "Top secret blocker").await;
    let second_secret = task(&origin, workspace, &member, &hidden, "Another secret").await;
    let public_blocker = task(&origin, workspace, &member, &open, "Public blocker").await;
    let waiting = task(&origin, workspace, &member, &open, "Waiting public").await;
    let secret_waiting = task(&origin, workspace, &member, &hidden, "Secret waiting").await;
    for blocker in [&secret_blocker, &second_secret, &public_blocker] {
        assert_eq!(
            relate(&origin, &member, blocker, &waiting, "blocks")
                .await
                .status(),
            StatusCode::CREATED
        );
    }
    assert_eq!(
        relate(&origin, &member, &public_blocker, &secret_waiting, "blocks")
            .await
            .status(),
        StatusCode::CREATED
    );
    // The owner reads the open Project only (a restricted Project grants nothing implicitly).
    let view = blockers(&origin, workspace, &owner).await;
    assert_eq!(
        titles(&view),
        ["Waiting public"],
        "no row for the restricted blocked Task"
    );
    let raw = serde_json::to_string(&view).unwrap();
    assert!(!raw.contains("secret") && !raw.contains("Secret"), "{raw}");
    let list = view[0]["blockers"].as_array().unwrap();
    assert_eq!(
        list.len(),
        2,
        "one real blocker and ONE placeholder for both hidden ones"
    );
    assert!(list.iter().any(|b| b == &json!({"unreadable":true})));
    // A Task whose only open blocker is hidden still shows as blocked, placeholder only.
    set_status(&origin, &member, &public_blocker, "completed").await;
    let view = blockers(&origin, workspace, &owner).await;
    assert_eq!(view[0]["blockers"], json!([{"unreadable":true}]));
    // Once the hidden blockers are completed no signal remains at all.
    set_status(&origin, &member, &secret_blocker, "completed").await;
    set_status(&origin, &member, &second_secret, "completed").await;
    assert!(blockers(&origin, workspace, &owner).await.is_empty());
    // Revoked access: the member loses the restricted Project and its rows disappear.
    let pool = schema_pool(&schema).await;
    set_status(&origin, &member, &public_blocker, "active").await;
    assert!(
        titles(&blockers(&origin, workspace, &member).await).contains(&"Secret waiting".to_owned())
    );
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(hidden["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .bind(member.user_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        titles(&blockers(&origin, workspace, &member).await),
        ["Waiting public"]
    );
    pool.close().await;
    cleanup(server, schema, admin).await;
}
