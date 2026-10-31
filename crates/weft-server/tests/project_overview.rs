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
        "project_overview_{}_{}",
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
    async fn patch(&self, project: Uuid, who: &Session, body: Value) -> (StatusCode, Value) {
        self.call(Method::PATCH, &format!("/projects/{project}"), who, body)
            .await
    }

    async fn task(&self, project: Uuid, status: &str, due: Option<&str>) -> Value {
        let (code, body) = self
            .call(
                Method::POST,
                &format!("/workspaces/{}/tasks", self.workspace),
                &self.owner,
                json!({"project_id":project,"title":"Work","status":status,"due_date":due}),
            )
            .await;
        assert_eq!(code, StatusCode::CREATED, "{body}");
        body
    }

    async fn overview(&self, project: Uuid, who: &Session) -> (StatusCode, Value) {
        self.call(
            Method::GET,
            &format!("/projects/{project}/overview"),
            who,
            Value::Null,
        )
        .await
    }

    async fn block(&self, blocker: &Value, blocked: &Value) {
        let (code, body) = self
            .call(
                Method::POST,
                &format!("/tasks/{}/relations", blocker["id"].as_str().unwrap()),
                &self.owner,
                json!({"target_task_id":blocked["id"],"kind":"blocks"}),
            )
            .await;
        assert!(code.is_success(), "{body}");
    }

    async fn listed(&self, query: &str, who: &Session) -> Vec<Value> {
        let (code, body) = self
            .call(
                Method::GET,
                &format!("/workspaces/{}/tasks?{query}", self.workspace),
                who,
                Value::Null,
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{body}");
        body["tasks"].as_array().unwrap().clone()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn overview_shows_state_dates_milestones_overdue_and_blocked() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let (code, body) = w
        .call(
            Method::PATCH,
            &format!("/projects/{project}"),
            &w.owner,
            json!({"state":"planned","target_start_date":"2026-01-05","target_end_date":"2026-12-31"}),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "planned");
    let beta = w.milestone(project, "Beta").await;
    let empty = w.milestone(project, "Empty").await;
    let done = w.task(project, "completed", Some("2000-01-01")).await;
    let late = w.task(project, "active", Some("2000-01-01")).await;
    let future = w.task(project, "active", Some("2999-01-01")).await;
    w.task(project, "active", None).await;
    w.task(project, "wont_do", Some("2000-01-01")).await;
    let (code, _) = w.assign(&done, &w.owner, beta["id"].clone()).await;
    assert_eq!(code, StatusCode::OK);
    // `late` is blocked by an open Task; `future` is blocked by a completed Task (not blocked).
    let open_blocker = w.task(project, "active", None).await;
    w.block(&open_blocker, &late).await;
    w.block(&done, &future).await;

    let (code, view) = w.overview(project, &w.member).await;
    assert_eq!(code, StatusCode::OK, "{view}");
    assert_eq!(view["project"]["name"], "Plan");
    assert_eq!(view["project"]["state"], "planned");
    assert_eq!(view["project"]["target_start_date"], "2026-01-05");
    assert_eq!(view["project"]["target_end_date"], "2026-12-31");
    assert_eq!(view["time_zone"], "UTC");
    let milestones = view["milestones"].as_array().unwrap();
    assert_eq!(milestones.len(), 2);
    let by_name = |name: &str| milestones.iter().find(|m| m["name"] == name).unwrap();
    assert_eq!(by_name("Beta")["progress"]["completed"], 1);
    assert_eq!(by_name("Beta")["progress"]["total"], 1);
    assert_eq!(by_name("Beta")["target_date"], "2026-12-01");
    assert_eq!(by_name("Empty")["progress"]["status"], "no_work_yet");
    // Overdue: due before today and not completed or wont_do.
    assert_eq!(view["overdue"]["count"], 1, "{view}");
    assert_eq!(view["overdue"]["tasks"][0]["number"], late["number"]);
    assert_eq!(view["overdue"]["tasks"][0]["due_date"], "2000-01-01");
    assert_eq!(view["blocked"]["count"], 1, "{view}");
    // Each item links to the filtered Task list, and the list matches the count.
    let overdue = w
        .listed(view["overdue"]["tasks_query"].as_str().unwrap(), &w.member)
        .await;
    assert_eq!(overdue.len(), 1);
    assert_eq!(overdue[0]["number"], late["number"]);
    let blocked = w
        .listed(view["blocked"]["tasks_query"].as_str().unwrap(), &w.member)
        .await;
    assert_eq!(blocked.len(), 1);
    assert_eq!(blocked[0]["number"], late["number"]);
    let in_beta = w
        .listed(by_name("Beta")["tasks_query"].as_str().unwrap(), &w.member)
        .await;
    assert_eq!(in_beta.len(), 1);
    assert_eq!(in_beta[0]["id"], done["id"]);
    let _ = empty;
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn restricted_project_overview_is_the_same_as_a_missing_project() {
    let w = world().await;
    let project = w.project("Secret", "restricted").await;
    w.milestone(project, "Hidden").await;
    w.task(project, "active", Some("2000-01-01")).await;
    let (code, body) = w.overview(project, &w.outsider).await;
    let (missing_code, missing_body) = w.overview(Uuid::new_v4(), &w.outsider).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    assert_eq!(code, missing_code);
    assert_eq!(body, missing_body);
    // A granted member sees it; the filtered lists never carry Tasks of a Project the caller cannot read.
    w.grant(project, &w.member, "viewer").await;
    let (code, view) = w.overview(project, &w.member).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(view["overdue"]["count"], 1);
    assert!(w
        .listed("overdue=true&blocked=false", &w.outsider)
        .await
        .is_empty());
    assert!(w
        .listed(&format!("project_id={project}&overdue=true"), &w.outsider)
        .await
        .is_empty());
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn only_managers_see_confirm_hint_and_set_project_state() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let m = w.milestone(project, "Beta").await;
    let t = w.task(project, "completed", None).await;
    let (code, _) = w.assign(&t, &w.owner, m["id"].clone()).await;
    assert_eq!(code, StatusCode::OK);
    let (_, manager_view) = w.overview(project, &w.owner).await;
    assert_eq!(
        manager_view["milestones"][0]["progress"]["ready_to_confirm"],
        true
    );
    let (_, member_view) = w.overview(project, &w.member).await;
    assert_eq!(
        member_view["milestones"][0]["progress"]["ready_to_confirm"],
        false
    );
    // A member who is not a Manager cannot change the state; bad input is 422, not 500.
    assert_ne!(
        w.patch(project, &w.member, json!({"state":"completed"}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        w.patch(project, &w.owner, json!({"state":"nope"})).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        w.patch(project, &w.owner, json!({"target_end_date":"2026-02-31"}))
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        w.patch(
            project,
            &w.owner,
            json!({"target_start_date":"2026-05-01","target_end_date":"2026-04-01"})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn today_follows_the_workspace_time_zone() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    sqlx::query("UPDATE workspaces SET time_zone='Pacific/Kiritimati' WHERE id=$1")
        .bind(w.workspace)
        .execute(&w.pool)
        .await
        .unwrap();
    let expected: String =
        sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text")
            .fetch_one(&w.pool)
            .await
            .unwrap();
    let yesterday: String =
        sqlx::query_scalar("SELECT ((now() AT TIME ZONE 'Pacific/Kiritimati')::date - 1)::text")
            .fetch_one(&w.pool)
            .await
            .unwrap();
    // Due "today" in the zone is not overdue; due the day before is.
    w.task(project, "active", Some(&expected)).await;
    let late = w.task(project, "active", Some(&yesterday)).await;
    let (_, view) = w.overview(project, &w.member).await;
    assert_eq!(view["today"], json!(expected));
    assert_eq!(view["time_zone"], "Pacific/Kiritimati");
    assert_eq!(view["overdue"]["count"], 1);
    assert_eq!(view["overdue"]["tasks"][0]["number"], late["number"]);
    w.finish().await;
}
