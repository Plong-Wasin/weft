//! Review-fix regressions (list E): leaks, performance, uploads.
#![allow(dead_code)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, path::Path, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

const PARSER_VERSION: &str = "comrak-0.59-index-1";

struct Who {
    id: Uuid,
    cookie: String,
    csrf: String,
}

struct Fixture {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    scoped: String,
    admin: sqlx::PgPool,
    db: sqlx::PgPool,
    workspace: Uuid,
    owner: Who,
    viewer: Who,
    connection: Uuid,
    root: std::path::PathBuf,
}

async fn session(db: &sqlx::PgPool, user: Uuid) -> Who {
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(user).bind(hash).bind(&csrf).execute(db).await.unwrap();
    Who {
        id: user,
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

async fn fixture() -> Fixture {
    env::set_var(
        "WEFT_AGENT_SIGNING_KEY",
        "runner-test-signing-key-012345678901234567890123456789",
    );
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("collab_gate_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let scoped = format!("{base}?options=-csearch_path%3D{schema}");
    let root = env::temp_dir().join(format!("weft-{schema}"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("index.html"), "Weft").unwrap();
    let (server, origin) = start(&scoped, &root).await;
    let db = sqlx::PgPool::connect(&scoped).await.unwrap();
    weft_server::bootstrap_admin(&db, "owner@example.com", "secret", "Workspace")
        .await
        .unwrap();
    let (workspace, owner_id): (Uuid, Uuid) = sqlx::query_as(
        "SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let viewer_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'viewer@example.com','unused')",
    )
    .bind(viewer_id)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(viewer_id)
    .execute(&db)
    .await
    .unwrap();
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) VALUES($1,'workspace',$2,'scripted','provider_cli','api','ready','ready',$3)")
        .bind(connection).bind(workspace).bind(owner_id).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO ai_connection_grants(connection_id,workspace_id) VALUES($1,$2)")
        .bind(connection)
        .bind(workspace)
        .execute(&db)
        .await
        .unwrap();
    let owner = session(&db, owner_id).await;
    let viewer = session(&db, viewer_id).await;
    Fixture {
        origin,
        server,
        schema,
        scoped,
        admin,
        db,
        workspace,
        owner,
        viewer,
        connection,
        root,
    }
}

async fn start(scoped: &str, root: &Path) -> (tokio::task::JoinHandle<()>, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    let (db, root) = (scoped.to_owned(), root.to_owned());
    let server = tokio::spawn(async move {
        let _ = serve(listener, ServerConfig::new(db, root)).await;
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
    (server, origin)
}

async fn cleanup(f: Fixture) {
    f.server.abort();
    f.db.close().await;
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&f.admin)
        .await
        .unwrap();
    f.admin.close().await;
    let _ = std::fs::remove_dir_all(&f.root);
}

fn call(f: &Fixture, who: &Who, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(method, format!("{}/api/v1{path}", f.origin))
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf)
        .header("idempotency-key", Uuid::new_v4().to_string())
}

async fn text_of(f: &Fixture, who: &Who, path: &str) -> (reqwest::StatusCode, String) {
    let response = call(f, who, reqwest::Method::GET, path)
        .send()
        .await
        .unwrap();
    (response.status(), response.text().await.unwrap())
}

async fn post(f: &Fixture, who: &Who, path: &str, body: Value) -> (reqwest::StatusCode, Value) {
    let response = call(f, who, reqwest::Method::POST, path)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

async fn project(f: &Fixture, name: &str, visibility: &str, members: &[(&Who, &str)]) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(f.workspace)
    .bind(name)
    .bind(visibility)
    .bind(f.owner.id)
    .execute(&f.db)
    .await
    .unwrap();
    for (who, role) in members {
        sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,$4)")
            .bind(f.workspace).bind(id).bind(who.id).bind(*role).execute(&f.db).await.unwrap();
    }
    id
}

async fn task(f: &Fixture, project: Uuid, body: Value) -> Value {
    let mut body = body;
    body["project_id"] = json!(project);
    let (status, created) = post(
        f,
        &f.owner,
        &format!("/workspaces/{}/tasks", f.workspace),
        body,
    )
    .await;
    assert_eq!(status, 201, "{created}");
    created
}

fn git(repo: &Path, args: &[&str]) {
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .status()
        .unwrap()
        .success());
}

/// A bare Vault repository with one note on `main` and a working clone, indexed for search.
struct Vault {
    id: Uuid,
    repo: std::path::PathBuf,
    work: std::path::PathBuf,
}

async fn vault(f: &Fixture, name: &str, note: &str, text: &str, members: &[(&Who, &str)]) -> Vault {
    let id = Uuid::new_v4();
    let repo = env::temp_dir().join(format!("weft-gate-{id}.git"));
    let work = env::temp_dir().join(format!("weft-gate-work-{id}"));
    assert!(std::process::Command::new("git")
        .args(["init", "-q", "--bare", "--initial-branch=main"])
        .arg(&repo)
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .args(["clone", "-q"])
        .arg(&repo)
        .arg(&work)
        .status()
        .unwrap()
        .success());
    std::fs::create_dir_all(work.join(note).parent().unwrap()).unwrap();
    std::fs::write(work.join(note), text).unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-q", "-m", "seed"]);
    git(&work, &["push", "-q", "origin", "main"]);
    sqlx::query("INSERT INTO vaults(id,workspace_id,name,visibility,repository_path,created_by) VALUES($1,$2,$3,'restricted',$4,$5)")
        .bind(id).bind(f.workspace).bind(name).bind(repo.display().to_string()).bind(f.owner.id).execute(&f.db).await.unwrap();
    for (who, role) in members {
        sqlx::query("INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) VALUES($1,$2,$3,$4)")
            .bind(f.workspace).bind(id).bind(who.id).bind(*role).execute(&f.db).await.unwrap();
    }
    sqlx::query("INSERT INTO vault_indexed_files(vault_id,path,text_content,title,search_text,parser_version) VALUES($1,$2,$3,$4,$3,$5)")
        .bind(id).bind(note).bind(text).bind(note.rsplit('/').next().unwrap().trim_end_matches(".md")).bind(PARSER_VERSION).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO vault_note_identities(id,vault_id,path) VALUES($1,$2,$3)")
        .bind(Uuid::new_v4())
        .bind(id)
        .bind(note)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO vault_search_states(vault_id,status,parser_version) VALUES($1,'ready',$2)",
    )
    .bind(id)
    .bind(PARSER_VERSION)
    .execute(&f.db)
    .await
    .unwrap();
    Vault { id, repo, work }
}

fn assert_clean(label: &str, body: &str, secrets: &[&str]) {
    for secret in secrets {
        assert!(!body.contains(secret), "{label} leaks {secret}: {body}");
    }
}

const SECRETS: [&str; 6] = [
    "LEAK-TASK-BODY",
    "LEAK-COMMENT-BODY",
    "LEAK-NOTE-BODY",
    "Payroll plan",
    "Secrets Vault",
    "Hidden Plan",
];

/// What a resolved reference would add; the author's own typed text is readable by anyone who reads the source.
const CONTENT: [&str; 4] = [
    "LEAK-TASK-BODY",
    "LEAK-COMMENT-BODY",
    "LEAK-NOTE-BODY",
    "Payroll plan",
];

fn assert_neutral(label: &str, body: &str) {
    for chip in [
        "Hidden Plan · Secrets Vault",
        "data-task-reference",
        "data-note-reference",
        "note deleted",
    ] {
        assert!(
            !body.contains(chip),
            "{label} resolves a hidden reference ({chip}): {body}"
        );
    }
}

const REF: &str = "[[Secrets Vault/Secrets/Hidden Plan.md]]";

#[tokio::test(flavor = "multi_thread")]
async fn m3_version_conflict_body_redacts_note_references_for_the_caller() {
    let f = fixture().await;
    let open = project(
        &f,
        "Open",
        "workspace",
        &[(&f.owner, "manager"), (&f.viewer, "contributor")],
    )
    .await;
    let secret_vault = vault(
        &f,
        "Secrets Vault",
        "Secrets/Hidden Plan.md",
        "# Hidden Plan\n\nbody\n",
        &[(&f.owner, "manager")],
    )
    .await;
    let source = task(&f, open, json!({"title":"Source"})).await;
    let id = source["id"].as_str().unwrap();
    let response = call(&f, &f.owner, reqwest::Method::PATCH, &format!("/tasks/{id}"))
        .json(&json!({"expected_version":source["version"],"description":format!("desc {REF}")}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    // The viewer-side Contributor writes with a stale version.
    let response = call(&f, &f.viewer, reqwest::Method::PATCH, &format!("/tasks/{id}"))
        .json(&json!({"expected_version":source["version"],"title":"Mine"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409);
    let body = response.text().await.unwrap();
    assert!(body.contains("version_conflict"), "{body}");
    for secret in ["Secrets Vault", "Hidden Plan"] {
        assert!(!body.contains(secret), "409 body leaks {secret}: {body}");
    }
    for path in [secret_vault.repo.clone(), secret_vault.work.clone()] {
        let _ = std::fs::remove_dir_all(path);
    }
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn m7_list_and_my_work_responses_skip_per_task_hints_and_rendered_html() {
    let f = fixture().await;
    let open = project(&f, "Open", "workspace", &[(&f.owner, "manager")]).await;
    let first = task(&f, open, json!({"title":"Quarterly report draft","description":"**bold**"})).await;
    let second = task(&f, open, json!({"title":"Quarterly report draft two"})).await;
    let (status, list) = post(
        &f,
        &f.owner,
        &format!("/workspaces/{}/lists", f.workspace),
        json!({"name":"Shared"}),
    )
    .await;
    assert_eq!(status, 201, "{list}");
    let list_id = list["id"].as_str().unwrap();
    for t in [&first, &second] {
        let (status, _) = post(
            &f,
            &f.owner,
            &format!("/lists/{list_id}/tasks"),
            json!({"task_id":t["id"],"request_id":Uuid::new_v4()}),
        )
        .await;
        assert!(status.is_success());
    }
    let (status, body) = text_of(&f, &f.owner, &format!("/workspaces/{}/lists/{list_id}", f.workspace)).await;
    assert_eq!(status, 200, "{body}");
    let parsed: Value = serde_json::from_str(&body).unwrap();
    let tasks = parsed["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2, "{body}");
    for t in tasks {
        assert!(t.get("similar_tasks").is_none(), "list carries duplicate hints: {t}");
        assert!(t.get("description_html").is_none(), "list renders Markdown: {t}");
        assert_eq!(t["description"].is_string(), true);
    }
    // The single-Task read keeps both.
    let (status, body) = text_of(&f, &f.owner, &format!("/workspaces/{}/tasks/{}", f.workspace, second["number"])).await;
    assert_eq!(status, 200, "{body}");
    let single: Value = serde_json::from_str(&body).unwrap();
    assert!(single["description_html"].is_string(), "{body}");
    assert_eq!(single["similar_tasks"].as_array().unwrap().len(), 1, "{body}");
    cleanup(f).await;
}
