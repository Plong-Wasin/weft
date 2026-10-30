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
        let mut paths: Vec<String> =
            sqlx::query_scalar("SELECT path FROM vault_indexed_files WHERE vault_id=$1")
                .bind(self.vault.id)
                .fetch_all(&self.f.db)
                .await
                .unwrap();
        paths.sort();
        paths
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
            &["ls-tree", "-r", "-z", "--name-only", "refs/heads/main"],
        )
        .split('\0')
        .filter(|path| !path.is_empty())
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

async fn setup_with(note: &str, text: &str) -> Setup {
    let f = fixture().await;
    let project = project(&f, "Shared", "workspace", &[(&f.owner, "manager")]).await;
    let vault = vault(&f, "Apply Notes", note, text, &[(&f.owner, "manager")]).await;
    Setup { f, project, vault }
}

impl Setup {
    async fn undo(&self, id: &str) -> (reqwest::StatusCode, Value) {
        post(
            &self.f,
            &self.f.owner,
            &format!("/workspaces/{}/proposals/{id}/undo", self.f.workspace),
            json!({}),
        )
        .await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn thai_note_and_folder_names_apply_undo_and_rebuild() {
    let s = setup_with("บันทึก/ตั้งค่า.md", "# ตั้งค่า\n").await;
    let id = s.add_file("ไทย/ใหม่.md", "สวัสดี").await;
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 200, "Thai names broke Apply: {body}");
    assert_eq!(s.indexed().await, vec!["บันทึก/ตั้งค่า.md", "ไทย/ใหม่.md"]);
    let (status, body) = s.undo(&id).await;
    assert_eq!(status, 200, "Thai names broke undo: {body}");
    assert_eq!(s.indexed().await, vec!["บันทึก/ตั้งค่า.md"]);
    // The rebuild after a failed ref update reads main with the same tree walk.
    let second = s.add_file("ไทย/สอง.md", "สอง").await;
    install_hook(
        &s.vault.repo,
        "case \"$(cat)\" in *refs/heads/main*) [ \"$1\" = prepared ] && exit 1;; esac\nexit 0",
    );
    let (status, body) = s.approve(&second).await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(s.indexed().await, vec!["บันทึก/ตั้งค่า.md"]);
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn file_add_onto_an_existing_path_is_refused_not_overwritten() {
    let s = setup().await;
    let id = s.add_file("Guides/Setup.md", "overwritten").await;
    let before = git_out(&s.vault.repo, &["rev-parse", "refs/heads/main"]);
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        git_out(&s.vault.repo, &["rev-parse", "refs/heads/main"]),
        before
    );
    assert_eq!(
        git_out(&s.vault.repo, &["show", "main:Guides/Setup.md"]),
        "# Setup"
    );
    assert_eq!(s.status(&id).await, "pending");
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_proposal_mixing_knowledge_and_other_items_is_refused_whole() {
    let s = setup().await;
    let (status, body) = post(
        &s.f,
        &s.f.owner,
        &format!("/workspaces/{}/proposals/mock", s.f.workspace),
        json!({"scope":{"project_ids":[s.project],"vault_ids":[s.vault.id]},"items":[
            {"id":"add","kind":"file_add","vault_id":s.vault.id,"path":"mixed.md","content_base64":base64("x"),"storage":"git","reason":"t","sources":[]},
            {"id":"task","kind":"task","project_id":s.project,"title":"Mixed","reason":"t","sources":[]}
        ]}),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let id = body["id"].as_str().unwrap().to_owned();
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(s.status(&id).await, "pending");
    assert_eq!(s.main_files(), vec!["Guides/Setup.md"]);
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_apply_does_not_leave_the_vault_locked() {
    let s = setup().await;
    let first = s.add_file("one.md", "first").await;
    let second = s.add_file("two.md", "second").await;
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
    // The client gives up mid-Apply: the handler future is dropped while it holds the Vault lock.
    let cancelled = reqwest::Client::new()
        .post(format!(
            "{}/api/v1/workspaces/{}/proposals/{first}/approve",
            s.f.origin, s.f.workspace
        ))
        .header(reqwest::header::COOKIE, &s.f.owner.cookie)
        .header("x-csrf-token", &s.f.owner.csrf)
        .header("idempotency-key", Uuid::new_v4().to_string())
        .json(&json!({"revision":1}))
        .timeout(Duration::from_millis(1500))
        .send()
        .await;
    assert!(
        cancelled.is_err(),
        "the Apply was not slow enough to cancel"
    );
    assert!(reached.exists(), "Apply never reached the prepare step");
    std::fs::write(&go, "").unwrap();
    let mut last = (reqwest::StatusCode::OK, Value::Null);
    for _ in 0..100 {
        last = s.approve(&second).await;
        if last.0 == 200 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        last.0, 200,
        "a cancelled Apply left the Vault locked: {}",
        last.1
    );
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn prepare_does_not_block_the_async_workers() {
    use std::io::{Read, Write};
    let s = setup().await;
    let id = s.add_file("one.md", "first").await;
    let dir = env::temp_dir().join(format!("weft-gate-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let (reached, go) = (dir.join("reached"), dir.join("go"));
    install_hook(
        &s.vault.repo,
        &format!(
            "case \"$(cat)\" in *refs/weft/prepared*) [ \"$1\" = prepared ] && {{ touch {r}; for i in $(seq 1 100); do [ -e {g} ] && break; sleep 0.05; done; }};; esac\nexit 0",
            r = reached.display(),
            g = go.display()
        ),
    );
    let address = s.f.origin.trim_start_matches("http://").to_owned();
    // The probe runs on its own OS thread, so it measures the single async worker from outside.
    let probe = {
        let (reached, go) = (reached.clone(), go.clone());
        std::thread::spawn(move || {
            for _ in 0..400 {
                if reached.exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            let mut stream = std::net::TcpStream::connect(&address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(1500)))
                .unwrap();
            stream
                .write_all(b"GET /health/ready HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                .unwrap();
            let mut buffer = [0u8; 64];
            let answered = stream.read(&mut buffer).is_ok_and(|n| n > 0);
            std::fs::write(&go, "").unwrap();
            answered
        })
    };
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 200, "{body}");
    assert!(
        probe.join().unwrap(),
        "the async worker was blocked while Apply prepared the commit"
    );
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn knowledge_item_paths_refuse_control_characters_and_obsidian() {
    let s = setup().await;
    for path in [
        "a\nb.md",
        "a\tb.md",
        "a\u{7f}b.md",
        "-rf.md",
        "dir/-flag.md",
        ".obsidian/app.json",
        "notes/.Obsidian/x.md",
    ] {
        let (status, body) = s
            .propose(json!({"id":"add","kind":"file_add","vault_id":s.vault.id,"path":path,"content_base64":base64("x"),"storage":"git","reason":"t","sources":[]}))
            .await;
        assert!(
            status.is_client_error(),
            "{path:?} accepted: {status} {body}"
        );
    }
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_vault_gitignore_cannot_silently_drop_an_added_file() {
    let s = setup().await;
    std::fs::write(s.vault.work.join(".gitignore"), "*.txt\n").unwrap();
    git(&s.vault.work, &["add", "."]);
    git(&s.vault.work, &["commit", "-q", "-m", "ignore"]);
    git(&s.vault.work, &["push", "-q", "origin", "main"]);
    let id = s.add_file("run.txt", "kept").await;
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 200, "{body}");
    assert!(s.main_files().contains(&"run.txt".to_owned()));
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn prepare_failures_do_not_leak_git_stderr_or_host_paths() {
    let s = setup().await;
    let id = s.add_file("one.md", "first").await;
    install_hook(
        &s.vault.repo,
        "case \"$(cat)\" in *refs/weft/prepared*) [ \"$1\" = prepared ] && exit 1;; esac\nexit 0",
    );
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"], "knowledge_prepare_failed");
    assert!(
        body.get("detail").is_none(),
        "raw git stderr returned to the client: {body}"
    );
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_ref_update_after_a_rename_restores_the_note_identity() {
    let s = setup().await;
    let (status, body) = s
        .propose(json!({"id":"edit","kind":"note_edit","vault_id":s.vault.id,"path":"Guides/Setup.md","rename_to":"Guides/Renamed.md","content":"# Setup\n","reason":"t","sources":[]}))
        .await;
    assert_eq!(status, 201, "{body}");
    let id = body["id"].as_str().unwrap().to_owned();
    let original: Uuid = sqlx::query_scalar(
        "SELECT id FROM vault_note_identities WHERE vault_id=$1 AND path='Guides/Setup.md'",
    )
    .bind(s.vault.id)
    .fetch_one(&s.f.db)
    .await
    .unwrap();
    install_hook(
        &s.vault.repo,
        "case \"$(cat)\" in *refs/heads/main*) [ \"$1\" = prepared ] && exit 1;; esac\nexit 0",
    );
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 202, "{body}");
    let active: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id,path FROM vault_note_identities WHERE vault_id=$1 AND deleted_at IS NULL",
    )
    .bind(s.vault.id)
    .fetch_all(&s.f.db)
    .await
    .unwrap();
    assert_eq!(
        active,
        vec![(original, "Guides/Setup.md".to_owned())],
        "the rebuild tombstoned the renamed identity instead of restoring it"
    );
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_index_rebuild_during_undo_is_visible_not_left_undoing() {
    let s = setup().await;
    let id = s.add_file("one.md", "first").await;
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 200, "{body}");
    sqlx::query("ALTER TABLE vault_indexed_files ADD CONSTRAINT refuse_setup CHECK (path <> 'Guides/Setup.md') NOT VALID")
        .execute(&s.f.db)
        .await
        .unwrap();
    let (status, _) = s.undo(&id).await;
    assert!(status != 200, "undo reported success");
    let state: String =
        sqlx::query_scalar("SELECT state FROM knowledge_apply_groups WHERE proposal_id=$1::uuid")
            .bind(&id)
            .fetch_one(&s.f.db)
            .await
            .unwrap();
    assert_eq!(state, "needs_attention");
    assert_eq!(s.status(&id).await, "needs_attention");
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn notes_named_with_glob_characters_can_be_added_and_edited() {
    let s = setup().await;
    for path in ["Why?.md", "[Meeting] x.md", "ทำไม?.md"] {
        let id = s.add_file(path, "# first\n").await;
        let (status, body) = s.approve(&id).await;
        assert_eq!(status, 200, "{path}: {body}");
        assert!(s.main_files().contains(&path.to_owned()), "{path}");
        let (status, body) = s
            .propose(json!({"id":"edit","kind":"note_edit","vault_id":s.vault.id,"path":path,"content":"# second\n","reason":"t","sources":[]}))
            .await;
        assert_eq!(status, 201, "{path} edit refused: {status} {body}");
        let (status, body) = s
            .propose(json!({"id":"edit","kind":"note_edit","vault_id":s.vault.id,"path":path,"rename_to":format!("Renamed {path}"),"content":"# second\n","reason":"t","sources":[]}))
            .await;
        assert_eq!(status, 201, "{path} rename refused: {status} {body}");
    }
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_glob_named_lfs_file_is_tracked_literally_and_never_matches_siblings() {
    use base64::Engine;
    let s = setup().await;
    let path = "img/a?b [x]*.png";
    let sibling = "img/aXb x.png";
    for p in [path, sibling] {
        let (status, body) = s
            .propose(json!({"id":"add","kind":"file_add","vault_id":s.vault.id,"path":p,"content_base64":base64::engine::general_purpose::STANDARD.encode([0u8, 1, 2, p.len() as u8]),"storage":"lfs","reason":"t","sources":[]}))
            .await;
        assert_eq!(status, 201, "{p}: {body}");
        let id = body["id"].as_str().unwrap().to_owned();
        let (status, body) = s.approve(&id).await;
        assert_eq!(status, 200, "{p}: {body}");
    }
    let attributes = git_out(&s.vault.repo, &["show", "refs/heads/main:.gitattributes"]);
    assert!(
        attributes.contains(r"\?") && attributes.contains(r"\["),
        "{attributes}"
    );
    let pointer = |p: &str| git_out(&s.vault.repo, &["show", &format!("refs/heads/main:{p}")]);
    assert!(
        pointer(path).starts_with("version https://git-lfs"),
        "literal path is an LFS pointer"
    );
    assert!(pointer(sibling).starts_with("version https://git-lfs"));
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_recovery_of_a_busy_vault_does_not_delay_the_listener() {
    use sqlx::Connection;
    let s = setup().await;
    let id = s.add_file("one.md", "x").await;
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 200, "{body}");
    sqlx::query("UPDATE knowledge_apply_groups SET state='applying' WHERE proposal_id=$1::uuid")
        .bind(&id)
        .execute(&s.f.db)
        .await
        .unwrap();
    // Another session holds the Vault's Apply lock for the whole test, so recovery has to wait.
    let mut holder = sqlx::PgConnection::connect(&s.f.scoped).await.unwrap();
    let held: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended($1,0))")
        .bind(format!("weft-vault-apply:{}", s.vault.id))
        .fetch_one(&mut holder)
        .await
        .unwrap();
    assert!(held);
    let started = std::time::Instant::now();
    let (server, _origin) =
        tokio::time::timeout(Duration::from_secs(10), start(&s.f.scoped, &s.f.root))
            .await
            .expect("the listener waited for Apply recovery");
    assert!(started.elapsed() < Duration::from_secs(10));
    server.abort();
    cleanup(s.f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_undo_conflict_lists_thai_file_names_unquoted() {
    let s = setup().await;
    let id = s.add_file("ไทย/ใหม่.md", "สวัสดี").await;
    let (status, body) = s.approve(&id).await;
    assert_eq!(status, 200, "{body}");
    git(&s.vault.work, &["pull", "-q", "origin", "main"]);
    std::fs::write(s.vault.work.join("ไทย/ใหม่.md"), "คนแก้ไขต่อ").unwrap();
    git(&s.vault.work, &["add", "."]);
    git(&s.vault.work, &["commit", "-q", "-m", "human edit"]);
    git(&s.vault.work, &["push", "-q", "origin", "main"]);
    let (status, body) = s.undo(&id).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["conflicts"][0]["file"], "ไทย/ใหม่.md", "{body}");
    cleanup(s.f).await;
}
