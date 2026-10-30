//! Collaboration exit gate: no surface leaks a Restricted source, revoking access mid-run makes AI
//! tools and Apply refuse, a stuck Apply is never silent, and release names stay out of the product.
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

#[tokio::test(flavor = "multi_thread")]
async fn no_surface_leaks_a_restricted_task_or_a_note_in_a_restricted_vault() {
    let f = fixture().await;
    let open = project(
        &f,
        "Open",
        "workspace",
        &[(&f.owner, "manager"), (&f.viewer, "viewer")],
    )
    .await;
    let hidden_project = project(&f, "Payroll", "restricted", &[(&f.owner, "manager")]).await;
    let secret_vault = vault(
        &f,
        "Secrets Vault",
        "Secrets/Hidden Plan.md",
        "# Hidden Plan\n\nLEAK-NOTE-BODY\n",
        &[(&f.owner, "manager")],
    )
    .await;
    let hidden = task(
        &f,
        hidden_project,
        json!({"title":"Payroll plan","description":"LEAK-TASK-BODY"}),
    )
    .await;
    let hidden_id = hidden["id"].as_str().unwrap();
    // The viewer was assigned and mentioned there before the Task moved out of their reach.
    for reason in ["assigned", "mentioned"] {
        sqlx::query("INSERT INTO notification_intents(id,workspace_id,task_id,recipient_id,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(Uuid::new_v4()).bind(f.workspace).bind(hidden["id"].as_str().unwrap().parse::<Uuid>().unwrap()).bind(f.viewer.id).bind(f.owner.id).bind(reason)
            .execute(&f.db).await.unwrap();
    }
    let (status, _) = post(
        &f,
        &f.owner,
        &format!("/tasks/{hidden_id}/comments"),
        json!({"request_id":Uuid::new_v4(),"body":"LEAK-COMMENT-BODY @viewer@example.com"}),
    )
    .await;
    assert_eq!(status, 201);
    // A readable Task points at the hidden Task and at the hidden note.
    let source = task(
        &f,
        open,
        json!({"title":"Open source task","description":format!("see #{} and [[Secrets Vault/Secrets/Hidden Plan.md]]", hidden["number"])}),
    )
    .await;
    let source_id = source["id"].as_str().unwrap();
    let (status, _) = post(
        &f,
        &f.owner,
        &format!("/tasks/{source_id}/comments"),
        json!({"request_id":Uuid::new_v4(),"body":format!("again #{} [[Secrets Vault/Secrets/Hidden Plan.md]]", hidden["number"])}),
    )
    .await;
    assert_eq!(status, 201);

    let who = &f.viewer;
    let ws = f.workspace;
    // References: the readable source renders neutral text, the hidden Task has no backlinks to read.
    let (status, body) = text_of(
        &f,
        who,
        &format!("/workspaces/{ws}/tasks/{}", source["number"]),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_clean("source task", &body, &CONTENT);
    assert_neutral("source task", &body);
    let (_, body) = text_of(&f, who, &format!("/tasks/{source_id}/comments")).await;
    assert_clean("source comments", &body, &CONTENT);
    assert_neutral("source comments", &body);
    let (_, body) = text_of(&f, who, &format!("/tasks/{source_id}/references")).await;
    assert_clean("source references", &body, &CONTENT);
    assert_neutral("source references", &body);
    for path in [
        format!("/workspaces/{ws}/tasks/{}", hidden["number"]),
        format!("/tasks/{hidden_id}/references"),
        format!("/tasks/{hidden_id}/comments"),
        format!("/tasks/{hidden_id}/history"),
    ] {
        let (status, body) = text_of(&f, who, &path).await;
        assert!(status == 404 || status == 403, "{path} -> {status}");
        assert_clean(&path, &body, &SECRETS);
    }
    // Search, autocomplete, counts and snippets.
    for query in ["LEAK", "Payroll", "plan"] {
        let (_, body) = text_of(&f, who, &format!("/workspaces/{ws}/search?q={query}")).await;
        assert_clean(&format!("task search {query}"), &body, &CONTENT);
        let (_, body) = text_of(
            &f,
            who,
            &format!("/workspaces/{ws}/task-reference-suggestions?q={query}"),
        )
        .await;
        assert_clean(&format!("task suggestions {query}"), &body, &CONTENT);
        let (_, body) = text_of(
            &f,
            who,
            &format!("/workspaces/{ws}/knowledge/search?q={query}"),
        )
        .await;
        assert_clean(&format!("note search {query}"), &body, &SECRETS);
        let (_, body) = text_of(
            &f,
            who,
            &format!("/workspaces/{ws}/knowledge/names?q={query}"),
        )
        .await;
        assert_clean(&format!("note names {query}"), &body, &SECRETS);
    }
    let (_, found) = text_of(&f, who, &format!("/workspaces/{ws}/search?q=Open")).await;
    assert!(
        found.contains("Open source task"),
        "readable work still shows: {found}"
    );
    let (status, body) = text_of(&f, who, &format!("/vaults/{}/contents", secret_vault.id)).await;
    assert!(!status.is_success(), "{status}");
    assert_clean("vault contents", &body, &SECRETS);
    // The Inbox holds an assignment and a mention for a Task the viewer cannot read, and shows neither.
    let (status, body) = text_of(&f, who, &format!("/workspaces/{ws}/inbox")).await;
    assert_eq!(status, 200);
    assert_clean("inbox", &body, &SECRETS);
    assert!(
        !body.contains(hidden_id),
        "inbox names a hidden Task: {body}"
    );
    let (_, body) = text_of(&f, who, &format!("/workspaces/{ws}/my-work")).await;
    assert_clean("my work", &body, &SECRETS);
    // Realtime: the snapshot never lists the hidden Task.
    let (_, body) = text_of(
        &f,
        who,
        &format!("/workspaces/{ws}/realtime/snapshot?after=0"),
    )
    .await;
    assert!(
        !body.contains(hidden_id),
        "snapshot lists a hidden Task: {body}"
    );

    // AI retrieval for the viewer: scope covers the open Project only; every tool stays empty.
    let (status, run) = post(
        &f,
        who,
        "/ai/runs",
        json!({"workspace_id":ws,"connection_id":f.connection,"capability":"generate","scope":{"projects":[open]},"prompt":"summarise"}),
    )
    .await;
    assert!(status.is_success(), "{status} {run}");
    let (status, _) = post(
        &f,
        who,
        "/ai/runs",
        json!({"workspace_id":ws,"connection_id":f.connection,"capability":"knowledge","scope":{"projects":[open],"vaults":[secret_vault.id]},"prompt":"read"}),
    )
    .await;
    assert_eq!(
        status, 403,
        "a Vault the viewer cannot read cannot enter a run"
    );
    let (status, _) = post(
        &f,
        who,
        "/ai/runs",
        json!({"workspace_id":ws,"connection_id":f.connection,"capability":"generate","scope":{"projects":[hidden_project]},"prompt":"read"}),
    )
    .await;
    assert_eq!(
        status, 403,
        "a Project the viewer cannot read cannot enter a run"
    );
    let tools = ai_tool_replies(&f, who, open, &hidden, &secret_vault).await;
    assert_clean("ai tools", &tools, &SECRETS);

    for path in [secret_vault.repo.clone(), secret_vault.work.clone()] {
        let _ = std::fs::remove_dir_all(path);
    }
    cleanup(f).await;
}

/// Pairs a runner, starts a run as `who` over `project` and calls every retrieval tool against the
/// hidden Task and the hidden note. Returns all replies joined.
async fn ai_tool_replies(
    f: &Fixture,
    who: &Who,
    project: Uuid,
    hidden: &Value,
    vault: &Vault,
) -> String {
    let (client, root, bearer) = pair(f).await;
    let (_, job) = start_and_lease(f, who, &client, &root, &bearer, project).await;
    let mut all = String::new();
    for call in [
        json!({"tool":"search_tasks","query":"LEAK"}),
        json!({"tool":"search_tasks","query":"Payroll"}),
        json!({"tool":"get_task","task_id":hidden["id"]}),
        json!({"tool":"search_notes","query":"LEAK-NOTE-BODY"}),
        json!({"tool":"read_note","vault_id":vault.id,"path":"Secrets/Hidden Plan.md","offset":0}),
    ] {
        let reply = tool(&client, &root, &bearer, &job, call.clone()).await;
        assert_eq!(reply.0, 200, "{call}");
        assert_eq!(
            reply.1["results"].as_array().map(Vec::len),
            Some(0),
            "{call}: {}",
            reply.1
        );
        all += &reply.1.to_string();
    }
    all
}

async fn pair(f: &Fixture) -> (reqwest::Client, String, String) {
    let client = reqwest::Client::new();
    let root = format!("{}/api/v1/ai", f.origin);
    let (_, code) = post(
        f,
        &f.owner,
        &format!("/ai/connections/{}/runners/pairing-codes", f.connection),
        json!({}),
    )
    .await;
    let paired: Value = client
        .post(format!("{root}/agent/pair"))
        .json(&json!({"code":code["code"],"name":"scripted","version":"test","supported_modes":["scripted"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let bearer = format!("Bearer {}", paired["token"].as_str().unwrap());
    client
        .post(format!("{root}/agent/heartbeat"))
        .header("authorization", &bearer)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    (client, root, bearer)
}

async fn start_and_lease(
    f: &Fixture,
    who: &Who,
    client: &reqwest::Client,
    root: &str,
    bearer: &str,
    project: Uuid,
) -> (Value, String) {
    start_scoped(
        f,
        who,
        client,
        root,
        bearer,
        "generate",
        json!({"projects":[project]}),
    )
    .await
}

async fn start_scoped(
    f: &Fixture,
    who: &Who,
    client: &reqwest::Client,
    root: &str,
    bearer: &str,
    capability: &str,
    scope: Value,
) -> (Value, String) {
    let (status, run) = post(
        f,
        who,
        "/ai/runs",
        json!({"workspace_id":f.workspace,"connection_id":f.connection,"capability":capability,"scope":scope,"prompt":"work"}),
    )
    .await;
    assert!(status.is_success(), "{status} {run}");
    let lease: Value = client
        .post(format!("{root}/agent/jobs/lease"))
        .header("authorization", bearer)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (run, lease["job"]["id"].as_str().unwrap().to_owned())
}

async fn tool(
    client: &reqwest::Client,
    root: &str,
    bearer: &str,
    job: &str,
    call: Value,
) -> (reqwest::StatusCode, Value) {
    let response = client
        .post(format!("{root}/agent/jobs/{job}/tools"))
        .header("authorization", bearer)
        .json(&json!({"call":call}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_access_mid_run_makes_tools_and_apply_refuse() {
    let f = fixture().await;
    let who = &f.viewer;
    let shared = project(
        &f,
        "Shared",
        "restricted",
        &[(&f.owner, "manager"), (who, "contributor")],
    )
    .await;
    let notes = vault(
        &f,
        "Shared Notes",
        "Guides/Setup.md",
        "# Setup\n\nREVOKE-NOTE-BODY\n",
        &[(&f.owner, "manager"), (who, "manager")],
    )
    .await;
    let made = task(
        &f,
        shared,
        json!({"title":"Revocable task","description":"REVOKE-TASK-BODY"}),
    )
    .await;
    let (client, root, bearer) = pair(&f).await;
    let (_, job) = start_scoped(
        &f,
        who,
        &client,
        &root,
        &bearer,
        "knowledge",
        json!({"projects":[shared],"vaults":[notes.id]}),
    )
    .await;
    let reads = json!([
        {"tool":"search_tasks","query":"REVOKE-TASK-BODY"},
        {"tool":"get_task","task_id":made["id"]},
        {"tool":"search_notes","query":"REVOKE-NOTE-BODY"},
        {"tool":"read_note","vault_id":notes.id,"path":"Guides/Setup.md","offset":0},
    ]);
    for call in reads.as_array().unwrap() {
        let (status, reply) = tool(&client, &root, &bearer, &job, call.clone()).await;
        assert_eq!(status, 200, "{call}");
        assert!(
            !reply["results"].as_array().unwrap().is_empty(),
            "before revocation {call}: {reply}"
        );
    }
    // A pending note Proposal made by the same person, then access is taken away mid-run.
    let (status, proposal) = post(
        &f,
        who,
        &format!("/workspaces/{}/proposals/mock", f.workspace),
        json!({"scope":{"project_ids":[shared],"vault_ids":[notes.id]},"items":[{"id":"edit","kind":"note_edit","vault_id":notes.id,"path":"Guides/Setup.md","content":"Rewritten\n","reason":"test","sources":[]}]}),
    )
    .await;
    assert_eq!(status, 201, "{proposal}");
    let head_before = String::from_utf8(
        std::process::Command::new("git")
            .arg("--git-dir")
            .arg(&notes.repo)
            .args(["rev-parse", "refs/heads/main"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    sqlx::query("DELETE FROM vault_user_memberships WHERE vault_id=$1 AND user_id=$2")
        .bind(notes.id)
        .bind(who.id)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(shared)
        .bind(who.id)
        .execute(&f.db)
        .await
        .unwrap();
    for call in reads.as_array().unwrap() {
        let (status, reply) = tool(&client, &root, &bearer, &job, call.clone()).await;
        assert!(
            !status.is_success() || reply["results"].as_array().is_some_and(Vec::is_empty),
            "after revocation {call} -> {status} {reply}"
        );
        assert_clean(
            "revoked tool",
            &reply.to_string(),
            &["REVOKE-NOTE-BODY", "REVOKE-TASK-BODY"],
        );
    }
    let (status, refusal) = post(
        &f,
        who,
        &format!(
            "/workspaces/{}/proposals/{}/approve",
            f.workspace,
            proposal["id"].as_str().unwrap()
        ),
        json!({"revision":1}),
    )
    .await;
    assert!(
        !status.is_success(),
        "Apply must refuse after revocation: {status} {refusal}"
    );
    let head_after = String::from_utf8(
        std::process::Command::new("git")
            .arg("--git-dir")
            .arg(&notes.repo)
            .args(["rev-parse", "refs/heads/main"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(
        head_before, head_after,
        "a refused Apply leaves the Vault untouched"
    );
    let applied: i64 =
        sqlx::query_scalar("SELECT count(*) FROM proposals WHERE status IN ('applied','applying')")
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(applied, 0);
    for path in [notes.repo.clone(), notes.work.clone()] {
        let _ = std::fs::remove_dir_all(path);
    }
    cleanup(f).await;
}

async fn proposal_status(f: &Fixture, id: &str) -> String {
    sqlx::query_scalar("SELECT status FROM proposals WHERE id=$1::uuid")
        .bind(id)
        .fetch_one(&f.db)
        .await
        .unwrap()
}

// An Apply that dies after the database commit and before the Vault ref moves is finished by startup
// recovery (covered with the Proposal tests). When the ref moved on by someone else's commit, recovery
// refuses to rewrite history and the Proposal is marked as needing attention, where its approver sees it.
#[tokio::test(flavor = "multi_thread")]
async fn an_apply_that_dies_halfway_is_marked_needs_attention_never_silent() {
    let mut f = fixture().await;
    let shared = project(&f, "Shared", "workspace", &[(&f.owner, "manager")]).await;
    let notes = vault(
        &f,
        "Recovery Notes",
        "Guides/Setup.md",
        "# Setup\n",
        &[(&f.owner, "manager")],
    )
    .await;
    let (status, proposal) = post(
        &f,
        &f.owner,
        &format!("/workspaces/{}/proposals/mock", f.workspace),
        json!({"scope":{"project_ids":[shared],"vault_ids":[notes.id]},"items":[{"id":"add","kind":"file_add","vault_id":notes.id,"path":"one.md","content_base64":base64("first"),"storage":"git","reason":"test","sources":[]}]}),
    )
    .await;
    assert_eq!(status, 201, "{proposal}");
    let id = proposal["id"].as_str().unwrap().to_owned();
    let (status, applied) = post(
        &f,
        &f.owner,
        &format!("/workspaces/{}/proposals/{id}/approve", f.workspace),
        json!({"revision":1}),
    )
    .await;
    assert!(status.is_success(), "{status} {applied}");
    let (base, _prepared): (String, String) = sqlx::query_as(
        "SELECT base_commit,prepared_commit FROM knowledge_apply_groups WHERE proposal_id=$1::uuid",
    )
    .bind(&id)
    .fetch_one(&f.db)
    .await
    .unwrap();
    // The server dies right after the database commit: the ref never moved to the prepared commit,
    // and somebody else committed to main from the old base in the meantime.
    f.server.abort();
    git(&notes.work, &["reset", "-q", "--hard", &base]);
    std::fs::write(notes.work.join("other.md"), "someone else").unwrap();
    git(&notes.work, &["add", "."]);
    git(&notes.work, &["commit", "-q", "-m", "independent"]);
    git(
        &notes.work,
        &["push", "-q", "--force", "origin", "HEAD:refs/heads/main"],
    );
    let independent = String::from_utf8(
        std::process::Command::new("git")
            .arg("-C")
            .arg(&notes.work)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    sqlx::query("UPDATE knowledge_apply_groups SET state='applying' WHERE proposal_id=$1::uuid")
        .bind(&id)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("UPDATE proposals SET status='applying' WHERE id=$1::uuid")
        .bind(&id)
        .execute(&f.db)
        .await
        .unwrap();
    let (server, origin) = start(&f.scoped, &f.root).await;
    f.server = server;
    f.origin = origin;
    for _ in 0..500 {
        if proposal_status(&f, &id).await == "needs_attention" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        proposal_status(&f, &id).await,
        "needs_attention",
        "a moved ref is never silent"
    );
    let group_error: Option<String> =
        sqlx::query_scalar("SELECT error FROM knowledge_apply_groups WHERE proposal_id=$1::uuid")
            .bind(&id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(group_error.is_some_and(|error| error.contains("advanced")));
    // The approver sees the state through the API.
    let (status, body) = text_of(
        &f,
        &f.owner,
        &format!("/workspaces/{}/proposals/{id}", f.workspace),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("needs_attention"), "{body}");
    // The independent commit is untouched: recovery never rewrites history.
    let head = String::from_utf8(
        std::process::Command::new("git")
            .arg("--git-dir")
            .arg(&notes.repo)
            .args(["rev-parse", "refs/heads/main"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(head.trim(), independent.trim());
    for path in [notes.repo.clone(), notes.work.clone()] {
        let _ = std::fs::remove_dir_all(path);
    }
    cleanup(f).await;
}

fn git_dir(repo: &Path, args: &[&str]) {
    assert!(std::process::Command::new("git")
        .arg("--git-dir")
        .arg(repo)
        .args(args)
        .status()
        .unwrap()
        .success());
}

fn base64(text: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in text.as_bytes().chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

// Release names never appear in code, API paths, configuration or tags, and the version is unchanged.
#[test]
fn release_names_stay_out_of_code_paths_configuration_and_the_version() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for dir in [
        "crates",
        "apps/web/src",
        "apps/web/public",
        "docker",
        "scripts",
    ] {
        collect(&root.join(dir), &mut files);
    }
    for name in [
        "Cargo.toml",
        "apps/web/package.json",
        "apps/web/index.html",
        "apps/web/vite.config.ts",
    ] {
        files.push(root.join(name));
    }
    let release = |text: &str| {
        let lower = text.to_lowercase();
        ["alpha", "beta"].iter().any(|name| {
            lower.match_indices(name).any(|(at, _)| {
                let before = lower[..at].chars().next_back();
                let after = lower[at + name.len()..].chars().next();
                // A separate word, identifier part or path segment, not part of a longer word.
                !before.is_some_and(char::is_alphanumeric)
                    && !after.is_some_and(char::is_alphabetic)
            })
        })
    };
    let mut offenders = Vec::new();
    for file in &files {
        let shown = file
            .strip_prefix(&root)
            .unwrap_or(file)
            .display()
            .to_string();
        if release(&shown) {
            offenders.push(format!("file name {shown}"));
        }
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        for (number, line) in text.lines().enumerate() {
            let in_test_fixture = shown.contains("/tests/")
                || line.contains("assert")
                || line.contains("let note = ");
            let names_a_route_or_config = line.contains("\"/")
                || line.contains("WEFT_")
                || line.contains("env!(")
                || shown.ends_with(".toml")
                || shown.ends_with("package.json")
                || shown.ends_with(".yml")
                || shown.ends_with("Dockerfile");
            if release(line) && names_a_route_or_config && !in_test_fixture {
                offenders.push(format!("{shown}:{}: {}", number + 1, line.trim()));
            }
        }
    }
    assert!(offenders.is_empty(), "release names found: {offenders:#?}");
    let manifest = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(
        manifest.contains("version = \"0.1.0\""),
        "crate version changed: {manifest}"
    );
    let package = std::fs::read_to_string(root.join("apps/web/package.json")).unwrap();
    assert!(package.contains("\"version\": \"0.1.0\""));
    let routes = std::fs::read_to_string(root.join("crates/weft-server/src/lib.rs")).unwrap();
    assert!(routes.contains("/api/v1"));
    if let Ok(tags) = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .arg("tag")
        .output()
    {
        let tags = String::from_utf8_lossy(&tags.stdout).to_lowercase();
        assert!(
            !tags.contains("alpha") && !tags.contains("beta"),
            "release tag found: {tags}"
        );
    }
}

fn collect(dir: &Path, files: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), "target" | "node_modules" | "dist" | ".git") {
            continue;
        }
        if path.is_dir() {
            collect(&path, files);
        } else {
            files.push(path);
        }
    }
}

// A reaction has no Operation, but every open browser must still hear about it.
#[tokio::test(flavor = "multi_thread")]
async fn a_reaction_and_its_removal_reach_the_realtime_feed() {
    let f = fixture().await;
    let open = project(&f, "Open", "workspace", &[(&f.owner, "manager")]).await;
    let made = task(&f, open, json!({"title":"React here"})).await;
    let id = made["id"].as_str().unwrap();
    let (status, comment) = post(
        &f,
        &f.owner,
        &format!("/tasks/{id}/comments"),
        json!({"request_id":Uuid::new_v4(),"body":"hello"}),
    )
    .await;
    assert_eq!(status, 201);
    let comment_id = comment["id"].as_str().unwrap();
    let events = |f: &Fixture| {
        let db = f.db.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM realtime_outbox WHERE entity_type='comment' AND entity_id=$1::uuid AND event_type='update'")
                .bind(comment_id)
                .fetch_one(&db)
                .await
                .unwrap()
        }
    };
    let before = events(&f).await;
    let (status, _) = post(
        &f,
        &f.owner,
        &format!("/tasks/{id}/comments/{comment_id}/reactions"),
        json!({"emoji":"👍"}),
    )
    .await;
    assert!(status.is_success(), "{status}");
    assert_eq!(
        events(&f).await,
        before + 1,
        "adding a reaction queues an event"
    );
    let removed = call(
        &f,
        &f.owner,
        reqwest::Method::DELETE,
        &format!("/tasks/{id}/comments/{comment_id}/reactions?emoji=%F0%9F%91%8D"),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(removed.status(), 204);
    assert_eq!(events(&f).await, before + 2, "removing it queues one too");
    cleanup(f).await;
}
