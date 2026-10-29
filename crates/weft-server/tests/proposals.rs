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
) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!(
        "proposals_{}_{}",
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
    let project = Uuid::new_v4();
    sqlx::query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,'Proposal scope','workspace',$3)").bind(project).bind(workspace).bind(owner).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')").bind(workspace).bind(project).bind(owner).execute(&pool).await.unwrap();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')").bind(Uuid::new_v4()).bind(owner).bind(hash).bind(&csrf).execute(&pool).await.unwrap();
    (
        origin,
        server,
        schema,
        admin,
        project,
        Session {
            cookie: format!("weft_session={token}; weft_csrf={csrf}"),
            csrf,
        },
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn mock_provider_proposal_is_approved_once_and_undo_archives_generated_tasks() {
    let (origin, server, schema, admin, project, session) = fixture().await;
    let client = reqwest::Client::new();
    let workspaces: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/me"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let workspace = workspaces["workspaces"][0]["id"].as_str().unwrap();
    let url = format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock");
    let existing = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/tasks"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"project_id":project,"title":"Existing task"}))
        .send()
        .await
        .unwrap();
    assert_eq!(existing.status(), reqwest::StatusCode::CREATED);
    let existing: serde_json::Value = existing.json().await.unwrap();
    let skills: serde_json::Value = client
        .get(format!("{origin}/api/v1/workspaces/{workspace}/skills"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let skill_id = skills["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "How this Workspace works")
        .unwrap()["id"]
        .clone();
    let original_skill: serde_json::Value = client
        .get(format!(
            "{origin}/api/v1/workspaces/{workspace}/skills/{}",
            skill_id.as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let vault = Uuid::new_v4();
    let scoped = format!(
        "{}?options=-csearch_path%3D{}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into()),
        schema
    );
    let db = sqlx::PgPool::connect(&scoped).await.unwrap();
    sqlx::query("INSERT INTO vaults(id,workspace_id,name,visibility,repository_path,created_by) SELECT $1,w.id,'Proposal Vault','restricted','/tmp/proposal-vault',m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id AND m.role='owner'")
        .bind(vault).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) SELECT workspace_id,$1,user_id,'manager' FROM workspace_memberships WHERE workspace_id=(SELECT id FROM workspaces LIMIT 1) AND role='owner'")
        .bind(vault).execute(&db).await.unwrap();
    let stale=client.post(&url).header(reqwest::header::COOKIE,&session.cookie).header("x-csrf-token",&session.csrf).json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[
        {"id":"new-task","kind":"task","project_id":project,"title":"New task","reason":"test","sources":[]},
        {"id":"stale-link","kind":"relation","relation":"related","source_task_id":existing["id"],"target_task_id":"new-task","expected_source_version":999,"reason":"test","sources":[]}
    ]})).send().await.unwrap();
    assert_eq!(
        stale.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY,
        "stale relation base versions are rejected"
    );
    let create = client.post(&url).header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf).json(&serde_json::json!({"scope":{"project_ids":[project],"vault_ids":[vault]},"items":[
        {"id":"task-a","kind":"task","project_id":project,"title":"Generated task","reason":"Mock plan","sources":["user request"]},
        {"id":"relation-a","kind":"relation","relation":"related","source_task_id":existing["id"],"target_task_id":"task-a","reason":"Connect work","sources":["user request"]},
        {"id":"skill-a","kind":"skill","skill_id":skill_id,"expected_version":1,"body":"Proposal updated Skill","reason":"Improve instructions","sources":["user request"]},
        {"id":"schema-a","kind":"schema","name":"Proposal field","value_type":"text","reason":"Track proposal data","sources":["user request"]},
        {"id":"note-a","kind":"note_edit","vault_id":vault,"path":"plan.md","content":"Proposed note","reason":"Document plan","sources":["user request"]},
        {"id":"file-a","kind":"file_add","vault_id":vault,"path":"plan.png","content_base64":"eA==","reason":"Attach plan","sources":["user request"]}
    ]})).send().await.unwrap();
    assert_eq!(create.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = create.json().await.unwrap();
    assert_eq!(proposal["schema_version"], 1);
    assert_eq!(proposal["revision"], 1);
    let id = proposal["id"].as_str().unwrap();
    let apply_url = format!("{origin}/api/v1/workspaces/{workspace}/proposals/{id}/approve");
    let approve = |key: &'static str| {
        client
            .post(&apply_url)
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .header("idempotency-key", key)
            .send()
    };
    let first_apply: serde_json::Value = approve("revision-1").await.unwrap().json().await.unwrap();
    assert_eq!(
        first_apply["created_tasks"].as_array().unwrap().len(),
        1,
        "note and file items validate but are not written to a Vault here"
    );
    assert_eq!(
        approve("revision-1")
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap(),
        first_apply,
        "retry returns the exact revision result"
    );
    let revised=client.patch(format!("{origin}/api/v1/workspaces/{workspace}/proposals/{id}")).header(reqwest::header::COOKIE,&session.cookie).header("x-csrf-token",&session.csrf).json(&serde_json::json!({"items":[{"id":"task-a","kind":"task","project_id":project,"title":"Generated task revised","reason":"Mock plan revised","sources":["user request"],"selected":true}]})).send().await.unwrap();
    assert_eq!(revised.status(), reqwest::StatusCode::OK);
    assert_eq!(
        revised.json::<serde_json::Value>().await.unwrap()["revision"],
        2
    );
    assert_eq!(
        client
            .get(format!(
                "{origin}/api/v1/workspaces/{workspace}/proposals/{id}"
            ))
            .header(reqwest::header::COOKIE, &session.cookie)
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap()["status"],
        "pending",
        "editing an applied Proposal requires a fresh approval"
    );
    assert_eq!(
        approve("revision-2").await.unwrap().status(),
        reqwest::StatusCode::OK
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tasks WHERE title LIKE 'Generated task%'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 2, "retries within a revision do not create duplicates, while a revised approved plan applies its new task");
    let undo = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{id}/undo"
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    let archived: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM tasks WHERE title LIKE 'Generated task%' AND archived_at IS NOT NULL",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        archived, 2,
        "undo archives every generated task in the Proposal group"
    );
    let restored_skill: serde_json::Value = client
        .get(format!(
            "{origin}/api/v1/workspaces/{workspace}/skills/{}",
            skill_id.as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        restored_skill["body"], original_skill["body"],
        "group undo restores Skill edits"
    );
    let schema_archived:bool=sqlx::query_scalar("SELECT archived_at IS NOT NULL FROM attribute_schemas WHERE workspace_id=(SELECT id FROM workspaces LIMIT 1) AND name='Proposal field'").fetch_one(&db).await.unwrap();
    assert!(
        schema_archived,
        "group undo archives generated schema items"
    );
    db.close().await;
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_scope_cycles_dependencies_and_session_approval_are_enforced() {
    let (origin, server, schema, admin, project, session) = fixture().await;
    let client = reqwest::Client::new();
    let workspace: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/me"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let workspace = workspace["workspaces"][0]["id"].as_str().unwrap();
    let base = format!("{origin}/api/v1/workspaces/{workspace}/proposals");
    let make = |body: serde_json::Value| {
        client
            .post(format!("{base}/mock"))
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&body)
    };
    let scope = serde_json::json!({"project_ids":[project]});
    let forbidden_vault = Uuid::new_v4();
    let vault_scope=make(serde_json::json!({"scope":{"project_ids":[project],"vault_ids":[forbidden_vault]},"items":[{"id":"note","kind":"note_edit","vault_id":forbidden_vault,"path":"note.md","content":"private","reason":"test","sources":[]}]})).send().await.unwrap();
    assert_eq!(
        vault_scope.status(),
        reqwest::StatusCode::FORBIDDEN,
        "Vault scope requires an explicit Vault membership"
    );
    let invalid_scope = make(serde_json::json!({"scope":scope,"items":[{"id":"outside","kind":"task","project_id":Uuid::new_v4(),"title":"Outside","reason":"test","sources":[]}]})).send().await.unwrap();
    assert_eq!(
        invalid_scope.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    let cycle = make(serde_json::json!({"scope":scope,"items":[
        {"id":"a","kind":"task","project_id":project,"title":"A","reason":"test","sources":[]},
        {"id":"b","kind":"task","project_id":project,"title":"B","reason":"test","sources":[]},
        {"id":"ab","kind":"relation","relation":"blocks","source_task_id":"a","target_task_id":"b","reason":"test","sources":[]},
        {"id":"ba","kind":"relation","relation":"blocks","source_task_id":"b","target_task_id":"a","reason":"test","sources":[]}
    ]})).send().await.unwrap();
    assert_eq!(cycle.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let created=make(serde_json::json!({"scope":scope,"items":[
        {"id":"first","kind":"task","project_id":project,"title":"First","reason":"test","sources":[]},
        {"id":"second","kind":"task","project_id":project,"title":"Second","reason":"test","sources":[],"depends_on":["first"]}
    ]})).send().await.unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = created.json().await.unwrap();
    let id = proposal["id"].as_str().unwrap();
    let proposal_url = format!("{base}/{id}");
    let toggled=client.patch(&proposal_url).header(reqwest::header::COOKIE,&session.cookie).header("x-csrf-token",&session.csrf).json(&serde_json::json!({"items":proposal["items"],"toggle":{"item_id":"first","selected":false}})).send().await.unwrap();
    assert_eq!(toggled.status(), reqwest::StatusCode::OK);
    let unticked: serde_json::Value = toggled.json().await.unwrap();
    assert_eq!(unticked["items"][0]["selected"], false);
    assert_eq!(
        unticked["items"][1]["selected"], false,
        "dependent item is unticked with prerequisite"
    );
    let reticked=client.patch(&proposal_url).header(reqwest::header::COOKIE,&session.cookie).header("x-csrf-token",&session.csrf).json(&serde_json::json!({"items":unticked["items"],"toggle":{"item_id":"second","selected":true}})).send().await.unwrap();
    assert_eq!(reticked.status(), reqwest::StatusCode::OK);
    let selected: serde_json::Value = reticked.json().await.unwrap();
    assert_eq!(
        selected["items"][0]["selected"], true,
        "prerequisite is re-added when dependent is ticked"
    );
    assert_eq!(selected["items"][1]["selected"], true);
    let unauth = client
        .post(format!("{proposal_url}/approve"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), reqwest::StatusCode::UNAUTHORIZED);
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_undo_conflict_applies_nothing_and_reports_the_changed_task() {
    let (origin, server, schema, admin, project, session) = fixture().await;
    let client = reqwest::Client::new();
    let me: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/me"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let workspace = me["workspaces"][0]["id"].as_str().unwrap();
    let base = format!("{origin}/api/v1/workspaces/{workspace}/proposals");
    let created=client.post(format!("{base}/mock")).header(reqwest::header::COOKIE,&session.cookie).header("x-csrf-token",&session.csrf).json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[{"id":"task","kind":"task","project_id":project,"title":"Conflict task","reason":"test","sources":[]}]})).send().await.unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = created.json().await.unwrap();
    let id = proposal["id"].as_str().unwrap();
    let approve = client
        .post(format!("{base}/{id}/approve"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "apply")
        .send()
        .await
        .unwrap();
    let applied: serde_json::Value = approve.json().await.unwrap();
    let number = applied["created_tasks"][0]["number"].as_i64().unwrap();
    let changed = client
        .patch(format!(
            "{origin}/api/v1/workspaces/{workspace}/tasks/{number}"
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"expected_version":1,"title":"Changed after approval"}))
        .send()
        .await
        .unwrap();
    assert_eq!(changed.status(), reqwest::StatusCode::OK);
    let undo = client
        .post(format!("{base}/{id}/undo"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::CONFLICT);
    let detail: serde_json::Value = undo.json().await.unwrap();
    assert_eq!(detail["applied"], false);
    assert_eq!(detail["conflicts"][0]["reason"], "task_changed_or_missing");
    let task = client
        .get(format!(
            "{origin}/api/v1/workspaces/{workspace}/tasks/{number}"
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(task.status(), reqwest::StatusCode::OK);
    assert_eq!(
        task.json::<serde_json::Value>().await.unwrap()["title"],
        "Changed after approval",
        "a conflict leaves the whole Proposal untouched"
    );
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
