use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    user: Uuid,
    cookie: String,
    csrf: String,
}

struct Env {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    pool: sqlx::PgPool,
    workspace: Uuid,
    owner: Session,
    delegate: Session,
    member: Session,
    other: Session,
    viewer: Session,
}

async fn setup() -> Env {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("tmpl_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
    let delegate = add_user(&pool, workspace, "delegate@example.com", "admin").await;
    let member = add_user(&pool, workspace, "member@example.com", "member").await;
    let other = add_user(&pool, workspace, "other@example.com", "member").await;
    let viewer = add_user(&pool, workspace, "viewer@example.com", "viewer").await;
    Env {
        origin,
        server,
        schema,
        admin,
        workspace,
        owner: session(&pool, owner).await,
        delegate: session(&pool, delegate).await,
        member: session(&pool, member).await,
        other: session(&pool, other).await,
        viewer: session(&pool, viewer).await,
        pool,
    }
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

async fn call(
    env: &Env,
    method: reqwest::Method,
    path: &str,
    who: &Session,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let url = format!("{}/api/v1{path}", env.origin);
    let mut builder = request(&reqwest::Client::new(), method, url, who);
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    let response = builder.send().await.unwrap();
    let status = response.status().as_u16();
    let body = response.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

async fn post(
    env: &Env,
    path: &str,
    who: &Session,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    call(env, reqwest::Method::POST, path, who, Some(body)).await
}

async fn get(env: &Env, path: &str, who: &Session) -> (u16, serde_json::Value) {
    call(env, reqwest::Method::GET, path, who, None).await
}

async fn project(env: &Env, who: &Session, visibility: &str) -> Uuid {
    let (status, body) = post(
        env,
        &format!("/workspaces/{}/projects", env.workspace),
        who,
        serde_json::json!({"name":"Delivery","visibility":visibility}),
    )
    .await;
    assert_eq!(status, 201);
    body["id"].as_str().unwrap().parse().unwrap()
}

async fn grant(env: &Env, project: Uuid, user: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,$4)",
    )
    .bind(env.workspace)
    .bind(project)
    .bind(user)
    .bind(role)
    .execute(&env.pool)
    .await
    .unwrap();
}

async fn task_count(env: &Env) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM tasks WHERE archived_at IS NULL")
        .fetch_one(&env.pool)
        .await
        .unwrap()
}

fn release_template() -> serde_json::Value {
    serde_json::json!({
        "name": "Release",
        "title_pattern": "Release {{version}}",
        "description": "Ship it",
        "priority": "high",
        "default_status": "active",
        "checklist": ["Tag", "Announce"],
        "subtasks": [
            {"title_pattern": "Freeze {{version}}", "description": "Stop merging", "checklist": ["Branch"]},
            {"title_pattern": "Notes for {{version}}", "status": "not_started"}
        ]
    })
}

async fn task_template(env: &Env, body: serde_json::Value) -> Uuid {
    let (status, created) = post(
        env,
        &format!("/workspaces/{}/task-templates", env.workspace),
        &env.owner,
        body,
    )
    .await;
    assert_eq!(status, 201, "{created}");
    created["id"].as_str().unwrap().parse().unwrap()
}

async fn undo(env: &Env, who: &Session) -> (u16, serde_json::Value) {
    post(
        env,
        &format!("/workspaces/{}/history/undo", env.workspace),
        who,
        serde_json::json!({}),
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn only_workspace_admins_manage_templates_and_a_revoked_admin_loses_the_right() {
    let env = setup().await;
    let base = format!("/workspaces/{}/task-templates", env.workspace);
    // Members and viewers cannot create, edit or delete.
    for who in [&env.member, &env.viewer] {
        assert_eq!(post(&env, &base, who, release_template()).await.0, 403);
    }
    let id = task_template(&env, release_template()).await;
    let one = format!("{base}/{id}");
    for who in [&env.member, &env.viewer] {
        let (status, _) = call(
            &env,
            reqwest::Method::PATCH,
            &one,
            who,
            Some(serde_json::json!({"name":"Hijack"})),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(
            call(&env, reqwest::Method::DELETE, &one, who, None).await.0,
            403
        );
    }
    // Every member can read the library.
    for who in [&env.member, &env.viewer, &env.other] {
        let (status, list) = get(&env, &base, who).await;
        assert_eq!(status, 200);
        assert_eq!(list["templates"].as_array().unwrap().len(), 1);
        assert_eq!(get(&env, &one, who).await.0, 200);
    }
    // An Admin edits with a version check, then is demoted and loses the right at once.
    let (status, edited) = call(
        &env,
        reqwest::Method::PATCH,
        &one,
        &env.delegate,
        Some(serde_json::json!({"name":"Release v2","expected_version":1})),
    )
    .await;
    assert_eq!(status, 200, "{edited}");
    assert_eq!(edited["version"], 2);
    let (status, _) = call(
        &env,
        reqwest::Method::PATCH,
        &one,
        &env.delegate,
        Some(serde_json::json!({"name":"Stale","expected_version":1})),
    )
    .await;
    assert_eq!(status, 409);
    sqlx::query("UPDATE workspace_memberships SET role='member' WHERE user_id=$1")
        .bind(env.delegate.user)
        .execute(&env.pool)
        .await
        .unwrap();
    assert_eq!(
        post(&env, &base, &env.delegate, release_template()).await.0,
        403
    );
    assert_eq!(
        call(&env, reqwest::Method::DELETE, &one, &env.delegate, None)
            .await
            .0,
        403
    );
    // The owner deletes; the template is gone for everyone.
    assert_eq!(
        call(&env, reqwest::Method::DELETE, &one, &env.owner, None)
            .await
            .0,
        204
    );
    assert_eq!(get(&env, &one, &env.member).await.0, 404);
    // Templates never carry access and reject malformed input.
    let mut with_access = release_template();
    with_access["members"] = serde_json::json!([{"user_id":env.member.user,"role":"manager"}]);
    assert_eq!(post(&env, &base, &env.owner, with_access).await.0, 422);
    let mut blank = release_template();
    blank["title_pattern"] = "  ".into();
    assert_eq!(post(&env, &base, &env.owner, blank).await.0, 422);
    let mut bad_priority = release_template();
    bad_priority["priority"] = "someday".into();
    assert_eq!(post(&env, &base, &env.owner, bad_priority).await.0, 422);
    let mut many = release_template();
    many["subtasks"] = serde_json::Value::Array(vec![serde_json::json!({"title_pattern":"x"}); 51]);
    assert_eq!(post(&env, &base, &env.owner, many).await.0, 422);
    let projects = format!("/workspaces/{}/project-templates", env.workspace);
    assert_eq!(
        post(
            &env,
            &projects,
            &env.member,
            serde_json::json!({"name":"Kickoff"})
        )
        .await
        .0,
        403
    );
    assert_eq!(
        post(
            &env,
            &projects,
            &env.owner,
            serde_json::json!({"name":"Kickoff","visibility":"workspace"})
        )
        .await
        .0,
        422
    );
    let (status, _) = post(
        &env,
        &projects,
        &env.owner,
        serde_json::json!({"name":"Kickoff","milestones":[{"name":"Beta","offset_days":14}]}),
    )
    .await;
    assert_eq!(status, 201);
    cleanup(env.server, env.schema, env.admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn creating_a_task_from_a_template_is_one_group_and_one_undo_removes_it() {
    let env = setup().await;
    let project = project(&env, &env.owner, "restricted").await;
    grant(&env, project, env.member.user, "contributor").await;
    let attribute: serde_json::Value = post(
        &env,
        &format!("/workspaces/{}/attributes", env.workspace),
        &env.owner,
        serde_json::json!({"name":"Area","value_type":"text","project_ids":[project]}),
    )
    .await
    .1;
    let mut body = release_template();
    body["attributes"] = serde_json::json!([{"attribute_id":attribute["id"],"value":"platform"}]);
    let id = task_template(&env, body).await;
    let before = task_count(&env).await;
    let (status, created) = post(
        &env,
        &format!(
            "/workspaces/{}/task-templates/{id}/instantiate",
            env.workspace
        ),
        &env.member,
        serde_json::json!({"project_id":project,"variables":{"version":"1.4"}}),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let tasks = created["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 3);
    assert_eq!(tasks[0]["title"], "Release 1.4");
    assert_eq!(tasks[0]["status"], "active");
    assert_eq!(tasks[0]["priority"], "high");
    assert_eq!(tasks[1]["title"], "Freeze 1.4");
    assert_eq!(tasks[1]["status"], "backlog");
    assert_eq!(tasks[2]["status"], "not_started");
    assert_eq!(tasks[1]["parent_task_id"], tasks[0]["id"]);
    assert_eq!(tasks[2]["parent_task_id"], tasks[0]["id"]);
    assert_eq!(task_count(&env).await, before + 3);
    let root = tasks[0]["id"].as_str().unwrap();
    let (_, checklist) = get(&env, &format!("/tasks/{root}/checklist"), &env.member).await;
    let titles: Vec<_> = checklist["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["title"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(titles, ["Tag", "Announce"]);
    let (_, attributes) = get(&env, &format!("/tasks/{root}/attributes"), &env.member).await;
    assert!(attributes.to_string().contains("platform"), "{attributes}");
    // The created Tasks are Member-owned history; the owner's Undo stack is untouched.
    let (status, _) = undo(&env, &env.owner).await;
    assert_eq!(status, 409);
    // One Undo removes the whole group, one Redo brings it back.
    let (status, undone) = undo(&env, &env.member).await;
    assert_eq!(status, 200, "{undone}");
    assert_eq!(task_count(&env).await, before);
    let (status, _) = post(
        &env,
        &format!("/workspaces/{}/history/redo", env.workspace),
        &env.member,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(task_count(&env).await, before + 3);
    cleanup(env.server, env.schema, env.admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_template_with_archived_or_missing_references_reports_them_and_creates_nothing() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    grant(&env, project, env.member.user, "contributor").await;
    let attribute: serde_json::Value = post(
        &env,
        &format!("/workspaces/{}/attributes", env.workspace),
        &env.owner,
        serde_json::json!({"name":"Area","value_type":"text","project_ids":[project]}),
    )
    .await
    .1;
    let loose: serde_json::Value = post(
        &env,
        &format!("/workspaces/{}/attributes", env.workspace),
        &env.owner,
        serde_json::json!({"name":"Loose","value_type":"text"}),
    )
    .await
    .1;
    let mut body = release_template();
    body["attributes"] = serde_json::json!([
        {"attribute_id":attribute["id"],"value":"platform"},
        {"attribute_id":loose["id"],"value":"x"},
        {"attribute_id":Uuid::new_v4(),"value":"y"}
    ]);
    let id = task_template(&env, body).await;
    sqlx::query("UPDATE workspace_statuses SET archived_at=now() WHERE status_key IN ('active','not_started')")
        .execute(&env.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE attribute_schemas SET archived_at=now() WHERE id=$1")
        .bind(attribute["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(&env.pool)
        .await
        .unwrap();
    let before = task_count(&env).await;
    let next: i64 = sqlx::query_scalar("SELECT next_task_number FROM workspaces WHERE id=$1")
        .bind(env.workspace)
        .fetch_one(&env.pool)
        .await
        .unwrap();
    let (status, report) = post(
        &env,
        &format!(
            "/workspaces/{}/task-templates/{id}/instantiate",
            env.workspace
        ),
        &env.member,
        serde_json::json!({"project_id":project,"variables":{}}),
    )
    .await;
    assert_eq!(status, 422, "{report}");
    assert_eq!(report["error"], "template_unresolved");
    let missing = report["missing"].as_array().unwrap();
    let has = |kind: &str, key: &str| missing.iter().any(|m| m["kind"] == kind && m["key"] == key);
    assert!(has("status", "active"), "{report}");
    assert!(has("status", "not_started"), "{report}");
    assert!(has("variable", "version"), "{report}");
    assert!(
        has("attribute", attribute["id"].as_str().unwrap()),
        "{report}"
    );
    assert!(has("attribute", loose["id"].as_str().unwrap()), "{report}");
    assert_eq!(
        missing.iter().filter(|m| m["kind"] == "attribute").count(),
        3
    );
    assert_eq!(task_count(&env).await, before);
    let after: i64 = sqlx::query_scalar("SELECT next_task_number FROM workspaces WHERE id=$1")
        .bind(env.workspace)
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(after, next);
    cleanup(env.server, env.schema, env.admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failure_halfway_leaves_no_task_checklist_or_history_behind() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    grant(&env, project, env.member.user, "contributor").await;
    let id = task_template(&env, release_template()).await;
    sqlx::query("CREATE FUNCTION refuse_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title = 'Notes for boom' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$")
        .execute(&env.pool)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER refuse_boom BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_boom()")
        .execute(&env.pool)
        .await
        .unwrap();
    let next: i64 = sqlx::query_scalar("SELECT next_task_number FROM workspaces WHERE id=$1")
        .bind(env.workspace)
        .fetch_one(&env.pool)
        .await
        .unwrap();
    let (status, _) = post(
        &env,
        &format!(
            "/workspaces/{}/task-templates/{id}/instantiate",
            env.workspace
        ),
        &env.member,
        serde_json::json!({"project_id":project,"variables":{"version":"boom"}}),
    )
    .await;
    assert_eq!(status, 500);
    assert_eq!(task_count(&env).await, 0);
    let checklist: i64 = sqlx::query_scalar("SELECT count(*) FROM task_checklist_items")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    let groups: i64 =
        sqlx::query_scalar("SELECT count(*) FROM task_operation_groups WHERE actor_id=$1")
            .bind(env.member.user)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    let after: i64 = sqlx::query_scalar("SELECT next_task_number FROM workspaces WHERE id=$1")
        .bind(env.workspace)
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!((checklist, groups, after), (0, 0, next));
    cleanup(env.server, env.schema, env.admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn instantiating_respects_project_access_without_leaking_existence() {
    let env = setup().await;
    let restricted = project(&env, &env.owner, "restricted").await;
    let shared = project(&env, &env.owner, "workspace").await;
    grant(&env, restricted, env.member.user, "viewer").await;
    let id = task_template(
        &env,
        serde_json::json!({"name":"Plain","title_pattern":"Plain work"}),
    )
    .await;
    let path = format!(
        "/workspaces/{}/task-templates/{id}/instantiate",
        env.workspace
    );
    let missing_project = post(
        &env,
        &path,
        &env.member,
        serde_json::json!({"project_id":Uuid::new_v4()}),
    )
    .await;
    // A viewer, a stranger to a restricted Project and a Workspace-visible Project read-only for a viewer all look alike.
    let as_viewer = post(
        &env,
        &path,
        &env.member,
        serde_json::json!({"project_id":restricted}),
    )
    .await;
    let as_stranger = post(
        &env,
        &path,
        &env.other,
        serde_json::json!({"project_id":restricted}),
    )
    .await;
    let as_workspace_viewer = post(
        &env,
        &path,
        &env.viewer,
        serde_json::json!({"project_id":shared}),
    )
    .await;
    for response in [&as_viewer, &as_stranger, &as_workspace_viewer] {
        assert_eq!(response.0, 404);
        assert_eq!(response.1, missing_project.1);
    }
    assert_eq!(missing_project.0, 404);
    assert_eq!(task_count(&env).await, 0);
    // A Workspace-visible Project is writable by a contributor only; a plain member is read-only there.
    assert_eq!(
        post(
            &env,
            &path,
            &env.other,
            serde_json::json!({"project_id":shared})
        )
        .await
        .0,
        404
    );
    grant(&env, shared, env.other.user, "contributor").await;
    assert_eq!(
        post(
            &env,
            &path,
            &env.other,
            serde_json::json!({"project_id":shared})
        )
        .await
        .0,
        201
    );
    // The second member cannot see the template-made Task in the Project they cannot read.
    let (status, list) = get(
        &env,
        &format!(
            "/workspaces/{}/tasks?project_id={restricted}",
            env.workspace
        ),
        &env.other,
    )
    .await;
    assert!(status == 200 || status == 404);
    assert!(!list.to_string().contains("Plain work"));
    cleanup(env.server, env.schema, env.admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_from_a_template_gets_default_access_only_and_undoes_as_one_group() {
    let env = setup().await;
    let release = task_template(&env, release_template()).await;
    let plain = task_template(
        &env,
        serde_json::json!({"name":"Plain","title_pattern":"Kick off {{version}}"}),
    )
    .await;
    let (status, template) = post(
        &env,
        &format!("/workspaces/{}/project-templates", env.workspace),
        &env.owner,
        serde_json::json!({
            "name":"Launch",
            "description":"Standard launch",
            "statuses":["backlog","active"],
            "milestones":[{"name":"Beta","description":"Public beta","offset_days":14},{"name":"GA","offset_days":45}],
            "task_templates":[release, plain]
        }),
    )
    .await;
    assert_eq!(status, 201, "{template}");
    let template_id = template["id"].as_str().unwrap();
    let path = format!(
        "/workspaces/{}/project-templates/{template_id}/instantiate",
        env.workspace
    );
    // Milestones need a start date.
    let (status, _) = post(
        &env,
        &path,
        &env.member,
        serde_json::json!({"name":"Q1","visibility":"restricted","variables":{"version":"1"}}),
    )
    .await;
    assert_eq!(status, 422);
    let (status, created) = post(
        &env,
        &path,
        &env.member,
        serde_json::json!({"name":"Q1 launch","visibility":"restricted","start_date":"2026-02-20","variables":{"version":"1"}}),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let project: Uuid = created["project"]["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(created["project"]["role"], "manager");
    assert_eq!(created["tasks"].as_array().unwrap().len(), 4);
    // Milestones are real rows with dates computed from the start date, in the same operation.
    assert!(created.get("milestones_pending").is_none(), "{created}");
    let rows: Vec<(String, String, Option<String>, bool)> = sqlx::query_as("SELECT name,description,target_date::text,archived_at IS NULL FROM milestones WHERE project_id=$1 ORDER BY target_date")
        .bind(project)
        .fetch_all(&env.pool)
        .await
        .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                "Beta".into(),
                "Public beta".into(),
                Some("2026-03-06".into()),
                true
            ),
            ("GA".into(), String::new(), Some("2026-04-06".into()), true),
        ]
    );
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM milestone_events WHERE project_id=$1 AND kind='created' AND actor_id=$2")
        .bind(project)
        .bind(env.member.user)
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(events, 2);
    let (status, listed) = get(
        &env,
        &format!("/projects/{project}/milestones"),
        &env.member,
    )
    .await;
    assert_eq!(status, 200, "{listed}");
    // A second member without access learns nothing about them.
    assert_eq!(
        get(&env, &format!("/projects/{project}/milestones"), &env.other)
            .await
            .0,
        404
    );
    // Default access only: the creator is the single member; nobody else reads the Project or its Tasks.
    let members: i64 =
        sqlx::query_scalar("SELECT count(*) FROM project_memberships WHERE project_id=$1")
            .bind(project)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(members, 1);
    let teams: i64 =
        sqlx::query_scalar("SELECT count(*) FROM project_team_memberships WHERE project_id=$1")
            .bind(project)
            .fetch_one(&env.pool)
            .await
            .unwrap();
    assert_eq!(teams, 0);
    assert_eq!(
        get(&env, &format!("/projects/{project}"), &env.other)
            .await
            .0,
        404
    );
    let number = created["tasks"][0]["number"].as_i64().unwrap();
    assert_eq!(
        get(
            &env,
            &format!("/workspaces/{}/tasks/{number}", env.workspace),
            &env.other
        )
        .await
        .0,
        404
    );
    // One Undo archives the Tasks and the Project; one Redo restores both.
    let (status, undone) = undo(&env, &env.member).await;
    assert_eq!(status, 200, "{undone}");
    assert_eq!(
        get(&env, &format!("/projects/{project}"), &env.member)
            .await
            .0,
        404
    );
    assert_eq!(task_count(&env).await, 0);
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM milestones WHERE project_id=$1 AND archived_at IS NULL",
    )
    .bind(project)
    .fetch_one(&env.pool)
    .await
    .unwrap();
    assert_eq!(open, 0, "one Undo takes the Milestones with the Project");
    let (status, redone) = post(
        &env,
        &format!("/workspaces/{}/history/redo", env.workspace),
        &env.member,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, 200, "{redone}");
    assert_eq!(
        get(&env, &format!("/projects/{project}"), &env.member)
            .await
            .0,
        200
    );
    assert_eq!(task_count(&env).await, 4);
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM milestones WHERE project_id=$1 AND archived_at IS NULL",
    )
    .bind(project)
    .fetch_one(&env.pool)
    .await
    .unwrap();
    assert_eq!(open, 2, "one Redo gives the Milestones back");
    // A Milestone someone adds later is work the group did not create: Undo refuses.
    let (status, extra) = post(
        &env,
        &format!("/projects/{project}/milestones"),
        &env.member,
        serde_json::json!({"name":"Extra"}),
    )
    .await;
    assert_eq!(status, 201, "{extra}");
    let (status, refused) = undo(&env, &env.member).await;
    assert_eq!(status, 409, "{refused}");
    sqlx::query("UPDATE milestones SET archived_at=now() WHERE name='Extra'")
        .execute(&env.pool)
        .await
        .unwrap();
    // Once someone adds other work to the Project, Undo refuses instead of orphaning it.
    let (status, _) = post(
        &env,
        &format!("/workspaces/{}/tasks", env.workspace),
        &env.member,
        serde_json::json!({"project_id":project,"title":"Extra"}),
    )
    .await;
    assert_eq!(status, 201);
    let (status, refused) = undo(&env, &env.member).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(
        get(&env, &format!("/projects/{project}"), &env.member)
            .await
            .0,
        200
    );
    cleanup(env.server, env.schema, env.admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_milestone_failure_leaves_no_project_task_or_milestone_behind() {
    let env = setup().await;
    let release = task_template(&env, release_template()).await;
    let (_, template) = post(
        &env,
        &format!("/workspaces/{}/project-templates", env.workspace),
        &env.owner,
        serde_json::json!({"name":"Launch","milestones":[{"name":"Beta","offset_days":1},{"name":"Boom","offset_days":2}],"task_templates":[release]}),
    )
    .await;
    sqlx::query("CREATE FUNCTION refuse_boom_milestone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'Boom' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$")
        .execute(&env.pool)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER refuse_boom_milestone BEFORE INSERT ON milestones FOR EACH ROW EXECUTE FUNCTION refuse_boom_milestone()")
        .execute(&env.pool)
        .await
        .unwrap();
    let projects: i64 = sqlx::query_scalar("SELECT count(*) FROM projects")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    let (status, _) = post(
        &env,
        &format!(
            "/workspaces/{}/project-templates/{}/instantiate",
            env.workspace,
            template["id"].as_str().unwrap()
        ),
        &env.member,
        serde_json::json!({"name":"Q3","visibility":"workspace","start_date":"2026-01-01","variables":{"version":"3"}}),
    )
    .await;
    assert_eq!(status, 500);
    assert_eq!(task_count(&env).await, 0);
    let left: (i64, i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM milestones),(SELECT count(*) FROM milestone_events),(SELECT count(*) FROM projects)")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(left, (0, 0, projects));
    cleanup(env.server, env.schema, env.admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_template_reports_every_gap_and_creates_no_project() {
    let env = setup().await;
    let release = task_template(&env, release_template()).await;
    let (_, template) = post(
        &env,
        &format!("/workspaces/{}/project-templates", env.workspace),
        &env.owner,
        serde_json::json!({"name":"Launch","statuses":["backlog","active"],"task_templates":[release, Uuid::new_v4()]}),
    )
    .await;
    sqlx::query("UPDATE workspace_statuses SET archived_at=now() WHERE status_key='active'")
        .execute(&env.pool)
        .await
        .unwrap();
    let projects_before: i64 = sqlx::query_scalar("SELECT count(*) FROM projects")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    let (status, report) = post(
        &env,
        &format!(
            "/workspaces/{}/project-templates/{}/instantiate",
            env.workspace,
            template["id"].as_str().unwrap()
        ),
        &env.member,
        serde_json::json!({"name":"Q2","visibility":"workspace","variables":{"version":"2"}}),
    )
    .await;
    assert_eq!(status, 422, "{report}");
    assert_eq!(report["error"], "template_unresolved");
    let missing = report["missing"].as_array().unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM milestones")
            .fetch_one(&env.pool)
            .await
            .unwrap(),
        0
    );
    assert!(
        missing
            .iter()
            .any(|m| m["kind"] == "status" && m["key"] == "active"),
        "{report}"
    );
    assert!(
        missing.iter().any(|m| m["kind"] == "task_template"),
        "{report}"
    );
    let projects_after: i64 = sqlx::query_scalar("SELECT count(*) FROM projects")
        .fetch_one(&env.pool)
        .await
        .unwrap();
    assert_eq!(projects_after, projects_before);
    assert_eq!(task_count(&env).await, 0);
    cleanup(env.server, env.schema, env.admin).await;
}

async fn cleanup(server: tokio::task::JoinHandle<()>, schema: String, admin: sqlx::PgPool) {
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
