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
    let response = call(
        &f,
        &f.owner,
        reqwest::Method::PATCH,
        &format!("/tasks/{id}"),
    )
    .json(&json!({"expected_version":source["version"],"description":format!("desc {REF}")}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    // The viewer-side Contributor writes with a stale version.
    let response = call(
        &f,
        &f.viewer,
        reqwest::Method::PATCH,
        &format!("/tasks/{id}"),
    )
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
    let first = task(
        &f,
        open,
        json!({"title":"Quarterly report draft","description":"**bold**"}),
    )
    .await;
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
    let (status, body) = text_of(
        &f,
        &f.owner,
        &format!("/workspaces/{}/lists/{list_id}", f.workspace),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let parsed: Value = serde_json::from_str(&body).unwrap();
    let tasks = parsed["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2, "{body}");
    for t in tasks {
        assert!(
            t.get("similar_tasks").is_none(),
            "list carries duplicate hints: {t}"
        );
        assert!(
            t.get("description_html").is_none(),
            "list renders Markdown: {t}"
        );
        assert!(t["description"].is_string());
    }
    // The single-Task read keeps both.
    let (status, body) = text_of(
        &f,
        &f.owner,
        &format!("/workspaces/{}/tasks/{}", f.workspace, second["number"]),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let single: Value = serde_json::from_str(&body).unwrap();
    assert!(single["description_html"].is_string(), "{body}");
    assert_eq!(
        single["similar_tasks"].as_array().unwrap().len(),
        1,
        "{body}"
    );
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn m8_snapshot_readable_set_follows_visibility_memberships_teams_and_archive() {
    let f = fixture().await;
    let open = project(&f, "Open", "workspace", &[(&f.owner, "manager")]).await;
    let hidden = project(&f, "Hidden", "restricted", &[(&f.owner, "manager")]).await;
    let direct = project(
        &f,
        "Direct",
        "restricted",
        &[(&f.owner, "manager"), (&f.viewer, "viewer")],
    )
    .await;
    let by_team = project(&f, "ByTeam", "restricted", &[(&f.owner, "manager")]).await;
    let archived = project(&f, "Archived", "workspace", &[(&f.owner, "manager")]).await;
    let team = Uuid::new_v4();
    sqlx::query("INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,'Crew')")
        .bind(team)
        .bind(f.workspace)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO team_memberships(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
        .bind(f.workspace)
        .bind(team)
        .bind(f.viewer.id)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_team_memberships(workspace_id,project_id,team_id,role) VALUES($1,$2,$3,'contributor')")
        .bind(f.workspace).bind(by_team).bind(team).execute(&f.db).await.unwrap();
    let mut expected = Vec::new();
    let mut unexpected = Vec::new();
    for (name, p, visible) in [
        ("open", open, true),
        ("hidden", hidden, false),
        ("direct", direct, true),
        ("by_team", by_team, true),
        ("archived", archived, false),
    ] {
        let t = task(&f, p, json!({"title":name})).await;
        if visible {
            expected.push(t["id"].as_str().unwrap().to_owned())
        } else {
            unexpected.push(t["id"].as_str().unwrap().to_owned())
        }
    }
    sqlx::query("UPDATE projects SET archived_at=now() WHERE id=$1")
        .bind(archived)
        .execute(&f.db)
        .await
        .unwrap();
    let (status, body) = text_of(
        &f,
        &f.viewer,
        &format!("/workspaces/{}/realtime/snapshot", f.workspace),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let parsed: Value = serde_json::from_str(&body).unwrap();
    let mut got: Vec<String> = parsed["visible_task_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    got.sort();
    expected.sort();
    assert_eq!(got, expected, "{body}");
    assert!(unexpected.iter().all(|id| !got.contains(id)));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn m9_exports_are_post_only_and_a_get_writes_no_audit_row() {
    let f = fixture().await;
    let audits = |event: &'static str| {
        let db = f.db.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM security_audit_events WHERE event=$1",
            )
            .bind(event)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    let path = format!("/workspaces/{}/export", f.workspace);
    let (status, _) = text_of(&f, &f.owner, &path).await;
    assert_eq!(status, 405, "a GET must not export");
    assert_eq!(
        audits("workspace.export").await,
        0,
        "a GET wrote an audit row"
    );
    // A cross-site form post carries the session cookie but no CSRF header.
    let forged = reqwest::Client::new()
        .post(format!("{}/api/v1{path}", f.origin))
        .header(reqwest::header::COOKIE, &f.owner.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status(), 403);
    assert_eq!(audits("workspace.export").await, 0);
    let response = call(&f, &f.owner, reqwest::Method::POST, &path)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let exported: Value = response.json().await.unwrap();
    assert_eq!(exported["schema_version"], "1.0");
    assert_eq!(audits("workspace.export").await, 1);
    cleanup(f).await;
}

async fn comment(f: &Fixture, who: &Who, task_id: &str, body: &str) -> String {
    let (status, created) = post(
        f,
        who,
        &format!("/tasks/{task_id}/comments"),
        json!({"request_id":Uuid::new_v4(),"body":body}),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    created["id"].as_str().unwrap().to_owned()
}

async fn attach(
    f: &Fixture,
    who: &Who,
    task_id: &str,
    comment_id: &str,
    bytes: &[u8],
    content_type: &str,
) -> (reqwest::StatusCode, Value) {
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    post(
        f,
        who,
        &format!("/tasks/{task_id}/comments/{comment_id}/attachments"),
        json!({"file_name":"a.bin","content_type":content_type,"content_hex":hex}),
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn m10_only_the_comment_author_or_a_manager_attaches_and_quotas_apply() {
    let f = fixture().await;
    let open = project(
        &f,
        "Open",
        "workspace",
        &[(&f.owner, "manager"), (&f.viewer, "contributor")],
    )
    .await;
    let t = task(&f, open, json!({"title":"T"})).await;
    let task_id = t["id"].as_str().unwrap();
    let owners = comment(&f, &f.owner, task_id, "mine").await;
    let viewers = comment(&f, &f.viewer, task_id, "theirs").await;

    // Another writer cannot attach to someone else's comment.
    let (status, _) = attach(&f, &f.viewer, task_id, &owners, b"x", "text/plain").await;
    assert_eq!(status, 403);
    // The author can; a Project Manager can attach to anyone's comment.
    let (status, _) = attach(&f, &f.viewer, task_id, &viewers, b"x", "text/plain").await;
    assert_eq!(status, 201);
    let (status, _) = attach(&f, &f.owner, task_id, &viewers, b"x", "text/plain").await;
    assert_eq!(status, 201);

    // Per-comment count quota: ten attachments, the next one is refused.
    for _ in 0..8 {
        let (status, _) = attach(&f, &f.owner, task_id, &viewers, b"x", "text/plain").await;
        assert_eq!(status, 201);
    }
    let (status, body) = attach(&f, &f.owner, task_id, &viewers, b"x", "text/plain").await;
    assert_eq!(status, 413, "{body}");

    // Per-Task byte quota: existing attachments fill the Task, so even one small file is refused.
    sqlx::query("INSERT INTO task_attachments(id,workspace_id,task_id,uploaded_by,file_name,content_type,content,comment_id,storage_key) SELECT gen_random_uuid(),workspace_id,$1,$2,'big','text/plain',convert_to(repeat('a',10000000),'UTF8'),$3,gen_random_uuid() FROM tasks, generate_series(1,7) WHERE id=$1")
        .bind(Uuid::parse_str(task_id).unwrap()).bind(f.owner.id).bind(Uuid::parse_str(&owners).unwrap())
        .execute(&f.db).await.unwrap();
    let (status, body) = attach(&f, &f.owner, task_id, &owners, b"x", "text/plain").await;
    assert_eq!(status, 413, "{body}");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn m10_pdf_previews_are_sandboxed() {
    let f = fixture().await;
    let open = project(&f, "Open", "workspace", &[(&f.owner, "manager")]).await;
    let t = task(&f, open, json!({"title":"T"})).await;
    let task_id = t["id"].as_str().unwrap();
    let c = comment(&f, &f.owner, task_id, "pdf").await;
    let (status, created) = attach(
        &f,
        &f.owner,
        task_id,
        &c,
        b"%PDF-1.4 test",
        "application/pdf",
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let response = call(
        &f,
        &f.owner,
        reqwest::Method::GET,
        created["preview_url"]
            .as_str()
            .unwrap()
            .trim_start_matches("/api/v1"),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let csp = response
        .headers()
        .get("content-security-policy")
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default();
    assert!(csp.contains("sandbox"), "csp: {csp:?}");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn nit_task_title_markdown_cannot_become_a_link_in_a_reference_chip() {
    let f = fixture().await;
    let open = project(&f, "Open", "workspace", &[(&f.owner, "manager")]).await;
    let target = task(&f, open, json!({"title":"[x](https://evil.example/p) *b*"})).await;
    let source = task(&f, open, json!({"title":"Source"})).await;
    let response = call(&f, &f.owner, reqwest::Method::PATCH, &format!("/tasks/{}", source["id"].as_str().unwrap()))
        .json(&json!({"expected_version":source["version"],"description":format!("see #{}", target["number"])}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let (_, body) = text_of(
        &f,
        &f.owner,
        &format!("/workspaces/{}/tasks/{}", f.workspace, source["number"]),
    )
    .await;
    let parsed: Value = serde_json::from_str(&body).unwrap();
    let html = parsed["description_html"].as_str().unwrap();
    assert!(html.contains("data-task-reference"), "{html}");
    assert!(
        !html.contains("evil.example\""),
        "chip label became a link: {html}"
    );
    assert!(!html.contains("<em>"), "{html}");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn nit_create_task_from_comment_is_idempotent_per_request_id() {
    let f = fixture().await;
    let open = project(&f, "Open", "workspace", &[(&f.owner, "manager")]).await;
    let t = task(&f, open, json!({"title":"Source"})).await;
    let task_id = t["id"].as_str().unwrap();
    let c = comment(&f, &f.owner, task_id, "make a task").await;
    let request_id = Uuid::new_v4();
    let body =
        json!({"project_id":open,"title":"From comment","description":"d","request_id":request_id});
    let (first_status, first) = post(
        &f,
        &f.owner,
        &format!("/tasks/{task_id}/comments/{c}/create-task"),
        body.clone(),
    )
    .await;
    assert_eq!(first_status, 201, "{first}");
    let (second_status, second) = post(
        &f,
        &f.owner,
        &format!("/tasks/{task_id}/comments/{c}/create-task"),
        body,
    )
    .await;
    assert!(second_status.is_success(), "{second}");
    assert_eq!(second["id"], first["id"], "a retry created a second Task");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE title='From comment'")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_attachment_uploads_never_exceed_the_per_comment_quota() {
    let f = fixture().await;
    let open = project(&f, "Open", "workspace", &[(&f.owner, "manager")]).await;
    let t = task(&f, open, json!({"title":"T"})).await;
    let task_id = t["id"].as_str().unwrap().to_owned();
    let c = comment(&f, &f.owner, &task_id, "race").await;
    let uploads = (0..24).map(|_| attach(&f, &f.owner, &task_id, &c, b"x", "text/plain"));
    let results = futures_util::future::join_all(uploads).await;
    let created = results.iter().filter(|(status, _)| *status == 201).count();
    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM task_attachments WHERE comment_id=$1")
            .bind(Uuid::parse_str(&c).unwrap())
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(stored, 10, "per-comment cap broken: {stored} stored");
    assert_eq!(created, 10);
    assert!(results
        .iter()
        .all(|(status, _)| *status == 201 || *status == 413));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_attachment_uploads_never_exceed_the_per_task_byte_quota() {
    let f = fixture().await;
    let open = project(&f, "Open", "workspace", &[(&f.owner, "manager")]).await;
    let t = task(&f, open, json!({"title":"T"})).await;
    let task_id = t["id"].as_str().unwrap().to_owned();
    // Eight comments with one 9 MB file each would be 72 MB: only seven fit under 64 MB.
    let mut comments = Vec::new();
    for i in 0..8 {
        comments.push(comment(&f, &f.owner, &task_id, &format!("c{i}")).await);
    }
    let big = vec![b'a'; 9 * 1024 * 1024];
    let uploads = comments
        .iter()
        .map(|c| attach(&f, &f.owner, &task_id, c, &big, "text/plain"));
    let results = futures_util::future::join_all(uploads).await;
    let total: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(octet_length(content)),0)::bigint FROM task_attachments WHERE task_id=$1",
    )
    .bind(Uuid::parse_str(&task_id).unwrap())
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert!(
        total <= 64 * 1024 * 1024,
        "per-task cap broken: {total} bytes stored"
    );
    assert_eq!(results.iter().filter(|(s, _)| *s == 201).count(), 7);
    cleanup(f).await;
}

/// Returns (restricted source Project B, restricted target Project A, source task id, comment id)
/// with the viewer a Contributor on both.
async fn replay_fixture(f: &Fixture) -> (Uuid, Uuid, String, String) {
    let b = project(
        f,
        "B",
        "restricted",
        &[(&f.owner, "manager"), (&f.viewer, "contributor")],
    )
    .await;
    let a = project(
        f,
        "A",
        "restricted",
        &[(&f.owner, "manager"), (&f.viewer, "contributor")],
    )
    .await;
    let t = task(f, b, json!({"title":"Source"})).await;
    let task_id = t["id"].as_str().unwrap().to_owned();
    let c = comment(f, &f.viewer, &task_id, "make a task").await;
    (b, a, task_id, c)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replayed_create_task_cannot_read_back_a_task_in_a_project_the_creator_lost() {
    let f = fixture().await;
    let (b, a, task_id, c) = replay_fixture(&f).await;
    let request_id = Uuid::new_v4();
    let path = format!("/tasks/{task_id}/comments/{c}/create-task");
    let (status, first) = post(
        &f,
        &f.viewer,
        &path,
        json!({"project_id":a,"title":"Secret plan","description":"d","request_id":request_id}),
    )
    .await;
    assert_eq!(status, 201, "{first}");
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(a)
        .bind(f.viewer.id)
        .execute(&f.db)
        .await
        .unwrap();
    // Replay against the Project the creator can still write: it must not return Project A's Task.
    let (status, body) = post(
        &f,
        &f.viewer,
        &path,
        json!({"project_id":b,"title":"Secret plan","description":"d","request_id":request_id}),
    )
    .await;
    assert_eq!(status, 404, "{body}");
    assert!(!body.to_string().contains("Secret plan"), "{body}");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replay_with_a_different_project_conflicts_and_an_archived_task_is_gone() {
    let f = fixture().await;
    let (b, a, task_id, c) = replay_fixture(&f).await;
    let request_id = Uuid::new_v4();
    let path = format!("/tasks/{task_id}/comments/{c}/create-task");
    let body = |project: Uuid| json!({"project_id":project,"title":"Plan","description":"d","request_id":request_id});
    let (status, first) = post(&f, &f.viewer, &path, body(a)).await;
    assert_eq!(status, 201, "{first}");
    let (status, replay) = post(&f, &f.viewer, &path, body(a)).await;
    assert_eq!(status, 200, "{replay}");
    let (status, other) = post(&f, &f.viewer, &path, body(b)).await;
    assert_eq!(status, 409, "{other}");
    sqlx::query("UPDATE tasks SET archived_at=now() WHERE id=$1")
        .bind(Uuid::parse_str(first["id"].as_str().unwrap()).unwrap())
        .execute(&f.db)
        .await
        .unwrap();
    let (status, gone) = post(&f, &f.viewer, &path, body(a)).await;
    assert_eq!(status, 410, "{gone}");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reference_chip_label_never_autolinks_inside_the_chip() {
    let f = fixture().await;
    let open = project(&f, "Open", "workspace", &[(&f.owner, "manager")]).await;
    let target = task(
        &f,
        open,
        json!({"title":"www.x.com a@b.co https://y.example"}),
    )
    .await;
    let source = task(&f, open, json!({"title":"Source"})).await;
    let source_id = source["id"].as_str().unwrap();
    let c = comment(
        &f,
        &f.owner,
        source_id,
        &format!("see #{}", target["number"]),
    )
    .await;
    let (status, listed) = text_of(&f, &f.owner, &format!("/tasks/{source_id}/comments")).await;
    assert_eq!(status, 200, "{listed}");
    let listed: Value = serde_json::from_str(&listed).unwrap();
    let html = listed["comments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == c.as_str())
        .unwrap()["html"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        html.matches("<a ").count(),
        1,
        "the label autolinked: {html}"
    );
    assert!(
        !html.contains("mailto:") && !html.contains("href=\"http"),
        "{html}"
    );
    assert!(
        html.contains("www.x.com a@b.co"),
        "the label text is intact: {html}"
    );
    cleanup(f).await;
}
