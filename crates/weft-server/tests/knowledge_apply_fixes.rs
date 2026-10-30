//! Knowledge Apply hardening: Vault path safety, stale-base refusal, index/ref consistency, Vault lock
//! behaviour and guarded Proposal state changes.
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
        let vaults = root.join("vaults");
        let _ = serve(
            listener,
            ServerConfig::new(db, root).with_vault_root(vaults),
        )
        .await;
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

fn base64(text: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(text)
}

fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn git_out(repo: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn install_hook(repo: &Path, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    let hooks = repo.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("reference-transaction");
    std::fs::write(&hook, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
}

struct Setup {
    f: Fixture,
    project: Uuid,
    vault: Vault,
}

async fn setup() -> Setup {
    let f = fixture().await;
    let project = project(&f, "Shared", "workspace", &[(&f.owner, "manager")]).await;
    let vault = vault(
        &f,
        "Apply Notes",
        "Guides/Setup.md",
        "# Setup\n",
        &[(&f.owner, "manager")],
    )
    .await;
    Setup { f, project, vault }
}

impl Setup {
    async fn propose(&self, item: Value) -> (reqwest::StatusCode, Value) {
        post(
            &self.f,
            &self.f.owner,
            &format!("/workspaces/{}/proposals/mock", self.f.workspace),
            json!({"scope":{"project_ids":[self.project],"vault_ids":[self.vault.id]},"items":[item]}),
        )
        .await
    }
    async fn add_file(&self, path: &str, text: &str) -> String {
        let (status, body) = self
            .propose(json!({"id":"add","kind":"file_add","vault_id":self.vault.id,"path":path,"content_base64":base64(text),"storage":"git","reason":"test","sources":[]}))
            .await;
        assert_eq!(status, 201, "{body}");
        body["id"].as_str().unwrap().to_owned()
    }
    async fn approve(&self, id: &str) -> (reqwest::StatusCode, Value) {
        post(
            &self.f,
            &self.f.owner,
            &format!("/workspaces/{}/proposals/{id}/approve", self.f.workspace),
            json!({"revision":1}),
        )
        .await
    }
    async fn indexed(&self) -> Vec<String> {
        sqlx::query_scalar("SELECT path FROM vault_indexed_files WHERE vault_id=$1 ORDER BY path")
            .bind(self.vault.id)
            .fetch_all(&self.f.db)
            .await
            .unwrap()
    }
    async fn status(&self, id: &str) -> String {
        sqlx::query_scalar("SELECT status FROM proposals WHERE id=$1::uuid")
            .bind(id)
            .fetch_one(&self.f.db)
            .await
            .unwrap()
    }
    fn main_files(&self) -> Vec<String> {
        git_out(
            &self.vault.repo,
            &["ls-tree", "-r", "--name-only", "refs/heads/main"],
        )
        .lines()
        .map(str::to_owned)
        .collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn git_directory_paths_are_refused_when_a_proposal_is_created() {
    let s = setup().await;
    for path in [
        ".git/config",
        ".GIT/hooks/post-commit",
        "notes/.git/x",
        ".gitattributes",
        "a/.GitAttributes",
    ] {
        let (status, body) = s
            .propose(json!({"id":"add","kind":"file_add","vault_id":s.vault.id,"path":path,"content_base64":base64("x"),"storage":"git","reason":"t","sources":[]}))
            .await;
        assert!(status.is_client_error(), "{path} accepted: {status} {body}");
    }
    let (status, body) = s
        .propose(json!({"id":"edit","kind":"note_edit","vault_id":s.vault.id,"path":"Guides/Setup.md","rename_to":".git/Setup.md","content":"x","reason":"t","sources":[]}))
        .await;
    assert!(
        status.is_client_error(),
        "rename into .git accepted: {status} {body}"
    );
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn apply_refuses_a_stored_git_directory_path_and_runs_nothing() {
    let s = setup().await;
    let id = s.add_file("one.md", "x").await;
    let marker = env::temp_dir().join(format!("weft-fsmonitor-{}", Uuid::new_v4()));
    let config = format!("[core]\n\tfsmonitor = touch {}\n", marker.display());
    sqlx::query("UPDATE proposals SET items=jsonb_set(jsonb_set(items,'{0,path}','\".git/config\"'),'{0,content_base64}',to_jsonb($2::text)) WHERE id=$1::uuid")
        .bind(&id)
        .bind(base64(&config))
        .execute(&s.f.db)
        .await
        .unwrap();
    let before = git_out(&s.vault.repo, &["rev-parse", "refs/heads/main"]);
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 409, "{body}");
    assert!(
        !marker.exists(),
        "a configured command ran inside the clone"
    );
    assert_eq!(
        git_out(&s.vault.repo, &["rev-parse", "refs/heads/main"]),
        before
    );
    assert_eq!(s.status(&id).await, "pending");
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn apply_never_writes_through_a_symlink_pushed_to_the_vault() {
    let s = setup().await;
    let outside = env::temp_dir().join(format!("weft-outside-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, s.vault.work.join("link")).unwrap();
    git(&s.vault.work, &["add", "."]);
    git(&s.vault.work, &["commit", "-q", "-m", "symlink"]);
    git(&s.vault.work, &["push", "-q", "origin", "main"]);
    let id = s.add_file("link/escaped.md", "escaped").await;
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 409, "{body}");
    assert!(
        !outside.join("escaped.md").exists(),
        "the write escaped the clone through a symlink"
    );
    assert!(!s.main_files().iter().any(|p| p.contains("escaped")));
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_human_edit_after_proposal_creation_blocks_approval() {
    let s = setup().await;
    let (status, body) = s
        .propose(json!({"id":"edit","kind":"note_edit","vault_id":s.vault.id,"path":"Guides/Setup.md","content":"# AI text\n","reason":"t","sources":[]}))
        .await;
    assert_eq!(status, 201, "{body}");
    let id = body["id"].as_str().unwrap().to_owned();
    let base = git_out(&s.vault.repo, &["rev-parse", "refs/heads/main"]);
    sqlx::query("UPDATE proposals SET items=jsonb_set(jsonb_set(items,'{0,base_hash}',to_jsonb($2::text)),'{0,base_commit}',to_jsonb($3::text)) WHERE id=$1::uuid")
        .bind(&id)
        .bind(sha("# Setup\n"))
        .bind(&base)
        .execute(&s.f.db)
        .await
        .unwrap();
    std::fs::write(s.vault.work.join("Guides/Setup.md"), "# Human edit\n").unwrap();
    git(&s.vault.work, &["commit", "-q", "-am", "human"]);
    git(&s.vault.work, &["push", "-q", "origin", "main"]);
    let human = git_out(&s.vault.repo, &["rev-parse", "refs/heads/main"]);
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"], "note_changed_since_proposal", "{body}");
    assert_eq!(
        git_out(&s.vault.repo, &["rev-parse", "refs/heads/main"]),
        human
    );
    assert_eq!(
        git_out(&s.vault.repo, &["show", "main:Guides/Setup.md"]),
        "# Human edit"
    );
    assert_eq!(s.status(&id).await, "pending");
    let groups: i64 = sqlx::query_scalar("SELECT count(*) FROM knowledge_apply_groups")
        .fetch_one(&s.f.db)
        .await
        .unwrap();
    assert_eq!(groups, 0);
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_ref_update_leaves_the_index_matching_the_real_main() {
    let s = setup().await;
    let id = s.add_file("one.md", "first").await;
    // The ref cannot advance: stands in for main moving between prepare and update-ref.
    install_hook(
        &s.vault.repo,
        "case \"$(cat)\" in *refs/heads/main*) [ \"$1\" = prepared ] && exit 1;; esac\nexit 0",
    );
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(s.status(&id).await, "needs_attention");
    assert_eq!(s.main_files(), vec!["Guides/Setup.md"]);
    assert_eq!(
        s.indexed().await,
        vec!["Guides/Setup.md"],
        "the index kept content that never reached main"
    );
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_applies_on_one_vault_never_stall_the_pool() {
    let s = setup().await;
    let mut ids = Vec::new();
    for n in 0..12 {
        ids.push(s.add_file(&format!("n{n}.md"), "x").await);
    }
    let results = tokio::time::timeout(Duration::from_secs(25), async {
        let mut tasks = Vec::new();
        for id in &ids {
            let (origin, workspace, cookie, csrf, id) = (
                s.f.origin.clone(),
                s.f.workspace,
                s.f.owner.cookie.clone(),
                s.f.owner.csrf.clone(),
                id.clone(),
            );
            tasks.push(tokio::spawn(async move {
                let response = reqwest::Client::new()
                    .post(format!(
                        "{origin}/api/v1/workspaces/{workspace}/proposals/{id}/approve"
                    ))
                    .header(reqwest::header::COOKIE, cookie)
                    .header("x-csrf-token", csrf)
                    .header("idempotency-key", Uuid::new_v4().to_string())
                    .json(&json!({"revision":1}))
                    .send()
                    .await
                    .unwrap();
                let status = response.status();
                (status, response.json::<Value>().await.unwrap_or_default())
            }));
        }
        let mut out = Vec::new();
        for task in tasks {
            out.push(task.await.unwrap());
        }
        out
    })
    .await
    .expect("concurrent Applies stalled");
    for (status, body) in &results {
        assert!(
            *status == 200 || (*status == 409 && body["error"] == "vault_busy"),
            "{status} {body}"
        );
    }
    assert!(results.iter().any(|(status, _)| *status == 200));
    let applied = results.iter().filter(|(status, _)| *status == 200).count();
    assert_eq!(s.main_files().len(), 1 + applied);
    assert_eq!(s.indexed().await.len(), 1 + applied);
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn approve_does_not_apply_a_revision_edited_while_it_was_preparing() {
    let s = setup().await;
    let id = s.add_file("one.md", "first").await;
    let dir = env::temp_dir().join(format!("weft-gate-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let (reached, go) = (dir.join("reached"), dir.join("go"));
    install_hook(
        &s.vault.repo,
        &format!(
            "case \"$(cat)\" in *refs/weft/prepared*) [ \"$1\" = prepared ] && {{ touch {r}; for i in $(seq 1 200); do [ -e {g} ] && break; sleep 0.05; done; }};; esac\nexit 0",
            r = reached.display(),
            g = go.display()
        ),
    );
    let approve = {
        let (origin, workspace, cookie, csrf, id) = (
            s.f.origin.clone(),
            s.f.workspace,
            s.f.owner.cookie.clone(),
            s.f.owner.csrf.clone(),
            id.clone(),
        );
        tokio::spawn(async move {
            let response = reqwest::Client::new()
                .post(format!(
                    "{origin}/api/v1/workspaces/{workspace}/proposals/{id}/approve"
                ))
                .header(reqwest::header::COOKIE, cookie)
                .header("x-csrf-token", csrf)
                .header("idempotency-key", Uuid::new_v4().to_string())
                .json(&json!({"revision":1}))
                .send()
                .await
                .unwrap();
            response.status()
        })
    };
    for _ in 0..200 {
        if reached.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(reached.exists(), "Apply never reached the prepare step");
    sqlx::query("UPDATE proposals SET revision=revision+1 WHERE id=$1::uuid")
        .bind(&id)
        .execute(&s.f.db)
        .await
        .unwrap();
    std::fs::write(&go, "").unwrap();
    assert_eq!(approve.await.unwrap(), 409);
    assert_eq!(s.status(&id).await, "pending");
    assert_eq!(s.main_files(), vec!["Guides/Setup.md"]);
    assert!(!s.indexed().await.iter().any(|p| p == "one.md"));
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn undo_takes_the_vault_lock_and_refuses_while_it_is_held() {
    use sqlx::Connection;
    let s = setup().await;
    let id = s.add_file("one.md", "first").await;
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 200, "{body}");
    let mut held = sqlx::PgConnection::connect(&s.f.scoped).await.unwrap();
    let key = format!("weft-vault-apply:{}", s.vault.id);
    let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended($1,0))")
        .bind(&key)
        .fetch_one(&mut held)
        .await
        .unwrap();
    assert!(got);
    let (status, body) = post(
        &s.f,
        &s.f.owner,
        &format!("/workspaces/{}/proposals/{id}/undo", s.f.workspace),
        json!({}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"], "vault_busy");
    sqlx::query("SELECT pg_advisory_unlock(hashtextextended($1,0))")
        .bind(&key)
        .execute(&mut held)
        .await
        .unwrap();
    let (status, body) = post(
        &s.f,
        &s.f.owner,
        &format!("/workspaces/{}/proposals/{id}/undo", s.f.workspace),
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn vault_import_waits_for_the_vault_apply_lock() {
    use sqlx::Connection;
    let f = fixture().await;
    let (status, created) = post(
        &f,
        &f.owner,
        &format!("/workspaces/{}/vaults", f.workspace),
        json!({"name":"Import Lock","visibility":"restricted"}),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let vault: Uuid = created["id"].as_str().unwrap().parse().unwrap();
    let sample = env::temp_dir().join(format!("weft-import-lock-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&sample).unwrap();
    std::fs::write(sample.join("a.md"), "# A\n").unwrap();
    let archive = env::temp_dir().join(format!("weft-import-lock-{}.tar.gz", Uuid::new_v4()));
    assert!(std::process::Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&sample)
        .arg(".")
        .status()
        .unwrap()
        .success());
    let mut held = sqlx::PgConnection::connect(&f.scoped).await.unwrap();
    let key = format!("weft-vault-apply:{vault}");
    let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended($1,0))")
        .bind(&key)
        .fetch_one(&mut held)
        .await
        .unwrap();
    assert!(got);
    let response = call(
        &f,
        &f.owner,
        reqwest::Method::POST,
        &format!("/vaults/{vault}/imports/archive"),
    )
    .header(reqwest::header::CONTENT_TYPE, "application/gzip")
    .body(std::fs::read(&archive).unwrap())
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), 202);
    let job: Value = response.json().await.unwrap();
    let job = job["id"].as_str().unwrap().to_owned();
    let state = |f: &Fixture| {
        let path = format!("/vaults/{vault}/imports/{job}");
        let f = (f.origin.clone(), f.owner.cookie.clone());
        async move {
            let body: Value = reqwest::Client::new()
                .get(format!("{}/api/v1{path}", f.0))
                .header(reqwest::header::COOKIE, f.1)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            body["status"].as_str().unwrap_or("").to_owned()
        }
    };
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let during = state(&f).await;
    assert!(
        during != "completed" && during != "failed",
        "import ran while the Apply lock was held: {during}"
    );
    sqlx::query("SELECT pg_advisory_unlock(hashtextextended($1,0))")
        .bind(&key)
        .execute(&mut held)
        .await
        .unwrap();
    let mut last = String::new();
    for _ in 0..200 {
        last = state(&f).await;
        if last == "completed" || last == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(last, "completed");
    cleanup(f).await;
}
