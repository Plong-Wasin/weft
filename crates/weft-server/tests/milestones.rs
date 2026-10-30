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
        "milestones_{}_{}",
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

    async fn task(&self, project: Uuid) -> Value {
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/workspaces/{}/tasks", self.workspace),
                &self.owner,
                json!({"project_id":project,"title":"Work","status":"backlog"}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body
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

    async fn read_task(&self, task: &Value, who: &Session) -> Value {
        let number = task["number"].as_i64().unwrap();
        let (status, body) = self
            .call(
                Method::GET,
                &format!("/workspaces/{}/tasks/{number}", self.workspace),
                who,
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn history(&self, action: &str, who: &Session) -> (StatusCode, Value) {
        self.call(
            Method::POST,
            &format!("/workspaces/{}/history/{action}", self.workspace),
            who,
            json!({}),
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

#[tokio::test(flavor = "multi_thread")]
async fn only_managers_write_milestones_and_reads_follow_project_access() {
    let w = world().await;
    let project = w.project("Plan", "restricted").await;
    w.grant(project, &w.member, "contributor").await;
    let list = format!("/projects/{project}/milestones");

    let (status, _) = w.call(Method::GET, &list, &w.outsider, Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = w
        .call(Method::POST, &list, &w.outsider, json!({"name":"Sneaky"}))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = w
        .call(Method::POST, &list, &w.member, json!({"name":"Nope"}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    for body in [
        json!({"name":"  "}),
        json!({"name":"A","state":"done"}),
        json!({"name":"A","target_date":"2026-02-30"}),
        json!({"name":"A","target_date":"soon"}),
    ] {
        let (status, _) = w.call(Method::POST, &list, &w.owner, body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    let (status, created) = w
        .call(
            Method::POST,
            &list,
            &w.owner,
            json!({"name":" Beta ","description":"Ship it","target_date":"2026-03-05"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["name"], "Beta");
    assert_eq!(created["description"], "Ship it");
    assert_eq!(created["target_date"], "2026-03-05");
    assert_eq!(created["state"], "planned");
    assert_eq!(created["project_id"], json!(project));
    let id = created["id"].as_str().unwrap();

    let (status, listed) = w.call(Method::GET, &list, &w.member, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["milestones"][0]["name"], "Beta");
    let (status, _) = w
        .call(
            Method::GET,
            &format!("/milestones/{id}"),
            &w.outsider,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let one = format!("/milestones/{id}");
    let (status, _) = w
        .call(
            Method::PATCH,
            &one,
            &w.member,
            json!({"expected_version":1,"state":"active"}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, edited) = w
        .call(
            Method::PATCH,
            &one,
            &w.owner,
            json!({"expected_version":1,"state":"active","target_date":null}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["state"], "active");
    assert_eq!(edited["target_date"], Value::Null);
    assert_eq!(edited["version"], 2);
    let (status, _) = w
        .call(
            Method::PATCH,
            &one,
            &w.owner,
            json!({"expected_version":1,"name":"Stale"}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = w
        .call(
            Method::PATCH,
            &one,
            &w.owner,
            json!({"expected_version":2,"state":"finished"}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, _) = w
        .call(
            Method::POST,
            &format!("{one}/archive"),
            &w.member,
            json!({"detach_tasks":true}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, history) = w
        .call(
            Method::GET,
            &format!("{one}/history"),
            &w.member,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let kinds: Vec<&str> = history["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["created", "updated"]);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_takes_one_milestone_of_its_own_project_with_one_refusal() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let other = w.project("Other", "workspace").await;
    let secret = w.project("Secret", "restricted").await;
    w.grant(project, &w.member, "contributor").await;
    let milestone = w.milestone(project, "Beta").await;
    let foreign = w.milestone(other, "Foreign").await;
    let hidden = w.milestone(secret, "Hidden").await;
    let task = w.task(project).await;

    let refusal = |status: StatusCode, body: Value| {
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"], "milestone_unavailable");
        body
    };
    let (status, body) = w.assign(&task, &w.member, foreign["id"].clone()).await;
    let in_other_project = refusal(status, body);
    let (status, body) = w.assign(&task, &w.member, hidden["id"].clone()).await;
    let unreadable = refusal(status, body);
    let (status, body) = w.assign(&task, &w.member, json!(Uuid::new_v4())).await;
    let missing = refusal(status, body);
    assert_eq!(in_other_project, unreadable);
    assert_eq!(unreadable, missing);
    assert!(!missing.to_string().contains("Hidden"));

    let (status, updated) = w.assign(&task, &w.member, milestone["id"].clone()).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["milestone_id"], milestone["id"]);
    assert_eq!(updated["milestone"]["name"], "Beta");
    assert_eq!(
        w.read_task(&task, &w.member).await["milestone"]["name"],
        "Beta"
    );

    let (status, cleared) = w.assign(&updated, &w.member, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["milestone_id"], Value::Null);
    assert_eq!(cleared["milestone"], Value::Null);

    let (status, _) = w
        .call(
            Method::PATCH,
            &format!("/milestones/{}", milestone["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":1,"state":"completed"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, completed) = w.assign(&cleared, &w.member, milestone["id"].clone()).await;
    assert_eq!(status, StatusCode::CONFLICT, "{completed}");
    assert_eq!(completed["error"], "milestone_completed");
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_a_milestone_changes_no_task_date() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let milestone = w.milestone(project, "Beta").await;
    let task = w.task(project).await;
    let (_, task) = w
        .call(
            Method::PATCH,
            &format!("/tasks/{}", task["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":1,"due_date":"2026-12-01","milestone_id":milestone["id"]}),
        )
        .await;
    let (status, _) = w
        .call(
            Method::PATCH,
            &format!("/milestones/{}", milestone["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":1,"target_date":"2027-06-30"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let after = w.read_task(&task, &w.owner).await;
    assert_eq!(after["due_date"], "2026-12-01");
    assert_eq!(after["version"], task["version"]);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn assignment_is_in_history_and_undo_rechecks_the_milestone() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    w.grant(project, &w.member, "contributor").await;
    let milestone = w.milestone(project, "Beta").await;
    let task = w.task(project).await;
    let id = task["id"].as_str().unwrap();

    let (_, assigned) = w.assign(&task, &w.member, milestone["id"].clone()).await;
    let (_, history) = w
        .call(
            Method::GET,
            &format!("/tasks/{id}/history"),
            &w.member,
            Value::Null,
        )
        .await;
    let entry = &history["operations"][0];
    assert_eq!(entry["field"], "milestone_id");
    assert_eq!(entry["before"], Value::Null);
    assert_eq!(entry["after"], milestone["id"]);

    let (status, undone) = w.history("undo", &w.member).await;
    assert_eq!(status, StatusCode::OK, "{undone}");
    assert_eq!(undone["task"]["milestone_id"], Value::Null);
    let (status, redone) = w.history("redo", &w.member).await;
    assert_eq!(status, StatusCode::OK, "{redone}");
    assert_eq!(redone["task"]["milestone_id"], milestone["id"]);

    // Clear it, archive the Milestone, then undo of the clear must refuse.
    let (_, cleared) = w.assign(&redone["task"], &w.member, Value::Null).await;
    assert_eq!(cleared["milestone_id"], Value::Null);
    let (status, _) = w
        .call(
            Method::POST,
            &format!("/milestones/{}/archive", milestone["id"].as_str().unwrap()),
            &w.owner,
            json!({"detach_tasks":true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = w.history("undo", &w.member).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "history_conflict");
    let (status, body) = w.assign(&cleared, &w.member, milestone["id"].clone()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    let _ = assigned;
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn undo_refuses_after_access_loss_and_for_archived_tasks() {
    let w = world().await;
    let project = w.project("Plan", "restricted").await;
    w.grant(project, &w.member, "contributor").await;
    let milestone = w.milestone(project, "Beta").await;
    let task = w.task(project).await;
    let (status, _) = w.assign(&task, &w.member, milestone["id"].clone()).await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = w
        .call(
            Method::DELETE,
            &format!("/projects/{project}/members/{}", w.member.user),
            &w.owner,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // A member who lost access sees nothing and cannot write or undo.
    let (status, _) = w
        .call(
            Method::GET,
            &format!("/projects/{project}/milestones"),
            &w.member,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = w.assign(&task, &w.member, Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = w.history("undo", &w.member).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    // Archived tasks are read-only for the owner too, undo included.
    let (_, current) = w
        .call(
            Method::GET,
            &format!("/workspaces/{}/tasks/{}", w.workspace, task["number"]),
            &w.owner,
            Value::Null,
        )
        .await;
    let (status, _) = w.assign(&current, &w.owner, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let (_, current) = w
        .call(
            Method::GET,
            &format!("/workspaces/{}/tasks/{}", w.workspace, task["number"]),
            &w.owner,
            Value::Null,
        )
        .await;
    let (status, _) = w
        .call(
            Method::POST,
            &format!(
                "/workspaces/{}/tasks/{}/archive",
                w.workspace, task["number"]
            ),
            &w.owner,
            json!({"expected_version":current["version"]}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, current) = w
        .call(
            Method::GET,
            &format!("/workspaces/{}/tasks/{}", w.workspace, task["number"]),
            &w.owner,
            Value::Null,
        )
        .await;
    let (status, _) = w.assign(&current, &w.owner, milestone["id"].clone()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn moving_a_task_previews_then_clears_its_milestone_and_undo_restores_it() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let target = w.project("Target", "workspace").await;
    let milestone = w.milestone(project, "Beta").await;
    let task = w.task(project).await;
    let (_, task) = w.assign(&task, &w.owner, milestone["id"].clone()).await;
    let id = task["id"].as_str().unwrap();

    let (status, preview) = w
        .call(
            Method::POST,
            &format!("/tasks/{id}/move-preview"),
            &w.owner,
            json!({"project_id":target}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["milestone_effect"]["clears"], true);
    assert_eq!(preview["milestone_effect"]["milestone"]["name"], "Beta");
    assert_eq!(preview["milestone_effect"]["tasks_cleared"], 1);

    let (status, body) = w
        .call(
            Method::PATCH,
            &format!("/tasks/{id}"),
            &w.owner,
            json!({"expected_version":task["version"],"project_id":target}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"], "move_confirmation_required");
    let (status, moved) = w
        .call(
            Method::PATCH,
            &format!("/tasks/{id}"),
            &w.owner,
            json!({"expected_version":task["version"],"project_id":target,"confirm_move":true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["project_id"], json!(target));
    assert_eq!(moved["milestone_id"], Value::Null);

    let (status, undone) = w.history("undo", &w.owner).await;
    assert_eq!(status, StatusCode::OK, "{undone}");
    assert_eq!(undone["task"]["project_id"], json!(project));
    assert_eq!(undone["task"]["milestone_id"], milestone["id"]);
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn archiving_a_milestone_shows_the_count_requires_a_choice_and_is_reversible() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let milestone = w.milestone(project, "Beta").await;
    let mid = milestone["id"].as_str().unwrap();
    let a = w.task(project).await;
    let b = w.task(project).await;
    let (_, a) = w.assign(&a, &w.owner, milestone["id"].clone()).await;
    let (_, b) = w.assign(&b, &w.owner, milestone["id"].clone()).await;

    let (status, preview) = w
        .call(
            Method::GET,
            &format!("/milestones/{mid}/archive-preview"),
            &w.owner,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["task_count"], 2);
    let (status, body) = w
        .call(
            Method::POST,
            &format!("/milestones/{mid}/archive"),
            &w.owner,
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"], "detach_required");
    assert_eq!(body["task_count"], 2);
    assert_eq!(
        w.read_task(&a, &w.owner).await["milestone_id"],
        milestone["id"]
    );

    let (status, archived) = w
        .call(
            Method::POST,
            &format!("/milestones/{mid}/archive"),
            &w.owner,
            json!({"detach_tasks":true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["detached_tasks"], 2);
    assert_eq!(w.read_task(&a, &w.owner).await["milestone_id"], Value::Null);
    assert_eq!(w.read_task(&b, &w.owner).await["milestone"], Value::Null);
    let (_, listed) = w
        .call(
            Method::GET,
            &format!("/projects/{project}/milestones"),
            &w.owner,
            Value::Null,
        )
        .await;
    assert!(listed["milestones"].as_array().unwrap().is_empty());
    let (_, listed) = w
        .call(
            Method::GET,
            &format!("/projects/{project}/milestones?include_archived=true"),
            &w.owner,
            Value::Null,
        )
        .await;
    assert_eq!(listed["milestones"][0]["archived"], true);
    let (status, _) = w
        .call(
            Method::PATCH,
            &format!("/milestones/{mid}"),
            &w.owner,
            json!({"expected_version":2,"name":"Edit"}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, restored) = w
        .call(
            Method::POST,
            &format!("/milestones/{mid}/restore"),
            &w.owner,
            json!({"reattach_tasks":true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["reattached_tasks"], 2);
    assert_eq!(
        w.read_task(&a, &w.owner).await["milestone_id"],
        milestone["id"]
    );
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn milestone_changes_reach_the_realtime_outbox_for_readers_only() {
    let w = world().await;
    let project = w.project("Plan", "restricted").await;
    let milestone = w.milestone(project, "Beta").await;
    let mid = milestone["id"].as_str().unwrap();
    w.call(
        Method::PATCH,
        &format!("/milestones/{mid}"),
        &w.owner,
        json!({"expected_version":1,"state":"active"}),
    )
    .await;
    w.call(
        Method::POST,
        &format!("/milestones/{mid}/archive"),
        &w.owner,
        json!({"detach_tasks":true}),
    )
    .await;
    let events: Vec<(String, Option<Uuid>)> = sqlx::query_as("SELECT event_type,project_id FROM realtime_outbox WHERE entity_type='milestone' AND entity_id=$1 ORDER BY id").bind(mid.parse::<Uuid>().unwrap()).fetch_all(&w.pool).await.unwrap();
    let kinds: Vec<&str> = events.iter().map(|e| e.0.as_str()).collect();
    assert_eq!(kinds, ["insert", "update", "archive"]);
    assert!(events.iter().all(|e| e.1 == Some(project)));

    // The snapshot only names events of Projects the caller reads.
    let (status, snapshot) = w
        .call(
            Method::GET,
            &format!("/workspaces/{}/realtime/snapshot", w.workspace),
            &w.outsider,
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!snapshot.to_string().contains(mid));
    w.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn moving_a_parent_clears_the_milestones_of_its_subtasks_and_undo_restores_them() {
    let w = world().await;
    let project = w.project("Plan", "workspace").await;
    let target = w.project("Target", "workspace").await;
    let milestone = w.milestone(project, "Beta").await;
    let parent = w.task(project).await;
    let (status, child) = w
        .call(
            Method::POST,
            &format!("/workspaces/{}/tasks", w.workspace),
            &w.owner,
            json!({"project_id":project,"title":"Child","status":"backlog","parent_task_id":parent["id"]}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{child}");
    let (_, child) = w.assign(&child, &w.owner, milestone["id"].clone()).await;
    let (_, parent) = w
        .call(
            Method::GET,
            &format!("/workspaces/{}/tasks/{}", w.workspace, parent["number"]),
            &w.owner,
            Value::Null,
        )
        .await;
    let (_, preview) = w
        .call(
            Method::POST,
            &format!("/tasks/{}/move-preview", parent["id"].as_str().unwrap()),
            &w.owner,
            json!({"project_id":target}),
        )
        .await;
    assert_eq!(preview["milestone_effect"]["tasks_cleared"], 1);
    let (status, moved) = w
        .call(
            Method::PATCH,
            &format!("/tasks/{}", parent["id"].as_str().unwrap()),
            &w.owner,
            json!({"expected_version":parent["version"],"project_id":target,"confirm_move":true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(
        w.read_task(&child, &w.owner).await["milestone_id"],
        Value::Null
    );
    let (status, undone) = w.history("undo", &w.owner).await;
    assert_eq!(status, StatusCode::OK, "{undone}");
    assert_eq!(
        w.read_task(&child, &w.owner).await["milestone_id"],
        milestone["id"]
    );
    w.finish().await;
}
