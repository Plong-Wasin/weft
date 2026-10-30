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

async fn member_session(db: &sqlx::PgPool, workspace: Uuid, role: &str) -> (Uuid, Session) {
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(user)
        .bind(format!("{}@example.com", Uuid::new_v4()))
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(user)
        .bind(role)
        .execute(db)
        .await
        .unwrap();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4())
        .bind(user)
        .bind(hash)
        .bind(&csrf)
        .execute(db)
        .await
        .unwrap();
    (
        user,
        Session {
            cookie: format!("weft_session={token}; weft_csrf={csrf}"),
            csrf,
        },
    )
}

fn git(repo: &std::path::Path, args: &[&str]) {
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .status()
        .unwrap()
        .success());
}

async fn call(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    who: &Session,
    body: serde_json::Value,
) -> reqwest::Response {
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf)
        .header("idempotency-key", Uuid::new_v4().to_string())
        .json(&body)
        .send()
        .await
        .unwrap()
}

async fn inbox_body(origin: &str, workspace: Uuid, who: &Session) -> String {
    reqwest::Client::new()
        .get(format!("{origin}/api/v1/workspaces/{workspace}/inbox"))
        .header(reqwest::header::COOKIE, &who.cookie)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
}

// ADR-0006: a Knowledge change (apply or undo) notifies no one. Watchers of a Task, Vault
// members and people outside the Vault all keep an unchanged Inbox, and the Inbox never
// carries the note path or text.
#[tokio::test(flavor = "multi_thread")]
async fn knowledge_apply_and_undo_notify_no_one_and_leak_nothing() {
    let (origin, server, schema, admin, project, owner) = fixture().await;
    let client = reqwest::Client::new();
    let db = sqlx::PgPool::connect(&format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    ))
    .await
    .unwrap();
    let workspace: Uuid = sqlx::query_scalar("SELECT id FROM workspaces")
        .fetch_one(&db)
        .await
        .unwrap();
    let (reader, reader_session) = member_session(&db, workspace, "member").await;
    let (_outsider, outsider_session) = member_session(&db, workspace, "member").await;

    let vault = Uuid::new_v4();
    let repo = env::temp_dir().join(format!("weft-knote-{vault}.git"));
    assert!(std::process::Command::new("git")
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&repo)
        .status()
        .unwrap()
        .success());
    let work = env::temp_dir().join(format!("weft-knote-work-{vault}"));
    assert!(std::process::Command::new("git")
        .arg("clone")
        .arg(&repo)
        .arg(&work)
        .status()
        .unwrap()
        .success());
    std::fs::write(work.join("secret-plan.md"), "Initial\n").unwrap();
    git(&work, &["config", "user.name", "Test"]);
    git(&work, &["config", "user.email", "test@example.com"]);
    git(&work, &["add", "."]);
    git(&work, &["commit", "-m", "initial"]);
    git(&work, &["push", "origin", "main"]);
    sqlx::query("INSERT INTO vaults(id,workspace_id,name,visibility,repository_path,created_by) VALUES($1,$2,'Hidden Vault','restricted',$3,(SELECT user_id FROM workspace_memberships WHERE workspace_id=$2 AND role='owner' LIMIT 1))")
        .bind(vault).bind(workspace).bind(repo.to_string_lossy().as_ref()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) SELECT workspace_id,$1,user_id,'manager' FROM workspace_memberships WHERE workspace_id=$2 AND role='owner'")
        .bind(vault).bind(workspace).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) VALUES($1,$2,$3,'viewer')")
        .bind(workspace).bind(vault).bind(reader).execute(&db).await.unwrap();

    // Both members watch a Task of a workspace-visible Project; the Task is unrelated to the note.
    let task: serde_json::Value = call(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &owner,
        serde_json::json!({"project_id":project,"title":"Watched task"}),
    )
    .await
    .json()
    .await
    .unwrap();
    for who in [&reader_session, &outsider_session] {
        let watch = call(
            &client,
            reqwest::Method::PUT,
            format!("{origin}/api/v1/tasks/{}/watch", task["id"].as_str().unwrap()),
            who,
            serde_json::json!({"watching":true,"events":["updated","comment","reply","mention","assignment"]}),
        )
        .await;
        assert!(watch.status().is_success(), "{}", watch.status());
    }
    let count = |db: sqlx::PgPool| async move {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notification_intents")
            .fetch_one(&db)
            .await
            .unwrap()
    };
    let baseline = count(db.clone()).await;

    let proposal: serde_json::Value = call(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"),
        &owner,
        serde_json::json!({"scope":{"project_ids":[project],"vault_ids":[vault]},"items":[{"id":"edit","kind":"note_edit","vault_id":vault,"path":"secret-plan.md","content":"Launch codename Bluebird\n","reason":"test","sources":[]}]}),
    )
    .await
    .json()
    .await
    .unwrap();
    let id = proposal["id"].as_str().unwrap();
    let approve = call(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/proposals/{id}/approve"),
        &owner,
        serde_json::json!({"revision":1}),
    )
    .await;
    assert!(approve.status().is_success(), "{}", approve.status());
    assert_eq!(count(db.clone()).await, baseline, "apply notifies no one");

    let undo = call(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/proposals/{id}/undo"),
        &owner,
        serde_json::json!({}),
    )
    .await;
    assert!(undo.status().is_success(), "{}", undo.status());
    assert_eq!(count(db.clone()).await, baseline, "undo notifies no one");

    for who in [&owner, &reader_session, &outsider_session] {
        let body = inbox_body(&origin, workspace, who).await;
        for secret in ["secret-plan", "Bluebird", "Hidden Vault"] {
            assert!(!body.contains(secret), "inbox leaks {secret}: {body}");
        }
    }
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}
