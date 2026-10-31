//! Height-style task UX backend: five fixed Status categories, a three-Status seed, manual Task
//! order with one atomic drag-and-drop move, sorting, and persisted column visibility.

use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    cookie: String,
    csrf: String,
}

struct World {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    pool: sqlx::PgPool,
    workspace: Uuid,
    owner: Session,
    member: Session,
    viewer: Session,
    outsider: Session,
}

fn base_url() -> String {
    env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
}

async fn world() -> World {
    let base = base_url();
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("height_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
    let viewer = add_member(&pool, workspace, "viewer@example.com", "viewer").await;
    let outsider = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'outsider@example.com','unused')",
    )
    .bind(outsider)
    .execute(&pool)
    .await
    .unwrap();
    World {
        origin,
        server,
        schema,
        admin,
        workspace,
        owner: session(&pool, owner).await,
        member: session(&pool, member).await,
        viewer: session(&pool, viewer).await,
        outsider: session(&pool, outsider).await,
        pool,
    }
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
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')").bind(Uuid::new_v4()).bind(user).bind(hash).bind(&csrf).execute(pool).await.unwrap();
    Session {
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

impl World {
    async fn call(
        &self,
        method: Method,
        path: &str,
        who: &Session,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = reqwest::Client::new()
            .request(method.clone(), format!("{}/api/v1{path}", self.origin))
            .header(reqwest::header::COOKIE, &who.cookie)
            .header("x-csrf-token", &who.csrf);
        if method != Method::GET {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let bytes = response.bytes().await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn get(&self, path: &str, who: &Session) -> (StatusCode, Value) {
        self.call(Method::GET, path, who, Value::Null).await
    }

    async fn post(&self, path: &str, who: &Session, body: Value) -> (StatusCode, Value) {
        self.call(Method::POST, path, who, body).await
    }

    async fn project(&self) -> Uuid {
        let (code, body) = self
            .post(
                &format!("/workspaces/{}/projects", self.workspace),
                &self.member,
                json!({"name":"Height","visibility":"workspace"}),
            )
            .await;
        assert_eq!(code, StatusCode::CREATED, "{body}");
        body["id"].as_str().unwrap().parse().unwrap()
    }

    async fn task(&self, project: Uuid, title: &str, extra: Value) -> Value {
        let mut payload = json!({"project_id":project,"title":title});
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            payload[key] = value;
        }
        let (code, body) = self
            .post(
                &format!("/workspaces/{}/tasks", self.workspace),
                &self.member,
                payload,
            )
            .await;
        assert_eq!(code, StatusCode::CREATED, "{body}");
        body
    }

    async fn status(&self, name: &str, category: &str) -> Value {
        let (code, body) = self
            .post(
                &format!("/workspaces/{}/statuses", self.workspace),
                &self.owner,
                json!({"name":name,"category":category}),
            )
            .await;
        assert_eq!(code, StatusCode::CREATED, "{body}");
        body
    }

    async fn titles(&self, query: &str) -> Vec<String> {
        let (code, body) = self
            .get(
                &format!("/workspaces/{}/tasks{query}", self.workspace),
                &self.member,
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{body}");
        body["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["title"].as_str().unwrap().to_owned())
            .collect()
    }

    fn move_path(&self, task: &Value) -> String {
        format!(
            "/workspaces/{}/tasks/{}/move",
            self.workspace, task["number"]
        )
    }

    async fn history(&self, task: &Value) -> Vec<Value> {
        let (code, body) = self
            .get(
                &format!("/tasks/{}/history", task["id"].as_str().unwrap()),
                &self.member,
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{body}");
        body["operations"].as_array().unwrap().clone()
    }

    async fn finish(self) {
        self.server.abort();
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn migration_turns_canceled_into_wont_do_and_keeps_existing_data_working() {
    let base = base_url();
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!(
        "height_mig_{}_{}",
        std::process::id(),
        Uuid::new_v4().simple()
    );
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let pool = sqlx::PgPool::connect(&format!("{base}?options=-csearch_path%3D{schema}"))
        .await
        .unwrap();
    // The database as it was before this change: every migration below 0063.
    let all = sqlx::migrate!("./migrations");
    let mut before = sqlx::migrate!("./migrations");
    before.migrations = all
        .migrations
        .iter()
        .filter(|m| m.version < 63)
        .cloned()
        .collect::<Vec<_>>()
        .into();
    before.run(&pool).await.unwrap();

    let user = Uuid::new_v4();
    let workspace = Uuid::new_v4();
    let project = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,'old@example.com','x')")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,'Old')")
        .bind(workspace)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,'P','workspace',$3)")
        .bind(project)
        .bind(workspace)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let old_categories: Vec<(String, String)> = sqlx::query_as(
        "SELECT status_key,category FROM workspace_statuses WHERE workspace_id=$1 ORDER BY position",
    )
    .bind(workspace)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(old_categories.len(), 5, "the old seed has five Statuses");
    assert!(old_categories.contains(&("canceled".into(), "canceled".into())));
    let mut tasks = Vec::new();
    for (number, status) in [(1, "backlog"), (2, "canceled"), (3, "completed")] {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(id)
            .bind(workspace)
            .bind(number)
            .bind(project)
            .bind(format!("old {number}"))
            .bind(status)
            .bind(user)
            .execute(&pool)
            .await
            .unwrap();
        tasks.push(id);
    }
    let group = Uuid::new_v4();
    sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)")
        .bind(group)
        .bind(Uuid::new_v4())
        .bind(workspace)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'status','\"backlog\"','\"canceled\"',2)")
        .bind(Uuid::new_v4())
        .bind(group)
        .bind(tasks[1])
        .execute(&pool)
        .await
        .unwrap();

    // Apply this change's migrations on top.
    all.run(&pool).await.unwrap();

    let after: Vec<(String, String, bool)> = sqlx::query_as(
        "SELECT status_key,category,is_default FROM workspace_statuses WHERE workspace_id=$1 ORDER BY position",
    )
    .bind(workspace)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        after.len(),
        5,
        "no Status is added or dropped for an old Workspace"
    );
    // Keys stay; only the category of `canceled` changes name.
    assert!(after.contains(&("canceled".into(), "wont_do".into(), false)));
    assert!(after.contains(&("backlog".into(), "not_started".into(), true)));
    assert!(after.iter().all(|(_, category, _)| category != "canceled"));
    // Tasks and History keep naming the same Status keys.
    let statuses: Vec<String> =
        sqlx::query_scalar("SELECT status FROM tasks WHERE workspace_id=$1 ORDER BY number")
            .bind(workspace)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(statuses, ["backlog", "canceled", "completed"]);
    let op: Value = sqlx::query_scalar("SELECT after_value FROM task_operations WHERE task_id=$1")
        .bind(tasks[1])
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(op, json!("canceled"));
    // Existing Tasks get a rank in creation order.
    let ranks: Vec<i64> =
        sqlx::query_scalar("SELECT rank FROM tasks WHERE workspace_id=$1 ORDER BY number")
            .bind(workspace)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        ranks.windows(2).all(|w| w[0] < w[1]) && ranks[0] > 0,
        "{ranks:?}"
    );
    // The old category name and a sixth one are refused, and a category never changes.
    assert!(sqlx::query("INSERT INTO workspace_statuses(id,workspace_id,status_key,name,category,position) VALUES(gen_random_uuid(),$1,'x','X','canceled',9)").bind(workspace).execute(&pool).await.is_err());
    assert!(sqlx::query("INSERT INTO workspace_statuses(id,workspace_id,status_key,name,category,position) VALUES(gen_random_uuid(),$1,'y','Y','backlog',9)").bind(workspace).execute(&pool).await.is_err());
    assert!(sqlx::query("UPDATE workspace_statuses SET category='active' WHERE workspace_id=$1 AND status_key='canceled'").bind(workspace).execute(&pool).await.is_err());
    // A Workspace created after the migration gets the three-Status seed.
    let fresh = Uuid::new_v4();
    sqlx::query("INSERT INTO workspaces(id,name) VALUES($1,'Fresh')")
        .bind(fresh)
        .execute(&pool)
        .await
        .unwrap();
    let seeded: Vec<(String, String, String, bool)> = sqlx::query_as("SELECT status_key,name,category,is_default FROM workspace_statuses WHERE workspace_id=$1 ORDER BY position").bind(fresh).fetch_all(&pool).await.unwrap();
    assert_eq!(
        seeded,
        [
            ("todo".into(), "Todo".into(), "not_started".into(), true),
            (
                "active".into(),
                "In progress".into(),
                "active".into(),
                false
            ),
            ("completed".into(), "Done".into(), "completed".into(), false),
        ]
    );
    // A new Task in the old Workspace lands at the end of the line.
    sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,created_by) VALUES($1,$2,4,$3,'new',$4)")
        .bind(Uuid::new_v4())
        .bind(workspace)
        .bind(project)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let last: i64 = sqlx::query_scalar("SELECT rank FROM tasks WHERE workspace_id=$1 AND number=4")
        .bind(workspace)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(last > ranks[2]);
    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn there_are_exactly_five_fixed_categories_and_a_status_never_changes_category() {
    let w = world().await;
    let path = format!("/workspaces/{}/statuses", w.workspace);
    let (code, body) = w.get(&path, &w.member).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    let keys: Vec<&str> = body["categories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        ["not_started", "active", "blocked", "wont_do", "completed"]
    );
    let names: Vec<&str> = body["categories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "Not started",
            "In progress",
            "Blocked",
            "Won't do",
            "Completed"
        ]
    );
    // A sixth category, or the retired `canceled`, cannot be created.
    for category in ["canceled", "backlog", "review", ""] {
        let (code, body) = w
            .post(&path, &w.owner, json!({"name":"Nope","category":category}))
            .await;
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY, "{category}: {body}");
        assert_eq!(body["error"], "invalid_category");
    }
    // Statuses can be added in every one of the five.
    let mut created = Vec::new();
    for category in ["not_started", "active", "blocked", "wont_do", "completed"] {
        created.push(w.status(&format!("Extra {category}"), category).await);
    }
    assert_eq!(created[2]["category"], "blocked");
    assert_eq!(created[3]["category"], "wont_do");
    // Rename and recolor are allowed; the category is not.
    let id = created[2]["id"].as_str().unwrap();
    let (code, body) = w
        .call(
            Method::PATCH,
            &format!("{path}/{id}"),
            &w.owner,
            json!({"name":"Waiting on vendor","color":"#ff8800"}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "Waiting on vendor");
    assert_eq!(body["color"], "#ff8800");
    for category in ["active", "canceled", "nonsense"] {
        let (code, body) = w
            .call(
                Method::PATCH,
                &format!("{path}/{id}"),
                &w.owner,
                json!({"category":category}),
            )
            .await;
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
    let (code, body) = w
        .call(
            Method::PATCH,
            &format!("{path}/{id}"),
            &w.owner,
            json!({"category":"active"}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("category_fixed"))
    );
    // Naming the category it already has is a no-op, not an error.
    let (code, _) = w
        .call(
            Method::PATCH,
            &format!("{path}/{id}"),
            &w.owner,
            json!({"category":"blocked"}),
        )
        .await;
    assert_eq!(code, StatusCode::OK);
    // The database refuses it too, whoever writes the row.
    assert!(
        sqlx::query("UPDATE workspace_statuses SET category='active' WHERE id=$1")
            .bind(id.parse::<Uuid>().unwrap())
            .execute(&w.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE workspace_statuses SET category='canceled' WHERE id=$1")
            .bind(id.parse::<Uuid>().unwrap())
            .execute(&w.pool)
            .await
            .is_err()
    );
    // Reorder across categories.
    let (code, body) = w.get(&path, &w.member).await;
    assert_eq!(code, StatusCode::OK);
    let mut ids: Vec<String> = body["statuses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_owned())
        .collect();
    ids.reverse();
    let (code, body) = w
        .post(
            &format!("{path}/reorder"),
            &w.owner,
            json!({"status_ids":ids}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    // A member cannot manage Statuses.
    let (code, _) = w
        .post(&path, &w.member, json!({"name":"Mine","category":"active"}))
        .await;
    assert_eq!(code, StatusCode::FORBIDDEN);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_workspace_has_three_statuses_and_new_tasks_start_in_the_default() {
    let w = world().await;
    let path = format!("/workspaces/{}/statuses", w.workspace);
    let (_, body) = w.get(&path, &w.member).await;
    let seeded: Vec<(&str, &str, &str, bool)> = body["statuses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["key"].as_str().unwrap(),
                s["name"].as_str().unwrap(),
                s["category"].as_str().unwrap(),
                s["is_default"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        seeded,
        [
            ("todo", "Todo", "not_started", true),
            ("active", "In progress", "active", false),
            ("completed", "Done", "completed", false)
        ]
    );
    let project = w.project().await;
    let first = w.task(project, "first", json!({})).await;
    assert_eq!(first["status"], "todo");
    // The default can move to another not-started Status, and old default may then be archived.
    let backlog = w.status("Backlog", "not_started").await;
    let todo_id = body["statuses"][0]["id"].as_str().unwrap().to_owned();
    let (code, body) = w
        .post(
            &format!("{path}/{todo_id}/archive"),
            &w.owner,
            json!({"replacement_id":backlog["id"]}),
        )
        .await;
    assert_eq!(
        code,
        StatusCode::UNPROCESSABLE_ENTITY,
        "the default cannot be archived: {body}"
    );
    assert_eq!(body["error"], "default_status");
    let (code, body) = w
        .call(
            Method::PATCH,
            &format!("{path}/{}", backlog["id"].as_str().unwrap()),
            &w.owner,
            json!({"is_default":true}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["is_default"], true);
    let second = w.task(project, "second", json!({})).await;
    assert_eq!(second["status"], backlog["key"]);
    // Exactly one default; only a not-started Status can be it.
    let defaults: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workspace_statuses WHERE workspace_id=$1 AND is_default",
    )
    .bind(w.workspace)
    .fetch_one(&w.pool)
    .await
    .unwrap();
    assert_eq!(defaults, 1);
    let (code, body) = w
        .call(
            Method::PATCH,
            &format!("{path}/{todo_id}"),
            &w.owner,
            json!({"is_default":false}),
        )
        .await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let active = w.status("Review", "active").await;
    let (code, body) = w
        .call(
            Method::PATCH,
            &format!("{path}/{}", active["id"].as_str().unwrap()),
            &w.owner,
            json!({"is_default":true}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Some("invalid_default_status")
        )
    );
    let (code, _) = w
        .post(
            &format!("{path}/{todo_id}/archive"),
            &w.owner,
            json!({"replacement_id":backlog["id"]}),
        )
        .await;
    assert_eq!(
        code,
        StatusCode::OK,
        "the old default is free to archive once it is not the default"
    );
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn manual_order_is_the_default_and_a_move_reorders_siblings_without_history() {
    let w = world().await;
    let project = w.project().await;
    let a = w.task(project, "A", json!({})).await;
    let b = w.task(project, "B", json!({})).await;
    let c = w.task(project, "C", json!({})).await;
    assert_eq!(
        w.titles("").await,
        ["A", "B", "C"],
        "new tasks join the end"
    );
    assert!(a["rank"].as_i64().unwrap() < b["rank"].as_i64().unwrap());
    // C before A.
    let (code, moved) = w
        .post(
            &w.move_path(&c),
            &w.member,
            json!({"before_task_id":a["id"]}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{moved}");
    assert_eq!(moved["reordered"], true);
    assert_eq!(moved["status_changed"], false);
    assert!(moved["group_id"].is_null());
    assert_eq!(
        moved["task"]["version"], c["version"],
        "a reorder is not an edit"
    );
    assert_eq!(moved["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(w.titles("").await, ["C", "A", "B"]);
    // A after B, then B to the front by moving A to the end.
    let (code, _) = w
        .post(
            &w.move_path(&a),
            &w.member,
            json!({"after_task_id":b["id"]}),
        )
        .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(w.titles("").await, ["C", "B", "A"]);
    let (code, _) = w
        .post(&w.move_path(&c), &w.member, json!({"to_end":true}))
        .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(w.titles("").await, ["B", "A", "C"]);
    // No Timeline entry and no version bump, however many reorders ran.
    for task in [&a, &b, &c] {
        assert!(
            w.history(task).await.is_empty(),
            "a reorder must not spam the Timeline"
        );
    }
    let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM tasks ORDER BY number")
        .fetch_all(&w.pool)
        .await
        .unwrap();
    assert_eq!(versions, [1, 1, 1]);
    let groups: i64 = sqlx::query_scalar("SELECT count(*) FROM task_operation_groups")
        .fetch_one(&w.pool)
        .await
        .unwrap();
    assert_eq!(groups, 0);
    // Refusals.
    let (code, body) = w.post(&w.move_path(&a), &w.member, json!({})).await;
    assert_eq!(
        (code, body["error"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("empty_move"))
    );
    let (code, body) = w
        .post(
            &w.move_path(&a),
            &w.member,
            json!({"before_task_id":b["id"],"to_end":true}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_position"))
    );
    let (code, body) = w
        .post(
            &w.move_path(&a),
            &w.member,
            json!({"before_task_id":a["id"]}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_position"))
    );
    let (code, body) = w
        .post(
            &w.move_path(&a),
            &w.member,
            json!({"before_task_id":Uuid::new_v4()}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Some("anchor_not_in_scope")
        )
    );
    let (code, _) = w
        .post(
            &format!("/workspaces/{}/tasks/999/move", w.workspace),
            &w.member,
            json!({"to_end":true}),
        )
        .await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    // A stale expected_version is a conflict and moves nothing.
    let (code, body) = w
        .post(
            &w.move_path(&a),
            &w.member,
            json!({"expected_version":9,"to_end":true}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("version_conflict"))
    );
    assert_eq!(w.titles("").await, ["B", "A", "C"]);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn subtasks_reorder_among_siblings_only() {
    let w = world().await;
    let project = w.project().await;
    let parent = w.task(project, "parent", json!({})).await;
    let other = w.task(project, "other parent", json!({})).await;
    let s1 = w
        .task(project, "s1", json!({"parent_task_id":parent["id"]}))
        .await;
    let s2 = w
        .task(project, "s2", json!({"parent_task_id":parent["id"]}))
        .await;
    let s3 = w
        .task(project, "s3", json!({"parent_task_id":parent["id"]}))
        .await;
    let foreign = w
        .task(project, "foreign", json!({"parent_task_id":other["id"]}))
        .await;
    let (code, _) = w
        .post(
            &w.move_path(&s3),
            &w.member,
            json!({"before_task_id":s1["id"]}),
        )
        .await;
    assert_eq!(code, StatusCode::OK);
    let (_, read) = w
        .get(
            &format!("/workspaces/{}/tasks/{}", w.workspace, parent["number"]),
            &w.member,
        )
        .await;
    let order: Vec<&str> = read["subtasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["title"].as_str().unwrap())
        .collect();
    // The detail read lists subtasks by number; the list endpoint shows the manual order.
    assert_eq!(order.len(), 3);
    let titles = w.titles(&format!("?project_id={project}")).await;
    let position = |t: &str| titles.iter().position(|x| x == t).unwrap();
    assert!(
        position("s3") < position("s1") && position("s1") < position("s2"),
        "{titles:?}"
    );
    // A sibling of another parent, or a top-level Task, is not a valid anchor.
    for anchor in [&foreign, &parent] {
        let (code, body) = w
            .post(
                &w.move_path(&s2),
                &w.member,
                json!({"after_task_id":anchor["id"]}),
            )
            .await;
        assert_eq!(
            (code, body["error"].as_str()),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Some("anchor_not_in_scope")
            ),
            "{body}"
        );
    }
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cross_status_move_is_one_atomic_edit_with_history_and_undo() {
    let w = world().await;
    let project = w.project().await;
    let a = w.task(project, "A", json!({})).await;
    let b = w.task(project, "B", json!({})).await;
    let _x = w.task(project, "X", json!({"status":"active"})).await;
    let y = w.task(project, "Y", json!({"status":"active"})).await;
    // B into In progress, between X and Y.
    let (code, moved) = w
        .post(
            &w.move_path(&b),
            &w.member,
            json!({"expected_version":1,"status":"active","before_task_id":y["id"]}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{moved}");
    assert_eq!(moved["task"]["status"], "active");
    assert_eq!(moved["status_changed"], true);
    assert_eq!(moved["reordered"], true);
    assert_eq!(moved["task"]["version"], 2);
    assert!(moved["group_id"].is_string());
    assert_eq!(w.titles("?status=active").await, ["X", "B", "Y"]);
    assert_eq!(w.titles("?status=todo").await, ["A"]);
    // The status change is an effective edit in History, written once.
    let history = w.history(&b).await;
    assert_eq!(history.len(), 1, "{history:?}");
    assert_eq!(history[0]["field"], "status");
    assert_eq!(history[0]["before"], "todo");
    assert_eq!(history[0]["after"], "active");
    // Undo restores the Status (the order inside the bucket is not part of the edit).
    let (code, body) = w
        .post(
            &format!("/workspaces/{}/history/undo", w.workspace),
            &w.member,
            json!({}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(w.titles("?status=todo").await.len(), 2);
    let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id=$1")
        .bind(b["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(&w.pool)
        .await
        .unwrap();
    assert_eq!(status, "todo");
    let (code, body) = w
        .post(
            &format!("/workspaces/{}/history/redo", w.workspace),
            &w.member,
            json!({}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id=$1")
        .bind(b["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(&w.pool)
        .await
        .unwrap();
    assert_eq!(status, "active");
    // Moving into Done stamps completed_at, and Undo clears it again.
    let (code, done) = w
        .post(
            &w.move_path(&a),
            &w.member,
            json!({"status":"completed","to_end":true}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{done}");
    assert!(done["task"]["completed_at"].is_string());
    let (code, _) = w
        .post(
            &format!("/workspaces/{}/history/undo", w.workspace),
            &w.member,
            json!({}),
        )
        .await;
    assert_eq!(code, StatusCode::OK);
    let completed_at: Option<String> =
        sqlx::query_scalar("SELECT completed_at::text FROM tasks WHERE id=$1")
            .bind(a["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .fetch_one(&w.pool)
            .await
            .unwrap();
    assert!(completed_at.is_none());
    // A status-only move (no position) records the edit and leaves the rank alone.
    let before: i64 = sqlx::query_scalar("SELECT rank FROM tasks WHERE id=$1")
        .bind(a["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(&w.pool)
        .await
        .unwrap();
    let (code, body) = w
        .post(&w.move_path(&a), &w.member, json!({"status":"active"}))
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["reordered"], false);
    let after: i64 = sqlx::query_scalar("SELECT rank FROM tasks WHERE id=$1")
        .bind(a["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(&w.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    w.finish().await;
}

async fn snapshot(w: &World, number: i64) -> ((String, i64, i64), i64) {
    let row: (String, i64, i64) =
        sqlx::query_as("SELECT status,rank,version FROM tasks WHERE number=$1")
            .bind(number)
            .fetch_one(&w.pool)
            .await
            .unwrap();
    let groups: i64 = sqlx::query_scalar("SELECT count(*) FROM task_operation_groups")
        .fetch_one(&w.pool)
        .await
        .unwrap();
    (row, groups)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_move_changes_neither_status_nor_position() {
    let w = world().await;
    let project = w.project().await;
    let a = w.task(project, "A", json!({})).await;
    let b = w.task(project, "B", json!({})).await;
    let archived = w.status("Old", "active").await;
    let number = a["number"].as_i64().unwrap();
    let initial = snapshot(&w, number).await;
    // Valid status, bad anchor: nothing is applied.
    let (code, _) = w
        .post(
            &w.move_path(&a),
            &w.member,
            json!({"status":"active","before_task_id":Uuid::new_v4()}),
        )
        .await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        snapshot(&w, number).await,
        initial,
        "status must roll back with the refused position"
    );
    // Valid position, unknown status.
    let (code, body) = w
        .post(
            &w.move_path(&a),
            &w.member,
            json!({"status":"nope","after_task_id":b["id"]}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_status"))
    );
    assert_eq!(snapshot(&w, number).await, initial);
    // Valid position, archived status.
    let (code, _) = w
        .post(
            &format!(
                "/workspaces/{}/statuses/{}/archive",
                w.workspace,
                archived["id"].as_str().unwrap()
            ),
            &w.owner,
            json!({}),
        )
        .await;
    assert_eq!(code, StatusCode::OK);
    let (code, _) = w
        .post(
            &w.move_path(&a),
            &w.member,
            json!({"status":archived["key"],"after_task_id":b["id"]}),
        )
        .await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(snapshot(&w, number).await, initial);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn moves_respect_permissions() {
    let w = world().await;
    let project = w.project().await;
    let a = w.task(project, "A", json!({})).await;
    let b = w.task(project, "B", json!({})).await;
    // A viewer reads the Project but may not write: refused, nothing changes.
    let (code, body) = w
        .post(
            &w.move_path(&a),
            &w.viewer,
            json!({"status":"active","after_task_id":b["id"]}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (StatusCode::FORBIDDEN, Some("forbidden"))
    );
    // Someone outside the Workspace cannot even tell the Task exists.
    let (code, _) = w
        .post(&w.move_path(&a), &w.outsider, json!({"to_end":true}))
        .await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    // A restricted Project hides the Task from a workspace member with no membership.
    let restricted = w
        .post(
            &format!("/workspaces/{}/projects", w.workspace),
            &w.owner,
            json!({"name":"Secret","visibility":"restricted"}),
        )
        .await
        .1;
    let hidden = {
        let (code, body) = w
            .post(
                &format!("/workspaces/{}/tasks", w.workspace),
                &w.owner,
                json!({"project_id":restricted["id"],"title":"hidden"}),
            )
            .await;
        assert_eq!(code, StatusCode::CREATED, "{body}");
        body
    };
    let (code, _) = w
        .post(&w.move_path(&hidden), &w.member, json!({"to_end":true}))
        .await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    let state: (String, i64) = sqlx::query_as("SELECT status,version FROM tasks WHERE number=$1")
        .bind(a["number"].as_i64().unwrap())
        .fetch_one(&w.pool)
        .await
        .unwrap();
    assert_eq!(state, ("todo".to_owned(), 1));
    // Unauthenticated.
    let response = reqwest::Client::new()
        .post(format!("{}/api/v1{}", w.origin, w.move_path(&a)))
        .json(&json!({"to_end":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn renumbering_keeps_the_order_when_a_gap_closes() {
    let w = world().await;
    let project = w.project().await;
    let first = w.task(project, "first", json!({})).await;
    let last = w.task(project, "last", json!({})).await;
    // Each new task is dropped right after `first`, halving the gap again and again.
    let mut expected = vec!["last".to_owned()];
    for n in 0..30 {
        let title = format!("t{n}");
        let task = w.task(project, &title, json!({})).await;
        let (code, body) = w
            .post(
                &w.move_path(&task),
                &w.member,
                json!({"after_task_id":first["id"]}),
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{body}");
        expected.insert(0, title);
    }
    expected.insert(0, "first".to_owned());
    assert_eq!(w.titles("").await, expected);
    let ranks: Vec<i64> = sqlx::query_scalar("SELECT rank FROM tasks ORDER BY rank,number")
        .fetch_all(&w.pool)
        .await
        .unwrap();
    assert!(
        ranks.windows(2).all(|p| p[0] < p[1]),
        "ranks stay distinct: {ranks:?}"
    );
    let _ = last;
    w.finish().await;
}

async fn read_list(w: &World, list: &Value) -> Vec<String> {
    let (code, body) = w
        .get(
            &format!(
                "/workspaces/{}/lists/{}",
                w.workspace,
                list["id"].as_str().unwrap()
            ),
            &w.member,
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manual_list_keeps_its_own_order() {
    let w = world().await;
    let project = w.project().await;
    let a = w.task(project, "A", json!({})).await;
    let b = w.task(project, "B", json!({})).await;
    let c = w.task(project, "C", json!({})).await;
    let (code, list) = w
        .post(
            &format!("/workspaces/{}/lists", w.workspace),
            &w.member,
            json!({"name":"Pick","kind":"manual","query":{"filters":[],"logic":"and","sort":[],"columns":["title","due_date"]}}),
        )
        .await;
    assert_eq!(code, StatusCode::CREATED, "{list}");
    assert_eq!(list["query"]["columns"], json!(["title", "due_date"]));
    for task in [&a, &b, &c] {
        let (code, body) = w
            .post(
                &format!("/lists/{}/tasks", list["id"].as_str().unwrap()),
                &w.member,
                json!({"task_id":task["id"]}),
            )
            .await;
        assert!(code.is_success(), "{body}");
    }
    assert_eq!(read_list(&w, &list).await, ["A", "B", "C"]);
    let (code, body) = w
        .post(
            &w.move_path(&c),
            &w.member,
            json!({"list_id":list["id"],"before_task_id":a["id"]}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(read_list(&w, &list).await, ["C", "A", "B"]);
    // The Project order is untouched by a List reorder.
    assert_eq!(w.titles("").await, ["A", "B", "C"]);
    // Moving a Task that is not a member is refused.
    let d = w.task(project, "D", json!({})).await;
    let (code, body) = w
        .post(
            &w.move_path(&d),
            &w.member,
            json!({"list_id":list["id"],"to_end":true}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("not_in_list"))
    );
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn list_endpoints_sort_by_built_in_columns_and_attributes_with_a_direction() {
    let w = world().await;
    let project = w.project().await;
    let mut tasks = Vec::new();
    for (title, priority, due) in [
        ("beta", "low", "2026-03-02"),
        ("alpha", "urgent", "2026-03-01"),
        ("gamma", "high", "2026-03-03"),
    ] {
        tasks.push(
            w.task(project, title, json!({"priority":priority,"due_date":due}))
                .await,
        );
    }
    w.task(project, "no date", json!({})).await;
    assert_eq!(
        w.titles("?sort=title").await,
        ["alpha", "beta", "gamma", "no date"]
    );
    assert_eq!(
        w.titles("?sort=title&direction=desc").await,
        ["no date", "gamma", "beta", "alpha"]
    );
    assert_eq!(
        w.titles("?sort=due_date").await,
        ["alpha", "beta", "gamma", "no date"]
    );
    assert_eq!(
        w.titles("?sort=due_date&direction=desc").await,
        ["gamma", "beta", "alpha", "no date"],
        "empty dates sort last either way"
    );
    assert_eq!(w.titles("?sort=priority&direction=desc").await[0], "alpha");
    assert_eq!(w.titles("?sort=number&direction=desc").await[0], "no date");
    assert_eq!(
        w.titles("?sort=created_at&direction=desc").await[0],
        "no date"
    );
    assert_eq!(
        w.titles("?sort=manual").await,
        ["beta", "alpha", "gamma", "no date"]
    );
    // Status sorts by the Workspace's status order, not by key.
    w.post(
        &w.move_path(&tasks[0]),
        &w.member,
        json!({"status":"completed"}),
    )
    .await;
    assert_eq!(w.titles("?sort=status&direction=desc").await[0], "beta");
    // A numeric custom attribute sorts as a number.
    let (code, attribute) = w
        .post(
            &format!("/workspaces/{}/attributes", w.workspace),
            &w.owner,
            json!({"name":"Points","value_type":"number","project_ids":[project]}),
        )
        .await;
    assert_eq!(code, StatusCode::CREATED, "{attribute}");
    for (task, value) in tasks.iter().zip([9, 100, 20]) {
        let (code, body) = w
            .call(
                Method::PATCH,
                &format!("/tasks/{}/attributes", task["id"].as_str().unwrap()),
                &w.member,
                json!({"values":[{"attribute_id":attribute["id"],"value":value}]}),
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{body}");
    }
    let id = attribute["id"].as_str().unwrap();
    assert_eq!(
        w.titles(&format!("?sort=attribute/{id}")).await,
        ["beta", "gamma", "alpha", "no date"]
    );
    assert_eq!(
        w.titles(&format!("?sort=attribute:{id}&direction=desc"))
            .await,
        ["alpha", "gamma", "beta", "no date"]
    );
    // Unknown input is refused, not ignored.
    for query in [
        "?sort=password",
        "?sort=attribute/not-a-uuid",
        "?sort=title&direction=sideways",
    ] {
        let (code, body) = w
            .get(
                &format!("/workspaces/{}/tasks{query}", w.workspace),
                &w.member,
            )
            .await;
        assert_eq!(
            (code, body["error"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_sort")),
            "{query}"
        );
    }
    // Saved views take the same new sort fields.
    let (code, body) = w
        .post(
            &format!("/workspaces/{}/lists", w.workspace),
            &w.member,
            json!({"name":"Newest","kind":"smart","query":{"filters":[],"logic":"and","sort":[{"field":"created_at","direction":"desc"}],"columns":["title","created_at"]}}),
        )
        .await;
    assert_eq!(code, StatusCode::CREATED, "{body}");
    let (code, read) = w
        .get(
            &format!(
                "/workspaces/{}/lists/{}",
                w.workspace,
                body["id"].as_str().unwrap()
            ),
            &w.member,
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{read}");
    assert_eq!(read["tasks"][0]["title"], "no date");
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn attributes_cover_all_six_types_and_column_visibility_is_stored() {
    let w = world().await;
    let project = w.project().await;
    let path = format!("/workspaces/{}/attributes", w.workspace);
    let mut ids = Vec::new();
    for (name, kind, options) in [
        ("Notes", "text", json!(null)),
        ("Points", "number", json!(null)),
        ("Sprint", "date", json!(null)),
        ("Size", "single_select", json!(["S", "M", "L"])),
        ("Labels", "multi_select", json!(["a", "b"])),
        ("Reviewer", "user", json!(null)),
    ] {
        let mut payload = json!({"name":name,"value_type":kind,"project_ids":[project]});
        if !options.is_null() {
            payload["options"] = options;
        }
        let (code, body) = w.post(&path, &w.owner, payload).await;
        assert_eq!(code, StatusCode::CREATED, "{kind}: {body}");
        ids.push(body["id"].as_str().unwrap().to_owned());
    }
    let (code, _) = w
        .post(&path, &w.owner, json!({"name":"Bad","value_type":"rating"}))
        .await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
    let (_, listed) = w.get(&path, &w.member).await;
    let types: Vec<&str> = listed["attributes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        [
            "text",
            "number",
            "date",
            "single_select",
            "multi_select",
            "user"
        ]
    );
    // A date attribute ("Sprint") takes a date value.
    let task = w.task(project, "in sprint", json!({})).await;
    let (code, body) = w
        .call(
            Method::PATCH,
            &format!("/tasks/{}/attributes", task["id"].as_str().unwrap()),
            &w.member,
            json!({"values":[{"attribute_id":ids[2],"value":"2026-06-01"}]}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");

    // Per-person visible columns of a Project view.
    let view = format!("/projects/{project}/view-settings");
    let (code, body) = w.get(&view, &w.member).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["stored"], false);
    assert_eq!(body["settings"]["sort"], "manual");
    let columns = json!([
        "title",
        "status",
        format!("attribute:{}", ids[2]),
        format!("attribute:{}", ids[1])
    ]);
    let (code, body) = w
        .call(
            Method::PUT,
            &view,
            &w.member,
            json!({"columns":columns,"sort":format!("attribute:{}", ids[2]),"direction":"desc","group_by":"status"}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    let (_, body) = w.get(&view, &w.member).await;
    assert_eq!(body["stored"], true);
    assert_eq!(body["settings"]["columns"], columns);
    assert_eq!(body["settings"]["direction"], "desc");
    // Another person has their own settings; a viewer may keep theirs too.
    let (_, other) = w.get(&view, &w.owner).await;
    assert_eq!(other["stored"], false);
    let (code, _) = w
        .call(Method::PUT, &view, &w.viewer, json!({"columns":["title"]}))
        .await;
    assert_eq!(code, StatusCode::OK);
    // Refusals: unknown column, empty, bad sort, no access.
    for bad in [
        json!({"columns":["title","password"]}),
        json!({"columns":[]}),
        json!({"columns":["title"],"sort":"nope"}),
        json!({"columns":["title"],"direction":"up"}),
    ] {
        let (code, body) = w.call(Method::PUT, &view, &w.member, bad).await;
        assert_eq!(
            (code, body["error"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_settings"))
        );
    }
    let (code, _) = w.get(&view, &w.outsider).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    // A saved List stores its visible columns and refuses unknown ones.
    let (code, body) = w
        .post(
            &format!("/workspaces/{}/lists", w.workspace),
            &w.member,
            json!({"name":"Cols","kind":"smart","query":{"filters":[],"logic":"and","sort":[],"columns":["title",format!("attribute:{}", ids[0])]}}),
        )
        .await;
    assert_eq!(code, StatusCode::CREATED, "{body}");
    let list_path = format!(
        "/workspaces/{}/lists/{}",
        w.workspace,
        body["id"].as_str().unwrap()
    );
    let (code, patched) = w
        .call(
            Method::PATCH,
            &list_path,
            &w.member,
            json!({"query":{"filters":[],"logic":"and","sort":[],"columns":["title","due_date"]}}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{patched}");
    let (_, read) = w.get(&list_path, &w.member).await;
    assert_eq!(read["query"]["columns"], json!(["title", "due_date"]));
    let (code, body) = w
        .call(
            Method::PATCH,
            &list_path,
            &w.member,
            json!({"query":{"filters":[],"logic":"and","sort":[],"columns":["title","secret"]}}),
        )
        .await;
    assert_eq!(
        (code, body["error"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_query"))
    );
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn wont_do_tasks_are_closed_and_blocked_tasks_stay_open() {
    let w = world().await;
    let project = w.project().await;
    let wont = w.status("Dropped", "wont_do").await;
    let blocked = w.status("Waiting", "blocked").await;
    let yesterday: String = sqlx::query_scalar("SELECT (current_date-1)::text")
        .fetch_one(&w.pool)
        .await
        .unwrap();
    w.task(
        project,
        "dropped",
        json!({"status":wont["key"],"due_date":yesterday}),
    )
    .await;
    w.task(
        project,
        "waiting",
        json!({"status":blocked["key"],"due_date":yesterday}),
    )
    .await;
    let (code, overview) = w
        .get(&format!("/projects/{project}/overview"), &w.member)
        .await;
    assert_eq!(code, StatusCode::OK, "{overview}");
    let text = overview.to_string();
    assert!(
        text.contains("waiting"),
        "a Blocked Status is still open work: {text}"
    );
    assert!(
        !text.contains("dropped"),
        "a Won't do task is never overdue: {text}"
    );
    w.finish().await;
}
