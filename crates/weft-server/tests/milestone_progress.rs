use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    user: Uuid,
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
    outsider: Session,
}

async fn world() -> World {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!(
        "milestone_progress_{}_{}",
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
    // A new Workspace seeds three Statuses; these tests need a Won't do one too.
    sqlx::query("INSERT INTO workspace_statuses(id,workspace_id,status_key,name,category,position) VALUES(gen_random_uuid(),$1,'wont_do','Won''t do','wont_do',3)")
        .bind(workspace)
        .execute(&pool)
        .await
        .unwrap();
    let member = add_member(&pool, workspace, "member@example.com").await;
    let outsider = add_member(&pool, workspace, "outsider@example.com").await;
    World {
        origin,
        server,
        schema,
        admin,
        workspace,
        owner: session(&pool, owner).await,
        member: session(&pool, member).await,
        outsider: session(&pool, outsider).await,
        pool,
    }
}

async fn add_member(pool: &sqlx::PgPool, workspace: Uuid, email: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(id)
        .bind(email)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(id)
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

impl World {
    async fn call(
        &self,
        method: Method,
        path: &str,
        who: &Session,
        body: Value,
    ) -> (StatusCode, Value) {
        let response = reqwest::Client::new()
            .request(method, format!("{}/api/v1{path}", self.origin))
            .header(reqwest::header::COOKIE, &who.cookie)
            .header("x-csrf-token", &who.csrf)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn project(&self, name: &str, visibility: &str) -> Uuid {
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/workspaces/{}/projects", self.workspace),
                &self.owner,
                json!({"name":name,"visibility":visibility}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        body["id"].as_str().unwrap().parse().unwrap()
    }

    async fn grant(&self, project: Uuid, who: &Session, role: &str) {
        let (status, _) = self
            .call(
                Method::POST,
                &format!("/projects/{project}/members"),
                &self.owner,
                json!({"user_id":who.user,"role":role}),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    async fn milestone(&self, project: Uuid, name: &str) -> Value {
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/projects/{project}/milestones"),
                &self.owner,
                json!({"name":name,"target_date":"2026-12-01"}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body
    }

    async fn assign(&self, task: &Value, who: &Session, milestone: Value) -> (StatusCode, Value) {
        self.call(
            Method::PATCH,
            &format!("/tasks/{}", task["id"].as_str().unwrap()),
            who,
            json!({"expected_version":task["version"],"milestone_id":milestone}),
        )
        .await
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

impl World {
    /// Creates a Task in `milestone` with `status`, optionally under `parent`.
    async fn work(
        &self,
        project: Uuid,
        parent: Option<&Value>,
        milestone: Option<&Value>,
        status: &str,
    ) -> Value {
        let (code, body) = self
            .call(
                Method::POST,
                &format!("/workspaces/{}/tasks", self.workspace),
                &self.owner,
                json!({"project_id":project,"title":"Work","status":status,"parent_task_id":parent.map(|p| p["id"].clone())}),
            )
            .await;
        assert_eq!(code, StatusCode::CREATED, "{body}");
        match milestone {
            Some(m) => {
                let (code, body) = self.assign(&body, &self.owner, m["id"].clone()).await;
                assert_eq!(code, StatusCode::OK, "{body}");
                body
            }
            None => body,
        }
    }

    async fn set_status(&self, task: &Value, status: &str) -> Value {
        let (code, body) = self
            .call(
                Method::PATCH,
                &format!("/tasks/{}", task["id"].as_str().unwrap()),
                &self.owner,
                json!({"expected_version":task["version"],"status":status}),
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{body}");
        body
    }

    async fn progress(&self, milestone: &Value, who: &Session) -> Value {
        let (code, body) = self
            .call(
                Method::GET,
                &format!("/milestones/{}", milestone["id"].as_str().unwrap()),
                who,
                Value::Null,
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{body}");
        body["progress"].clone()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_counts_completed_leaves_not_parents_archived_or_wont_do() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let m = w.milestone(project, "Beta").await;
    // A parent with two subtasks: only the subtasks count, never the parent.
    let parent = w.work(project, None, Some(&m), "active").await;
    let done_child = w.work(project, Some(&parent), Some(&m), "completed").await;
    w.work(project, Some(&parent), Some(&m), "active").await;
    // A nested parent: grandchild counts, its parent does not.
    let nested = w.work(project, Some(&parent), Some(&m), "completed").await;
    w.work(project, Some(&nested), Some(&m), "todo").await;
    // A lone completed leaf.
    w.work(project, None, Some(&m), "completed").await;
    // Canceled and archived Tasks never count.
    w.work(project, None, Some(&m), "wont_do").await;
    let gone = w.work(project, None, Some(&m), "completed").await;
    let (code, _) = w
        .call(
            Method::POST,
            &format!(
                "/workspaces/{}/tasks/{}/archive",
                w.workspace,
                gone["number"].as_i64().unwrap()
            ),
            &w.owner,
            json!({"expected_version":gone["version"]}),
        )
        .await;
    assert!(code.is_success(), "archive failed: {code}");
    let _ = done_child;
    let progress = w.progress(&m, &w.owner).await;
    // Leaves: done_child(c), active child, grandchild(backlog), lone(c) => 2 of 4.
    assert_eq!(progress["completed"], 2, "{progress}");
    assert_eq!(progress["total"], 4, "{progress}");
    assert_eq!(progress["percent"], 50);
    assert_eq!(progress["status"], "in_progress");
    assert_eq!(progress["ready_to_confirm"], false);
    let (_, list) = w
        .call(
            Method::GET,
            &format!("/projects/{project}/milestones"),
            &w.owner,
            Value::Null,
        )
        .await;
    assert_eq!(list["milestones"][0]["progress"], progress);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_milestone_says_no_work_yet_never_one_hundred_percent() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let m = w.milestone(project, "Empty").await;
    let progress = w.progress(&m, &w.owner).await;
    assert_eq!(progress["status"], "no_work_yet");
    assert_eq!(progress["total"], 0);
    assert!(progress["percent"].is_null());
    assert_eq!(progress["ready_to_confirm"], false);
    // Only wont_do work is still "no work yet".
    w.work(project, None, Some(&m), "wont_do").await;
    let progress = w.progress(&m, &w.owner).await;
    assert_eq!(progress["status"], "no_work_yet");
    assert!(progress["percent"].is_null());
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ready_to_confirm_is_for_managers_and_the_milestone_never_completes_itself() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    w.grant(project, &w.member, "contributor").await;
    let m = w.milestone(project, "Beta").await;
    let a = w.work(project, None, Some(&m), "active").await;
    let b = w.work(project, None, Some(&m), "completed").await;
    let _ = b;
    // Not everything done: confirmation is refused.
    let (code, body) = w
        .call(
            Method::POST,
            &format!("/milestones/{}/confirm-delivery", m["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":1}),
        )
        .await;
    assert_eq!(code, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "not_ready");
    w.set_status(&a, "completed").await;
    let manager_view = w.progress(&m, &w.owner).await;
    assert_eq!(manager_view["status"], "all_completed");
    assert_eq!(manager_view["percent"], 100);
    assert_eq!(manager_view["ready_to_confirm"], true);
    // A contributor sees the numbers but no confirmation hint.
    let member_view = w.progress(&m, &w.member).await;
    assert_eq!(member_view["percent"], 100);
    assert_eq!(member_view["ready_to_confirm"], false);
    // The Milestone stays in its state.
    let (_, current) = w
        .call(
            Method::GET,
            &format!("/milestones/{}", m["id"].as_str().unwrap()),
            &w.owner,
            Value::Null,
        )
        .await;
    assert_eq!(current["state"], "planned");
    // A contributor cannot confirm.
    let (code, _) = w
        .call(
            Method::POST,
            &format!("/milestones/{}/confirm-delivery", m["id"].as_str().unwrap()),
            &w.member,
            json!({"expected_version":1}),
        )
        .await;
    assert_eq!(code, StatusCode::FORBIDDEN);
    // A Manager confirms; the hint goes away and Completed can be undone.
    let (code, done) = w
        .call(
            Method::POST,
            &format!("/milestones/{}/confirm-delivery", m["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":1}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{done}");
    assert_eq!(done["state"], "completed");
    assert_eq!(done["progress"]["ready_to_confirm"], false);
    let (code, stale) = w
        .call(
            Method::POST,
            &format!("/milestones/{}/undo-delivery", m["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":1}),
        )
        .await;
    assert_eq!(code, StatusCode::CONFLICT, "{stale}");
    let (code, back) = w
        .call(
            Method::POST,
            &format!("/milestones/{}/undo-delivery", m["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":done["version"]}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{back}");
    assert_eq!(back["state"], "planned");
    assert_eq!(back["progress"]["ready_to_confirm"], true);
    // Undo only applies to a delivery confirmation.
    let (code, _) = w
        .call(
            Method::POST,
            &format!("/milestones/{}/undo-delivery", m["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":back["version"]}),
        )
        .await;
    assert_eq!(code, StatusCode::CONFLICT);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_follows_project_access_and_leaks_nothing_to_outsiders() {
    let w = world().await;
    let project = w.project("Secret", "restricted").await;
    w.grant(project, &w.member, "viewer").await;
    let m = w.milestone(project, "Hidden launch").await;
    w.work(project, None, Some(&m), "completed").await;
    w.work(project, None, Some(&m), "active").await;
    let seen = w.progress(&m, &w.member).await;
    assert_eq!(seen["total"], 2);
    assert_eq!(seen["ready_to_confirm"], false);
    for (method, path, body) in [
        (
            Method::GET,
            format!("/milestones/{}", m["id"].as_str().unwrap()),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/projects/{project}/milestones"),
            Value::Null,
        ),
        (
            Method::POST,
            format!("/milestones/{}/confirm-delivery", m["id"].as_str().unwrap()),
            json!({"expected_version":1}),
        ),
        (
            Method::POST,
            format!("/milestones/{}/undo-delivery", m["id"].as_str().unwrap()),
            json!({"expected_version":1}),
        ),
    ] {
        let (code, text) = w.call(method, &path, &w.outsider, body).await;
        assert_eq!(code, StatusCode::NOT_FOUND, "{path}");
        assert!(!text.to_string().contains("Hidden launch"));
    }
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_status_change_reaches_the_realtime_outbox_for_progress() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let m = w.milestone(project, "Beta").await;
    let task = w.work(project, None, Some(&m), "active").await;
    sqlx::query("DELETE FROM realtime_outbox")
        .execute(&w.pool)
        .await
        .unwrap();
    w.set_status(&task, "completed").await;
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM realtime_outbox WHERE project_id=$1 AND entity_type='task'",
    )
    .bind(project)
    .fetch_one(&w.pool)
    .await
    .unwrap();
    assert!(
        rows >= 1,
        "status change must emit a Project-scoped Task event"
    );
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_parent_is_never_a_leaf_even_when_its_subtasks_sit_outside_the_milestone() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let m = w.milestone(project, "Beta").await;
    // Subtask in no Milestone: the parent still is not a leaf.
    let parent = w.work(project, None, Some(&m), "completed").await;
    w.work(project, Some(&parent), None, "active").await;
    // Parent whose only subtask is Canceled: still not a leaf.
    let other = w.work(project, None, Some(&m), "completed").await;
    w.work(project, Some(&other), Some(&m), "wont_do").await;
    let progress = w.progress(&m, &w.owner).await;
    assert_eq!(progress["total"], 0, "{progress}");
    assert_eq!(progress["status"], "no_work_yet", "{progress}");
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_completed_milestone_refuses_new_tasks_with_409() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let m = w.milestone(project, "Beta").await;
    w.work(project, None, Some(&m), "completed").await;
    let (code, confirmed) = w
        .call(
            Method::POST,
            &format!("/milestones/{}/confirm-delivery", m["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":m["version"]}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{confirmed}");
    let manual = w.milestone(project, "Manual").await;
    let (code, _) = w
        .call(
            Method::PATCH,
            &format!("/milestones/{}", manual["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":manual["version"],"state":"completed"}),
        )
        .await;
    assert_eq!(code, StatusCode::OK);
    let (_, list) = w
        .call(
            Method::GET,
            &format!("/projects/{project}/milestones"),
            &w.owner,
            Value::Null,
        )
        .await;
    for item in list["milestones"].as_array().unwrap() {
        // Undo is offered only after a delivery confirmation, not a manual state edit.
        assert_eq!(item["can_undo_delivery"], item["id"] == m["id"], "{item}");
    }
    let task = w.work(project, None, None, "todo").await;
    let (code, body) = w.assign(&task, &w.owner, m["id"].clone()).await;
    assert_eq!(code, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "milestone_completed");
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn confirming_delivery_waits_for_a_task_being_changed() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let m = w.milestone(project, "Beta").await;
    let task = w.work(project, None, Some(&m), "completed").await;
    // A concurrent writer holds the Task row.
    let mut tx = w.pool.begin().await.unwrap();
    sqlx::query("UPDATE tasks SET status='active' WHERE id=$1")
        .bind(task["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    let url = format!(
        "{}/api/v1/milestones/{}/confirm-delivery",
        w.origin,
        m["id"].as_str().unwrap()
    );
    let (cookie, csrf, version) = (
        w.owner.cookie.clone(),
        w.owner.csrf.clone(),
        m["version"].clone(),
    );
    let mut call = tokio::spawn(async move {
        let response = reqwest::Client::new()
            .post(url)
            .header(reqwest::header::COOKIE, cookie)
            .header("x-csrf-token", csrf)
            .json(&json!({"expected_version":version}))
            .send()
            .await
            .unwrap();
        let status = response.status();
        (
            status,
            response.json::<Value>().await.unwrap_or(Value::Null),
        )
    });
    let early = tokio::time::timeout(Duration::from_millis(800), &mut call).await;
    assert!(early.is_err(), "confirm did not wait for the Task row");
    tx.commit().await.unwrap();
    let (code, body) = call.await.unwrap();
    assert_eq!(code, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "not_ready");
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_date_after_the_due_date_is_422() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let task = w.work(project, None, None, "todo").await;
    let (code, body) = w
        .call(
            Method::PATCH,
            &format!("/tasks/{}", task["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":task["version"],"start_date":"2026-12-10","due_date":"2026-12-01"}),
        )
        .await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    w.finish().await;
}
