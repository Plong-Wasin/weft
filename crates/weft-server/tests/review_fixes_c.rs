//! Review-fix regressions (list C): leaks, SMTP, Inbox cap, attachment listing, duplicate hints.
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

const REF: &str = "[[Secrets Vault/Secrets/Hidden Plan.md]]";

#[tokio::test(flavor = "multi_thread")]
async fn m4_note_references_stay_redacted_in_backlinks_search_and_ai_context() {
    let f = fixture().await;
    let open = project(
        &f,
        "Open",
        "workspace",
        &[(&f.owner, "manager"), (&f.viewer, "viewer")],
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
    let target = task(&f, open, json!({"title":"Target"})).await;
    let source = task(&f, open, json!({"title":"Source"})).await;
    let source_id = source["id"].as_str().unwrap();
    let response = call(
        &f,
        &f.owner,
        reqwest::Method::PATCH,
        &format!("/tasks/{source_id}"),
    )
    .json(&json!({"expected_version":source["version"],"description":format!("desc-marker {REF}")}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
    let (status, _) = post(
        &f,
        &f.owner,
        &format!("/tasks/{source_id}/comments"),
        json!({"request_id":Uuid::new_v4(),"body":format!("see #{} {REF}", target["number"])}),
    )
    .await;
    assert_eq!(status, 201);
    let who = &f.viewer;
    let ws = f.workspace;
    let target_id = target["id"].as_str().unwrap();

    let (status, body) = text_of(&f, who, &format!("/tasks/{target_id}/references")).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("[[note]]"), "snippet is still shown: {body}");
    assert_clean("backlink snippet", &body, &SECRETS);

    for query in ["Secrets%20Vault", "Hidden%20Plan"] {
        let (_, body) = text_of(&f, who, &format!("/workspaces/{ws}/search?q={query}")).await;
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            parsed["count"], 0,
            "search is a note-existence oracle: {body}"
        );
        assert_clean("search results", &body, &SECRETS);
    }
    let (_, body) = text_of(&f, who, &format!("/workspaces/{ws}/search?q=desc-marker")).await;
    let parsed: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed["count"], 1, "{body}");
    assert_clean("search snippet", &body, &SECRETS);
    assert!(body.contains("[[note]]"), "{body}");

    let (client, root, bearer) = pair(&f).await;
    let (_, job) = start_and_lease(&f, who, &client, &root, &bearer, open).await;
    let mut all = String::new();
    for call in [
        json!({"tool":"get_task","task_id":source["id"]}),
        json!({"tool":"read_task_chat","task_id":source["id"],"offset":0}),
    ] {
        let (status, reply) = tool(&client, &root, &bearer, &job, call.clone()).await;
        assert_eq!(status, 200, "{call}");
        assert!(!reply["results"].as_array().unwrap().is_empty(), "{call}");
        all += &reply.to_string();
    }
    assert_clean("ai context", &all, &SECRETS);
    assert!(
        !all.contains("owner@example.com"),
        "read_task_chat hands author emails to the model: {all}"
    );

    for path in [secret_vault.repo.clone(), secret_vault.work.clone()] {
        let _ = std::fs::remove_dir_all(path);
    }
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn m8_emails_with_control_characters_or_a_bad_shape_are_rejected_everywhere() {
    let f = fixture().await;
    let (status, invite) = post(&f, &f.owner, "/auth/invites", json!({"role":"member"})).await;
    assert_eq!(status, 201, "{invite}");
    for email in [
        "evil@example.com\r\nRCPT TO:<x@y.example>",
        "evil@example.com\nBcc: x@y.example",
        "a<b>@example.com",
        "no-at-sign",
        "two@@example.com",
        "@example.com",
        "trailing@",
    ] {
        let response = reqwest::Client::new()
            .post(format!("{}/api/v1/auth/invites/accept", f.origin))
            .json(&json!({"token":invite["token"],"email":email,"password":"join password"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 422, "{email:?}");
    }
    let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email LIKE '%evil%'")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(stored, 0);
    // The invitation survives the rejected attempts and still accepts a valid address.
    let ok = reqwest::Client::new()
        .post(format!("{}/api/v1/auth/invites/accept", f.origin))
        .json(
            &json!({"token":invite["token"],"email":"fine@example.com","password":"join password"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 201);
    let result =
        weft_server::bootstrap_admin(&f.db, "x@example.com\r\nRCPT TO:<y@z.example>", "p", "W")
            .await;
    assert!(result.is_err());
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn m10_inbox_keeps_the_newest_readable_entries_not_the_lowest_task_ids() {
    let f = fixture().await;
    let open = project(
        &f,
        "Open",
        "workspace",
        &[(&f.owner, "manager"), (&f.viewer, "viewer")],
    )
    .await;
    let hidden = project(&f, "Hidden", "restricted", &[(&f.owner, "manager")]).await;
    // 50 unreadable Tasks with the lowest ids and the newest notifications, then 205 readable
    // ones with ids above them: the oldest five readable entries are the ones to drop.
    for (project, prefix, count, offset, id_head) in [
        (hidden, "h", 50, 0, "00000000"),
        (open, "r", 205, 50, "ffffffff"),
    ] {
        sqlx::query(&format!("INSERT INTO tasks(id,workspace_id,number,project_id,title,created_by) SELECT ('{id_head}-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,$1,g+{offset}+1000,$2,'{prefix}'||g,$3 FROM generate_series(0,{count}-1) g"))
            .bind(f.workspace).bind(project).bind(f.owner.id).execute(&f.db).await.unwrap();
        sqlx::query(&format!("INSERT INTO notification_intents(id,workspace_id,task_id,recipient_id,actor_id,reason,created_at) SELECT gen_random_uuid(),$1,('{id_head}-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,$2,$3,'mentioned',now()-make_interval(secs=>g+{offset}) FROM generate_series(0,{count}-1) g"))
            .bind(f.workspace).bind(f.viewer.id).bind(f.owner.id).execute(&f.db).await.unwrap();
    }
    let (status, body) =
        text_of(&f, &f.viewer, &format!("/workspaces/{}/inbox", f.workspace)).await;
    assert_eq!(status, 200);
    let entries: Value = serde_json::from_str(&body).unwrap();
    let entries = entries["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 200, "unreadable rows must not consume slots");
    let titles: Vec<&str> = entries
        .iter()
        .map(|e| e["task"]["title"].as_str().unwrap())
        .collect();
    assert!(titles.iter().all(|t| t.starts_with('r')));
    assert_eq!(titles[0], "r0", "newest first");
    assert_eq!(titles[199], "r199");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn m12_unreadable_similar_tasks_do_not_flip_the_completeness_flag() {
    let f = fixture().await;
    let open = project(
        &f,
        "Open",
        "workspace",
        &[(&f.owner, "manager"), (&f.viewer, "viewer")],
    )
    .await;
    let hidden = project(&f, "Hidden", "restricted", &[(&f.owner, "manager")]).await;
    let target = task(&f, open, json!({"title":"Quarterly sales report"})).await;
    for index in 0..12 {
        task(
            &f,
            hidden,
            json!({"title":format!("Quarterly sales report copy {index}")}),
        )
        .await;
    }
    let url = format!("/workspaces/{}/tasks/{}", f.workspace, target["number"]);
    let (status, body) = text_of(&f, &f.viewer, &url).await;
    assert_eq!(status, 200, "{body}");
    let read: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(read["similar_tasks"].as_array().unwrap().len(), 0);
    assert_eq!(
        read["similar_tasks_complete"], true,
        "completeness must not reveal that 11+ unreadable look-alikes exist"
    );
    // Readable look-alikes still make the list incomplete once they exceed the window.
    for index in 0..11 {
        task(
            &f,
            open,
            json!({"title":format!("Quarterly sales report open {index}")}),
        )
        .await;
    }
    let (_, body) = text_of(&f, &f.viewer, &url).await;
    let read: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(read["similar_tasks"].as_array().unwrap().len(), 10);
    assert_eq!(read["similar_tasks_complete"], false);
    cleanup(f).await;
}
