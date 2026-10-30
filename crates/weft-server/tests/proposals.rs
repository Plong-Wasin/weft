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

#[tokio::test(flavor = "multi_thread")]
async fn approved_note_proposal_commits_to_vault_git() {
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
    let workspace: Uuid = me["workspaces"][0]["id"].as_str().unwrap().parse().unwrap();
    let db_url = format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    );
    let db = sqlx::PgPool::connect(&db_url).await.unwrap();
    let vault = Uuid::new_v4();
    let repo = env::temp_dir().join(format!("weft-apply-{vault}.git"));
    assert!(std::process::Command::new("git")
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&repo)
        .status()
        .unwrap()
        .success());
    let work = env::temp_dir().join(format!("weft-apply-work-{vault}"));
    assert!(std::process::Command::new("git")
        .args(["clone"])
        .arg(&repo)
        .arg(&work)
        .status()
        .unwrap()
        .success());
    std::fs::write(work.join("plan.md"), "Initial\n").unwrap();
    for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com")] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["config", key, value])
            .status()
            .unwrap()
            .success());
    }
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["add", "."])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["commit", "-m", "initial"])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["push", "origin", "main"])
        .status()
        .unwrap()
        .success());
    sqlx::query("INSERT INTO vaults(id,workspace_id,name,visibility,repository_path,created_by) VALUES($1,$2,'Apply Vault','restricted',$3,(SELECT user_id FROM workspace_memberships WHERE workspace_id=$2 AND role='owner' LIMIT 1))")
        .bind(vault).bind(workspace).bind(repo.to_string_lossy().as_ref()).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) SELECT workspace_id,$1,user_id,'manager' FROM workspace_memberships WHERE workspace_id=$2 AND role='owner'")
        .bind(vault).bind(workspace).execute(&db).await.unwrap();
    let proposal = client.post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project],"vault_ids":[vault]},"items":[{"id":"edit","kind":"note_edit","vault_id":vault,"path":"plan.md","content":"Approved text\n","reason":"test","sources":[]}]}))
        .send().await.unwrap();
    assert_eq!(proposal.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = proposal.json().await.unwrap();
    let response = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "apply-1")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "{}: {}",
        response.status(),
        response.text().await.unwrap()
    );
    let content = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repo)
        .args(["show", "main:plan.md"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(content.stdout).unwrap(),
        "Approved text\n"
    );
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["fetch", "origin"])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["reset", "--hard", "origin/main"])
        .status()
        .unwrap()
        .success());
    std::fs::write(work.join("plan.md"), "Someone else's edit\n").unwrap();
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["add", "plan.md"])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["commit", "-m", "external edit"])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["push", "origin", "main"])
        .status()
        .unwrap()
        .success());
    let undo = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/undo",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::CONFLICT);
    let undo: serde_json::Value = undo.json().await.unwrap();
    assert_eq!(undo["conflicts"][0]["file"], "plan.md");
    let second = client.post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project],"vault_ids":[vault]},"items":[{"id":"add","kind":"file_add","vault_id":vault,"path":"summary.txt","content_base64":"YXBwbGllZA==","storage":"git","reason":"test","sources":[]}]}))
        .send().await.unwrap();
    assert_eq!(second.status(), reqwest::StatusCode::CREATED);
    let second: serde_json::Value = second.json().await.unwrap();
    let second_approve = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            second["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "apply-2")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert!(second_approve.status().is_success());
    let applied_head = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repo)
        .args(["rev-parse", "main"])
        .output()
        .unwrap();
    let applied_head = String::from_utf8(applied_head.stdout).unwrap();
    let second_undo = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/undo",
            second["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .send()
        .await
        .unwrap();
    assert!(
        second_undo.status().is_success(),
        "{}",
        second_undo.text().await.unwrap()
    );
    let reverted_head = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repo)
        .args(["rev-parse", "main"])
        .output()
        .unwrap();
    assert_ne!(
        String::from_utf8(reverted_head.stdout).unwrap(),
        applied_head
    );
    let absent = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repo)
        .args(["cat-file", "-e", "main:summary.txt"])
        .status()
        .unwrap();
    assert!(!absent.success());
    let binary = client.post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project],"vault_ids":[vault]},"items":[{"id":"binary","kind":"file_add","vault_id":vault,"path":"archive/data.bin","content_base64":"AAECAwQ=","storage":"lfs","reason":"binary test","sources":[]}]}))
        .send().await.unwrap();
    assert_eq!(binary.status(), reqwest::StatusCode::CREATED);
    let binary: serde_json::Value = binary.json().await.unwrap();
    let binary_apply = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            binary["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "apply-binary")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert!(
        binary_apply.status().is_success(),
        "{}: {}",
        binary_apply.status(),
        binary_apply.text().await.unwrap()
    );
    let pointer = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repo)
        .args(["show", "main:archive/data.bin"])
        .output()
        .unwrap();
    assert!(pointer.status.success());
    let pointer = String::from_utf8(pointer.stdout).unwrap();
    assert!(
        pointer.starts_with("version https://git-lfs.github.com/spec/v1\n"),
        "expected a Git LFS pointer, got {pointer:?}"
    );
    let oid = pointer
        .lines()
        .find_map(|line| line.strip_prefix("oid sha256:"))
        .expect("LFS pointer includes its object id");
    let lfs_object = repo
        .join("lfs/objects")
        .join(&oid[..2])
        .join(&oid[2..4])
        .join(oid);
    assert_eq!(std::fs::read(lfs_object).unwrap(), [0, 1, 2, 3, 4]);

    let recovery = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project],"vault_ids":[vault]},"items":[{"id":"recovery","kind":"file_add","vault_id":vault,"path":"recovery.md","content_base64":"c3RhcnQ=","storage":"git","reason":"recovery test","sources":[]}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(recovery.status(), reqwest::StatusCode::CREATED);
    let recovery: serde_json::Value = recovery.json().await.unwrap();
    let recovery_apply = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            recovery["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "apply-recovery")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert!(recovery_apply.status().is_success());
    let recovery_apply: serde_json::Value = recovery_apply.json().await.unwrap();
    let (base, applied): (String, String) = sqlx::query_as(
        "SELECT base_commit,prepared_commit FROM knowledge_apply_groups WHERE proposal_id=$1",
    )
    .bind(Uuid::parse_str(recovery["id"].as_str().unwrap()).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(base, recovery_apply["knowledge"][0]["base_commit"]);
    let indexed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vault_indexed_files WHERE vault_id=$1 AND path='recovery.md'",
    )
    .bind(vault)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(indexed, 1);

    // Simulate a process crash after the revert ref move but before index/status commit.
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["fetch", "origin"])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["reset", "--hard", "origin/main"])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["revert", "--no-edit", &applied])
        .status()
        .unwrap()
        .success());
    let revert = std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    let revert = String::from_utf8(revert.stdout).unwrap().trim().to_owned();
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["push", "origin", "main"])
        .status()
        .unwrap()
        .success());
    sqlx::query("UPDATE knowledge_apply_groups SET state='undoing',undo_base_commit=$2,undo_commit=$3 WHERE proposal_id=$1")
        .bind(Uuid::parse_str(recovery["id"].as_str().unwrap()).unwrap()).bind(&applied).bind(&revert)
        .execute(&db).await.unwrap();
    sqlx::query("UPDATE proposals SET status='applying' WHERE id=$1")
        .bind(Uuid::parse_str(recovery["id"].as_str().unwrap()).unwrap())
        .execute(&db)
        .await
        .unwrap();
    server.abort();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let recovery_origin = format!("http://{}", listener.local_addr().unwrap());
    let recovery_server = tokio::spawn(serve(
        listener,
        ServerConfig::new(
            db_url.clone(),
            env::temp_dir().join(format!("weft-{schema}")),
        ),
    ));
    for _ in 0..3000 {
        let status = sqlx::query_scalar::<_, String>("SELECT status FROM proposals WHERE id=$1")
            .bind(Uuid::parse_str(recovery["id"].as_str().unwrap()).unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
        if status == "undone" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let recovered_status: String = sqlx::query_scalar("SELECT status FROM proposals WHERE id=$1")
        .bind(Uuid::parse_str(recovery["id"].as_str().unwrap()).unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(recovered_status, "undone");
    let indexed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM vault_indexed_files WHERE vault_id=$1 AND path='recovery.md'",
    )
    .bind(vault)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        indexed, 0,
        "recovery rebuilds the index after a moved revert ref"
    );
    let apply_recovery = client
        .post(format!("{recovery_origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project],"vault_ids":[vault]},"items":[{"id":"apply-recovery","kind":"file_add","vault_id":vault,"path":"apply-recovery.md","content_base64":"Y29tbWl0dGVk","storage":"git","reason":"recovery test","sources":[]}]}))
        .send().await.unwrap();
    assert_eq!(apply_recovery.status(), reqwest::StatusCode::CREATED);
    let apply_recovery: serde_json::Value = apply_recovery.json().await.unwrap();
    let applied_response = client
        .post(format!(
            "{recovery_origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            apply_recovery["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "apply-crash-recovery")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert!(applied_response.status().is_success());
    let (apply_base, apply_commit): (String, String) = sqlx::query_as(
        "SELECT base_commit,prepared_commit FROM knowledge_apply_groups WHERE proposal_id=$1",
    )
    .bind(Uuid::parse_str(apply_recovery["id"].as_str().unwrap()).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert!(std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repo)
        .args(["update-ref", "refs/heads/main", &apply_base])
        .status()
        .unwrap()
        .success());
    sqlx::query("UPDATE knowledge_apply_groups SET state='applying' WHERE proposal_id=$1")
        .bind(Uuid::parse_str(apply_recovery["id"].as_str().unwrap()).unwrap())
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("UPDATE proposals SET status='applying' WHERE id=$1")
        .bind(Uuid::parse_str(apply_recovery["id"].as_str().unwrap()).unwrap())
        .execute(&db)
        .await
        .unwrap();
    recovery_server.abort();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let final_server = tokio::spawn(serve(
        listener,
        ServerConfig::new(db_url, env::temp_dir().join(format!("weft-{schema}"))),
    ));
    for _ in 0..3000 {
        let status = sqlx::query_scalar::<_, String>("SELECT status FROM proposals WHERE id=$1")
            .bind(Uuid::parse_str(apply_recovery["id"].as_str().unwrap()).unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
        if status == "applied" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let recovered_status: String = sqlx::query_scalar("SELECT status FROM proposals WHERE id=$1")
        .bind(Uuid::parse_str(apply_recovery["id"].as_str().unwrap()).unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(recovered_status, "applied");
    let recovered_head = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repo)
        .args(["rev-parse", "refs/heads/main"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(recovered_head.stdout).unwrap().trim(),
        apply_commit
    );
    final_server.abort();
    server.abort();
    drop(db);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(repo);
    let _ = std::fs::remove_dir_all(work);
}

#[tokio::test(flavor = "multi_thread")]
async fn note_references_follow_apply_rename_delete_and_undo() {
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
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let db_url = format!("{base}?options=-csearch_path%3D{schema}");
    let db = sqlx::PgPool::connect(&db_url).await.unwrap();
    let vault = Uuid::new_v4();
    let repo = env::temp_dir().join(format!("weft-note-reference-{vault}.git"));
    let work = env::temp_dir().join(format!("weft-note-reference-work-{vault}"));
    assert!(std::process::Command::new("git")
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&repo)
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .args(["clone"])
        .arg(&repo)
        .arg(&work)
        .status()
        .unwrap()
        .success());
    std::fs::create_dir_all(work.join("Runbooks")).unwrap();
    std::fs::write(work.join("Runbooks/Guide.md"), "# Guide\n").unwrap();
    for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com")] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["config", key, value])
            .status()
            .unwrap()
            .success());
    }
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["add", "."])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["commit", "-m", "seed note"])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&work)
        .args(["push", "origin", "main"])
        .status()
        .unwrap()
        .success());
    let owner: (Uuid,) = sqlx::query_as(
        "SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND role='owner'",
    )
    .bind(Uuid::parse_str(workspace).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO vaults(id,workspace_id,name,visibility,repository_path,created_by) VALUES($1,$2,'Apply Vault','restricted',$3,$4)")
        .bind(vault).bind(Uuid::parse_str(workspace).unwrap()).bind(repo.to_string_lossy().as_ref()).bind(owner.0).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) VALUES($1,$2,$3,'manager')")
        .bind(Uuid::parse_str(workspace).unwrap()).bind(vault).bind(owner.0).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO vault_indexed_files(vault_id,path,text_content,title,search_text,parser_version) VALUES($1,'Runbooks/Guide.md','# Guide','Guide','Guide','comrak-0.59-index-1')")
        .bind(vault).execute(&db).await.unwrap();
    sqlx::query(
        "INSERT INTO vault_note_identities(id,vault_id,path) VALUES($1,$2,'Runbooks/Guide.md')",
    )
    .bind(Uuid::new_v4())
    .bind(vault)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO vault_search_states(vault_id,status,parser_version) VALUES($1,'ready','comrak-0.59-index-1')")
        .bind(vault).execute(&db).await.unwrap();

    let task: serde_json::Value = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/tasks"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"project_id":project,"title":"Cite the guide"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let comment: serde_json::Value = client
        .post(format!(
            "{origin}/api/v1/tasks/{}/comments",
            task["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"Read [[Apply Vault/Runbooks/Guide.md]]."}))
        .send().await.unwrap().json().await.unwrap();
    assert!(comment["html"]
        .as_str()
        .unwrap()
        .contains("Guide · Apply Vault"));

    async fn apply_item(
        client: &reqwest::Client,
        origin: &str,
        workspace: &str,
        session: &Session,
        scope: serde_json::Value,
        item: serde_json::Value,
        key: &str,
    ) -> String {
        let proposal_response = client
            .post(format!(
                "{origin}/api/v1/workspaces/{workspace}/proposals/mock"
            ))
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&serde_json::json!({"scope":scope,"items":[item]}))
            .send()
            .await
            .unwrap();
        let proposal_status = proposal_response.status();
        let proposal_body = proposal_response.text().await.unwrap();
        assert_eq!(
            proposal_status,
            reqwest::StatusCode::CREATED,
            "{proposal_body}"
        );
        let proposal: serde_json::Value = serde_json::from_str(&proposal_body).unwrap();
        let id = proposal["id"].as_str().unwrap().to_owned();
        let response = client
            .post(format!(
                "{origin}/api/v1/workspaces/{workspace}/proposals/{id}/approve"
            ))
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .header("idempotency-key", key)
            .json(&serde_json::json!({"revision":proposal["revision"]}))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body = response.text().await.unwrap();
        assert!(status.is_success(), "{status}: {body}");
        id
    }
    async fn comment_html(
        client: &reqwest::Client,
        origin: &str,
        task: &str,
        session: &Session,
    ) -> String {
        let response: serde_json::Value = client
            .get(format!("{origin}/api/v1/tasks/{task}/comments"))
            .header(reqwest::header::COOKIE, &session.cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        response["comments"][0]["html"].as_str().unwrap().to_owned()
    }
    let scope = serde_json::json!({"project_ids":[project],"vault_ids":[vault]});
    let rename = apply_item(&client,&origin,workspace,&session,scope.clone(),serde_json::json!({"id":"rename","kind":"note_edit","vault_id":vault,"path":"Runbooks/Guide.md","rename_to":"Runbooks/Renamed.md","content":"# Renamed Guide\n","link_fixes":[{"path":"Runbooks/Guide.md"}],"reason":"Rename the cited note","sources":[]}),"rename-note").await;
    assert!(
        comment_html(&client, &origin, task["id"].as_str().unwrap(), &session)
            .await
            .contains("Renamed Guide · Apply Vault")
    );
    let undo_rename = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{rename}/undo"
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .send()
        .await
        .unwrap();
    assert!(
        undo_rename.status().is_success(),
        "{}",
        undo_rename.text().await.unwrap()
    );
    assert!(
        comment_html(&client, &origin, task["id"].as_str().unwrap(), &session)
            .await
            .contains("Guide · Apply Vault")
    );

    let delete = apply_item(&client,&origin,workspace,&session,scope,serde_json::json!({"id":"delete","kind":"note_edit","vault_id":vault,"path":"Runbooks/Guide.md","delete":true,"reason":"Delete the cited note","sources":[]}),"delete-note").await;
    assert!(
        comment_html(&client, &origin, task["id"].as_str().unwrap(), &session)
            .await
            .contains("note deleted")
    );
    let undo_delete = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{delete}/undo"
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .send()
        .await
        .unwrap();
    assert!(
        undo_delete.status().is_success(),
        "{}",
        undo_delete.text().await.unwrap()
    );
    assert!(
        comment_html(&client, &origin, task["id"].as_str().unwrap(), &session)
            .await
            .contains("Guide · Apply Vault")
    );

    server.abort();
    drop(db);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(repo);
    let _ = std::fs::remove_dir_all(work);
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
        {"id":"schema-a","kind":"schema","name":"Proposal field","value_type":"text","reason":"Track proposal data","sources":["user request"]}
    ]})).send().await.unwrap();
    assert_eq!(create.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = create.json().await.unwrap();
    assert_eq!(proposal["schema_version"], 1);
    assert_eq!(proposal["revision"], 1);
    let id = proposal["id"].as_str().unwrap();
    let apply_url = format!("{origin}/api/v1/workspaces/{workspace}/proposals/{id}/approve");
    let approve = |key: &'static str, revision: i32| {
        client
            .post(&apply_url)
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .header("idempotency-key", key)
            .json(&serde_json::json!({"revision":revision}))
            .send()
    };
    let first_apply: serde_json::Value = approve("revision-1", 1)
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        first_apply["created_tasks"].as_array().unwrap().len(),
        1,
        "only the Task item creates a Task"
    );
    assert_eq!(
        approve("revision-1", 1)
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap(),
        first_apply,
        "retry returns the exact revision result"
    );
    let revised=client.patch(format!("{origin}/api/v1/workspaces/{workspace}/proposals/{id}")).header(reqwest::header::COOKIE,&session.cookie).header("x-csrf-token",&session.csrf).json(&serde_json::json!({"expected_revision":1,"items":[{"id":"task-a","kind":"task","project_id":project,"title":"Generated task revised","reason":"Mock plan revised","sources":["user request"],"selected":true}]})).send().await.unwrap();
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
        approve("revision-2", 2).await.unwrap().status(),
        reqwest::StatusCode::OK
    );
    let generic_undo = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/history/undo"
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(
        generic_undo.status(),
        reqwest::StatusCode::CONFLICT,
        "generic undo must not select an applied Proposal's operation group"
    );
    let proposal_status: String = sqlx::query_scalar("SELECT status FROM proposals WHERE id=$1")
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(proposal_status, "applied");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tasks WHERE title LIKE 'Generated task%'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 2, "retries within a revision do not create duplicates, while a revised approved plan applies its new task");
    let undo = || {
        client
            .post(format!(
                "{origin}/api/v1/workspaces/{workspace}/proposals/{id}/undo"
            ))
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
    };
    let (undo_a, undo_b) = tokio::join!(undo().send(), undo().send());
    let mut statuses = [undo_a.unwrap().status(), undo_b.unwrap().status()];
    statuses.sort();
    assert_eq!(
        statuses,
        [reqwest::StatusCode::OK, reqwest::StatusCode::CONFLICT]
    );
    assert_eq!(
        approve("revision-2-after-undo", 2).await.unwrap().status(),
        reqwest::StatusCode::CONFLICT
    );
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
    let relation_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM task_relations WHERE source_task_id=$1 OR target_task_id=ANY($2)",
    )
    .bind(Uuid::parse_str(existing["id"].as_str().unwrap()).unwrap())
    .bind(
        first_apply["created_tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|task| task["id"].as_str().and_then(|id| Uuid::parse_str(id).ok()))
            .collect::<Vec<_>>(),
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        relation_count, 0,
        "Proposal undo removes its created relation"
    );
    let source_version: i64 = sqlx::query_scalar("SELECT version FROM tasks WHERE id=$1")
        .bind(Uuid::parse_str(existing["id"].as_str().unwrap()).unwrap())
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(
        source_version, 3,
        "relation apply and undo each bump Task version"
    );
    let undo_relation_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM task_operations o JOIN task_operation_groups g ON g.id=o.group_id WHERE g.workspace_id=$1 AND o.field_key LIKE 'relation/%' AND o.after_value='false'::jsonb",
    )
    .bind(Uuid::parse_str(workspace).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        undo_relation_rows, 1,
        "Proposal undo records the reverse relation operation"
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
async fn proposal_rejects_invalid_skill_edits_before_creation() {
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
    let skills: serde_json::Value = client
        .get(format!("{origin}/api/v1/workspaces/{workspace}/skills"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let skill = skills["skills"].as_array().unwrap().first().unwrap();
    let second = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/skills"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "name":"Secondary Skill",
            "description":"A separate skill",
            "body":"Current body"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), reqwest::StatusCode::CREATED);
    let second: serde_json::Value = second.json().await.unwrap();
    let proposal = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project]},
            "items":[{"id":"invalid-skill","kind":"skill","skill_id":skill["id"],"expected_version":skill["version"],"name":"","reason":"test","sources":[]}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(proposal.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let collision = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project]},
            "items":[{"id":"colliding-skill","kind":"skill","skill_id":second["id"],"expected_version":second["version"],"name":skill["name"],"reason":"test","sources":[]}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        collision.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    let too_long = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project]},
            "items":[{"id":"long-skill","kind":"skill","skill_id":second["id"],"expected_version":second["version"],"body":"x".repeat(16_001),"reason":"test","sources":[]}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(too_long.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let late_collision = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project]},
            "items":[{"id":"late-collision","kind":"skill","skill_id":second["id"],"expected_version":second["version"],"name":"Late Collision","reason":"test","sources":[]}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(late_collision.status(), reqwest::StatusCode::CREATED);
    let late_collision: serde_json::Value = late_collision.json().await.unwrap();
    let inserted_collision = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/skills"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "name":"Late Collision",
            "description":"A concurrent skill",
            "body":"Body"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(inserted_collision.status(), reqwest::StatusCode::CREATED);
    let approval = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            late_collision["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "late-skill-collision")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(approval.status(), reqwest::StatusCode::CONFLICT);
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_rejects_duplicate_relation_cycles() {
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
    let mut tasks = Vec::new();
    for title in ["Duplicate A", "Duplicate B"] {
        let response = client
            .post(format!("{origin}/api/v1/workspaces/{workspace}/tasks"))
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&serde_json::json!({"project_id":project,"title":title}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::CREATED);
        tasks.push(response.json::<serde_json::Value>().await.unwrap());
    }
    let proposal = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project]},
            "items":[
                {"id":"duplicate-a-b","kind":"relation","relation":"duplicate","source_task_id":tasks[0]["id"],"target_task_id":tasks[1]["id"],"reason":"test","sources":[]},
                {"id":"duplicate-b-a","kind":"relation","relation":"duplicate","source_task_id":tasks[1]["id"],"target_task_id":tasks[0]["id"],"reason":"test","sources":[]}
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(proposal.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn edited_applied_proposal_remains_undoable() {
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
    let created = client
        .post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project]},
            "items":[{"id":"task","kind":"task","project_id":project,"title":"Created then edited","reason":"test","sources":[]}]
        }))
        .send()
        .await
        .unwrap();
    let proposal: serde_json::Value = created.json().await.unwrap();
    let id = proposal["id"].as_str().unwrap();
    assert_eq!(
        client
            .post(format!("{base}/{id}/approve"))
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .header("idempotency-key", "edit-undo-approve")
            .json(&serde_json::json!({"revision":1}))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    let edited = client
        .patch(format!("{base}/{id}"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "expected_revision":1,
            "items":[{"id":"task","kind":"task","project_id":project,"title":"Edited after approval","reason":"test","sources":[],"selected":true}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(edited.status(), reqwest::StatusCode::OK);
    let undone = client
        .post(format!("{base}/{id}/undo"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(undone.status(), reqwest::StatusCode::OK);
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
    let toggled=client.patch(&proposal_url).header(reqwest::header::COOKIE,&session.cookie).header("x-csrf-token",&session.csrf).json(&serde_json::json!({"expected_revision":proposal["revision"],"items":proposal["items"],"toggle":{"item_id":"first","selected":false}})).send().await.unwrap();
    assert_eq!(toggled.status(), reqwest::StatusCode::OK);
    let unticked: serde_json::Value = toggled.json().await.unwrap();
    assert_eq!(unticked["items"][0]["selected"], false);
    assert_eq!(
        unticked["items"][1]["selected"], false,
        "dependent item is unticked with prerequisite"
    );
    let reticked=client.patch(&proposal_url).header(reqwest::header::COOKIE,&session.cookie).header("x-csrf-token",&session.csrf).json(&serde_json::json!({"expected_revision":unticked["revision"],"items":unticked["items"],"toggle":{"item_id":"second","selected":true}})).send().await.unwrap();
    assert_eq!(reticked.status(), reqwest::StatusCode::OK);
    let selected: serde_json::Value = reticked.json().await.unwrap();
    assert_eq!(
        selected["items"][0]["selected"], true,
        "prerequisite is re-added when dependent is ticked"
    );
    assert_eq!(selected["items"][1]["selected"], true);
    let unauth = client
        .post(format!("{proposal_url}/approve"))
        .json(&serde_json::json!({"revision":selected["revision"]}))
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
        .json(&serde_json::json!({"revision":proposal["revision"]}))
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

#[tokio::test(flavor = "multi_thread")]
async fn proposal_approval_rejects_a_revision_the_reviewer_did_not_see() {
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
    let created = client.post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[{"id":"task","kind":"task","project_id":project,"title":"Reviewed task","reason":"test","sources":[]}]}))
        .send().await.unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = created.json().await.unwrap();
    let response = client
        .post(format!(
            "{base}/{}/approve",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "stale-revision")
        .json(&serde_json::json!({"revision":proposal["revision"].as_i64().unwrap() - 1}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["error"],
        "proposal_revision_changed"
    );
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_edit_rejects_a_stale_revision() {
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
    let created = client.post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[{"id":"task","kind":"task","project_id":project,"title":"Task","reason":"test","sources":[]}]}))
        .send().await.unwrap();
    let proposal: serde_json::Value = created.json().await.unwrap();
    let response = client
        .patch(format!("{base}/{}", proposal["id"].as_str().unwrap()))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"expected_revision":0,"items":proposal["items"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["error"],
        "proposal_revision_changed"
    );
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_read_and_undo_recheck_project_access() {
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
    let created = client.post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[{"id":"task","kind":"task","project_id":project,"title":"Private task","reason":"test","sources":[]}]}))
        .send().await.unwrap();
    let proposal: serde_json::Value = created.json().await.unwrap();
    let id = proposal["id"].as_str().unwrap();
    let approved = client
        .post(format!("{base}/{id}/approve"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "apply-before-revoke")
        .json(&serde_json::json!({"revision":proposal["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), reqwest::StatusCode::OK);

    let db_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let scoped = format!("{db_url}?options=-csearch_path%3D{schema}");
    let db = sqlx::PgPool::connect(&scoped).await.unwrap();
    sqlx::query("UPDATE projects SET visibility='restricted' WHERE id=$1")
        .bind(project)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1")
        .bind(project)
        .execute(&db)
        .await
        .unwrap();

    let read = client
        .get(format!("{base}/{id}"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(read.status(), reqwest::StatusCode::NOT_FOUND);
    let undo = client
        .post(format!("{base}/{id}/undo"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        undo.json::<serde_json::Value>().await.unwrap()["error"],
        "proposal_access_denied"
    );
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=(SELECT initiator_id FROM proposals WHERE id=$2)")
        .bind(Uuid::parse_str(workspace).unwrap()).bind(Uuid::parse_str(id).unwrap()).execute(&db).await.unwrap();
    let edit = client
        .patch(format!("{base}/{id}"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"expected_revision":1,"items":proposal["items"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(edit.status(), reqwest::StatusCode::FORBIDDEN);
    db.close().await;
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_cannot_apply_items_with_unselected_dependencies_or_relation_endpoints() {
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
    let bad_dependency = client.post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[
            {"id":"base","kind":"task","project_id":project,"title":"Base","reason":"test","sources":[],"selected":false},
            {"id":"dependent","kind":"task","project_id":project,"title":"Dependent","reason":"test","sources":[],"depends_on":["base"],"selected":true}
        ]})).send().await.unwrap();
    assert_eq!(
        bad_dependency.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    let created = client.post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[
            {"id":"base","kind":"task","project_id":project,"title":"Base","reason":"test","sources":[]},
            {"id":"dependent","kind":"task","project_id":project,"title":"Dependent","reason":"test","sources":[],"depends_on":["base"]},
            {"id":"link","kind":"relation","relation":"related","source_task_id":"base","target_task_id":"dependent","reason":"test","sources":[]}
        ]})).send().await.unwrap();
    let proposal: serde_json::Value = created.json().await.unwrap();
    let id = proposal["id"].as_str().unwrap();
    let unselected_endpoint = client.patch(format!("{base}/{id}"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"expected_revision":proposal["revision"],"items":proposal["items"],"toggle":{"item_id":"base","selected":false}})).send().await.unwrap();
    assert_eq!(
        unselected_endpoint.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_apply_reports_duplicate_relation_and_schema_as_conflicts() {
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
    let proposal_base = format!("{origin}/api/v1/workspaces/{workspace}/proposals");
    let task_url = format!("{origin}/api/v1/workspaces/{workspace}/tasks");
    let create_task = |title: &'static str| {
        client
            .post(&task_url)
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&serde_json::json!({"project_id":project,"title":title}))
    };
    let first: serde_json::Value = create_task("First")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let second: serde_json::Value = create_task("Second")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let relation_proposal = client.post(format!("{proposal_base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[{"id":"link","kind":"relation","relation":"related","source_task_id":first["id"],"target_task_id":second["id"],"reason":"test","sources":[]}]}))
        .send().await.unwrap();
    assert_eq!(relation_proposal.status(), reqwest::StatusCode::CREATED);
    let relation_proposal: serde_json::Value = relation_proposal.json().await.unwrap();
    let relation = client
        .post(format!(
            "{origin}/api/v1/tasks/{}/relations",
            first["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"target_task_id":second["id"],"kind":"related"}))
        .send()
        .await
        .unwrap();
    assert_eq!(relation.status(), reqwest::StatusCode::CREATED);
    let duplicate_relation = client
        .post(format!(
            "{proposal_base}/{}/approve",
            relation_proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "duplicate-relation")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate_relation.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        duplicate_relation
            .json::<serde_json::Value>()
            .await
            .unwrap()["detail"],
        "duplicate_relation"
    );

    let schema_proposal = client.post(format!("{proposal_base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[{"id":"schema","kind":"schema","name":"Concurrent field","value_type":"text","reason":"test","sources":[]}]}))
        .send().await.unwrap();
    assert_eq!(schema_proposal.status(), reqwest::StatusCode::CREATED);
    let schema_proposal: serde_json::Value = schema_proposal.json().await.unwrap();
    let create_schema = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/attributes"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"name":"Concurrent field","value_type":"text"}))
        .send()
        .await
        .unwrap();
    assert_eq!(create_schema.status(), reqwest::StatusCode::CREATED);
    let duplicate_schema = client
        .post(format!(
            "{proposal_base}/{}/approve",
            schema_proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "duplicate-schema")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate_schema.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        duplicate_schema.json::<serde_json::Value>().await.unwrap()["detail"],
        "duplicate_schema"
    );
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_related_links_are_canonical_and_graph_writes_cannot_race_into_a_cycle() {
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
    let proposal_base = format!("{origin}/api/v1/workspaces/{workspace}/proposals");
    let task_url = format!("{origin}/api/v1/workspaces/{workspace}/tasks");
    let create_task = |title: &'static str| {
        client
            .post(&task_url)
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&serde_json::json!({"project_id":project,"title":title}))
    };
    let first: serde_json::Value = create_task("Canonical first")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let second: serde_json::Value = create_task("Canonical second")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let third: serde_json::Value = create_task("Canonical third")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let (source, target) = if first["id"].as_str().unwrap() < second["id"].as_str().unwrap() {
        (&first, &second)
    } else {
        (&second, &first)
    };
    let created = client.post(format!("{proposal_base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[
            {"id":"link","kind":"relation","relation":"related","source_task_id":target["id"],"target_task_id":source["id"],"reason":"test","sources":[]},
            {"id":"second-link","kind":"relation","relation":"related","source_task_id":source["id"],"target_task_id":third["id"],"reason":"test","sources":[]}
        ]}))
        .send().await.unwrap();
    let proposal: serde_json::Value = created.json().await.unwrap();
    let approve = client
        .post(format!(
            "{proposal_base}/{}/approve",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "canonical-related")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(approve.status(), reqwest::StatusCode::OK);
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let db = sqlx::PgPool::connect(&format!("{base}?options=-csearch_path%3D{schema}"))
        .await
        .unwrap();
    let source_id = Uuid::parse_str(source["id"].as_str().unwrap()).unwrap();
    let target_id = Uuid::parse_str(target["id"].as_str().unwrap()).unwrap();
    let third_id = Uuid::parse_str(third["id"].as_str().unwrap()).unwrap();
    for (task, expected) in [(source_id, 3), (target_id, 2), (third_id, 2)] {
        let version: i64 = sqlx::query_scalar("SELECT version FROM tasks WHERE id=$1")
            .bind(task)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(
            version, expected,
            "Proposal relation writes bump Task versions"
        );
    }
    let relation_ledger_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM task_operations o JOIN proposal_undo_records u ON u.operation_group_id=o.group_id WHERE u.proposal_id=$1 AND (o.field_key LIKE 'relation/%' OR o.field_key LIKE 'relation_from/%')",
    )
    .bind(Uuid::parse_str(proposal["id"].as_str().unwrap()).unwrap())
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(
        relation_ledger_rows, 4,
        "each affected Task gets relation ledger rows"
    );
    let duplicate = client
        .post(format!(
            "{origin}/api/v1/tasks/{}/relations",
            source["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"target_task_id":target["id"],"kind":"related"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        duplicate.status(),
        reqwest::StatusCode::CONFLICT,
        "the task API recognizes the Proposal's canonical related link"
    );
    let undone = client
        .post(format!(
            "{proposal_base}/{}/undo",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .send()
        .await
        .unwrap();
    assert_eq!(undone.status(), reqwest::StatusCode::OK);
    let remaining_relations: i64 =
        sqlx::query_scalar("SELECT count(*) FROM task_relations WHERE source_task_id=ANY($1) OR target_task_id=ANY($1)")
            .bind(vec![source_id, target_id, third_id])
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(remaining_relations, 0);
    for (task, expected) in [(source_id, 5), (target_id, 3), (third_id, 3)] {
        let version: i64 = sqlx::query_scalar("SELECT version FROM tasks WHERE id=$1")
            .bind(task)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(version, expected, "Proposal undo also bumps Task versions");
    }
    db.close().await;

    let first: serde_json::Value = create_task("Race first")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let second: serde_json::Value = create_task("Race second")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let created = client.post(format!("{proposal_base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[{"id":"forward","kind":"relation","relation":"blocks","source_task_id":first["id"],"target_task_id":second["id"],"reason":"test","sources":[]}]}))
        .send().await.unwrap();
    let proposal: serde_json::Value = created.json().await.unwrap();
    let approve = client
        .post(format!(
            "{proposal_base}/{}/approve",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "graph-race")
        .json(&serde_json::json!({"revision":1}));
    let reverse = client
        .post(format!(
            "{origin}/api/v1/tasks/{}/relations",
            second["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"target_task_id":first["id"],"kind":"blocks"}));
    let (approved, reversed) = tokio::join!(approve.send(), reverse.send());
    let approved = approved.unwrap();
    let reversed = reversed.unwrap();
    let proposal_applied = approved.status().is_success();
    let reverse_applied = reversed.status().is_success();
    assert!(
        !(proposal_applied && reverse_applied),
        "graph locking must prevent both edges from forming a cycle"
    );
    assert!(
        proposal_applied
            || reversed.status() == reqwest::StatusCode::UNPROCESSABLE_ENTITY
            || approved.status() == reqwest::StatusCode::CONFLICT
    );
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_approval_rejects_a_skill_changed_after_review() {
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
    let skills: serde_json::Value = client
        .get(format!("{origin}/api/v1/workspaces/{workspace}/skills"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let skill = skills["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "How this Workspace works")
        .unwrap();
    let created = client.post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[{"id":"skill","kind":"skill","skill_id":skill["id"],"expected_version":skill["version"],"body":"Reviewed body","reason":"test","sources":[]}]}))
        .send().await.unwrap();
    let proposal: serde_json::Value = created.json().await.unwrap();
    let changed = client
        .patch(format!(
            "{origin}/api/v1/workspaces/{workspace}/skills/{}",
            skill["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(
            &serde_json::json!({"expected_version":skill["version"],"body":"Changed after review"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(changed.status(), reqwest::StatusCode::OK);
    let approve = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "stale-skill")
        .json(&serde_json::json!({"revision":proposal["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(approve.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        approve.json::<serde_json::Value>().await.unwrap()["detail"],
        "stale base version"
    );
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_undo_conflicts_when_a_related_task_changes() {
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
    let task_url = format!("{origin}/api/v1/workspaces/{workspace}/tasks");
    let create_task = |title: &'static str| {
        client
            .post(&task_url)
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&serde_json::json!({"project_id":project,"title":title}))
    };
    let first: serde_json::Value = create_task("Related first")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let second: serde_json::Value = create_task("Related second")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let base = format!("{origin}/api/v1/workspaces/{workspace}/proposals");
    let created = client.post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie).header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[{"id":"link","kind":"relation","relation":"related","source_task_id":first["id"],"target_task_id":second["id"],"reason":"test","sources":[]}]}))
        .send().await.unwrap();
    let proposal: serde_json::Value = created.json().await.unwrap();
    let id = proposal["id"].as_str().unwrap();
    let apply = client
        .post(format!("{base}/{id}/approve"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "related-undo")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    let applied: serde_json::Value = apply.json().await.unwrap();
    let number = first["number"].as_i64().unwrap();
    let changed = client
        .patch(format!(
            "{origin}/api/v1/workspaces/{workspace}/tasks/{number}"
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"expected_version":2,"title":"Changed after relation"}))
        .send()
        .await
        .unwrap();
    assert_eq!(changed.status(), reqwest::StatusCode::OK);
    let undo = client
        .post(format!("{base}/{id}/undo"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::CONFLICT);
    let detail = undo.json::<serde_json::Value>().await.unwrap();
    assert!(
        detail["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|conflict| conflict["reason"] == "relation_task_changed_or_missing"),
        "{detail}"
    );
    assert_eq!(applied["applied"], true);
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_mutations_enforce_actor_project_vault_and_csrf_access() {
    let (origin, server, schema, admin, project, owner_session) = fixture().await;
    let client = reqwest::Client::new();
    let me: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/me"))
        .header(reqwest::header::COOKIE, &owner_session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let workspace = Uuid::parse_str(me["workspaces"][0]["id"].as_str().unwrap()).unwrap();
    let base_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let db = sqlx::PgPool::connect(&format!("{base_url}?options=-csearch_path%3D{schema}"))
        .await
        .unwrap();
    let (contributor, contributor_session) = member_session(&db, workspace, "member").await;
    let (workspace_admin, admin_session) = member_session(&db, workspace, "admin").await;
    let (viewer, viewer_session) = member_session(&db, workspace, "viewer").await;
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')")
        .bind(workspace)
        .bind(project)
        .bind(contributor)
        .execute(&db)
        .await
        .unwrap();
    let proposal_url = format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock");
    let create_task_proposal = |session: &Session, title: &'static str| {
        client
            .post(&proposal_url)
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&serde_json::json!({
                "scope":{"project_ids":[project]},
                "items":[{"id":"task","kind":"task","project_id":project,"title":title,"reason":"test","sources":[]}]
            }))
    };
    assert_eq!(
        create_task_proposal(&admin_session, "Admin without project grant")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    assert_eq!(
        create_task_proposal(&viewer_session, "Viewer task")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    assert_ne!(workspace_admin, viewer);
    assert_eq!(
        client
            .post(&proposal_url)
            .header(reqwest::header::COOKIE, &owner_session.cookie)
            .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[]}))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN,
        "state-changing Proposal requests require CSRF"
    );
    let created = create_task_proposal(&owner_session, "Owned proposal")
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = created.json().await.unwrap();
    let id = proposal["id"].as_str().unwrap();
    let detail_url = format!("{origin}/api/v1/workspaces/{workspace}/proposals/{id}");
    let contributor_mutation = |method: reqwest::Method, url: String| {
        client
            .request(method, url)
            .header(reqwest::header::COOKIE, &contributor_session.cookie)
            .header("x-csrf-token", &contributor_session.csrf)
            .header("idempotency-key", "noninitiator")
            .json(
                &serde_json::json!({"expected_revision":1,"revision":1,"items":proposal["items"]}),
            )
    };
    assert_eq!(
        contributor_mutation(reqwest::Method::PATCH, detail_url.clone())
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    for action in ["approve", "undo"] {
        assert_eq!(
            contributor_mutation(reqwest::Method::POST, format!("{detail_url}/{action}"))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::FORBIDDEN
        );
    }
    let approved = client
        .post(format!("{detail_url}/approve"))
        .header(reqwest::header::COOKIE, &owner_session.cookie)
        .header("x-csrf-token", &owner_session.csrf)
        .header("idempotency-key", "owner-approved")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), reqwest::StatusCode::OK);
    assert_eq!(
        contributor_mutation(reqwest::Method::POST, format!("{detail_url}/undo"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );

    let vault = Uuid::new_v4();
    sqlx::query("INSERT INTO vaults(id,workspace_id,name,visibility,repository_path,created_by) VALUES($1,$2,'Restricted proposal vault','restricted',$3,(SELECT user_id FROM workspace_memberships WHERE workspace_id=$2 AND role='owner' LIMIT 1))")
        .bind(vault)
        .bind(workspace)
        .bind(format!("/tmp/{vault}"))
        .execute(&db)
        .await
        .unwrap();
    let restricted = client
        .post(&proposal_url)
        .header(reqwest::header::COOKIE, &contributor_session.cookie)
        .header("x-csrf-token", &contributor_session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project],"vault_ids":[vault]},
            "items":[{"id":"note","kind":"note_edit","vault_id":vault,"path":"note.md","content":"text","reason":"test","sources":[]}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(restricted.status(), reqwest::StatusCode::FORBIDDEN);
    let concurrent = create_task_proposal(&owner_session, "Concurrent approval")
        .send()
        .await
        .unwrap();
    let concurrent: serde_json::Value = concurrent.json().await.unwrap();
    let approve = || {
        client
            .post(format!(
                "{origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
                concurrent["id"].as_str().unwrap()
            ))
            .header(reqwest::header::COOKIE, &owner_session.cookie)
            .header("x-csrf-token", &owner_session.csrf)
            .header("idempotency-key", "same-concurrent-request")
            .json(&serde_json::json!({"revision":1}))
    };
    let (first, second) = tokio::join!(approve().send(), approve().send());
    assert_eq!(first.unwrap().status(), reqwest::StatusCode::OK);
    assert_eq!(second.unwrap().status(), reqwest::StatusCode::OK);
    let concurrent_tasks: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tasks WHERE title='Concurrent approval'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(concurrent_tasks, 1, "concurrent retries apply only once");
    db.close().await;
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_normalizes_relation_ids_before_validation_and_storage() {
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
    let workspace = Uuid::parse_str(me["workspaces"][0]["id"].as_str().unwrap()).unwrap();
    let mut tasks = Vec::new();
    for title in [
        "Block source",
        "Block target",
        "Duplicate source",
        "Duplicate target",
    ] {
        let response = client
            .post(format!("{origin}/api/v1/workspaces/{workspace}/tasks"))
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&serde_json::json!({"project_id":project,"title":title}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::CREATED);
        tasks.push(response.json::<serde_json::Value>().await.unwrap());
    }
    let block_source = Uuid::parse_str(tasks[0]["id"].as_str().unwrap()).unwrap();
    let block_target = Uuid::parse_str(tasks[1]["id"].as_str().unwrap()).unwrap();
    let duplicate_source = Uuid::parse_str(tasks[2]["id"].as_str().unwrap()).unwrap();
    let duplicate_target = Uuid::parse_str(tasks[3]["id"].as_str().unwrap()).unwrap();
    let scoped = format!(
        "{}?options=-csearch_path%3D{}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into()),
        schema
    );
    let db = sqlx::PgPool::connect(&scoped).await.unwrap();
    for (source, target, kind) in [
        (block_source, block_target, "blocks"),
        (duplicate_source, duplicate_target, "duplicate"),
    ] {
        sqlx::query("INSERT INTO task_relations(workspace_id,source_task_id,target_task_id,kind) VALUES($1,$2,$3,$4)")
            .bind(workspace)
            .bind(source)
            .bind(target)
            .bind(kind)
            .execute(&db)
            .await
            .unwrap();
    }
    let proposal_url = format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock");
    let propose = |items: serde_json::Value| {
        client
            .post(&proposal_url)
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":items}))
    };
    let block_cycle = propose(serde_json::json!([{
        "id":"block-cycle","kind":"relation","relation":"blocks",
        "source_task_id":block_target.to_string().to_uppercase(),
        "target_task_id":block_source.to_string(),"reason":"test","sources":[]
    }]))
    .send()
    .await
    .unwrap();
    let block_cycle_status = block_cycle.status();

    let duplicate_cycle = propose(serde_json::json!([{
        "id":"duplicate-cycle","kind":"relation","relation":"duplicate",
        "source_task_id":format!("{{{duplicate_target}}}"),
        "target_task_id":format!("{{{duplicate_source}}}"),"reason":"test","sources":[]
    }]))
    .send()
    .await
    .unwrap();
    let duplicate_cycle_status = duplicate_cycle.status();

    let self_relation = propose(serde_json::json!([{
        "id":"self-relation","kind":"relation","relation":"blocks",
        "source_task_id":block_source.to_string().to_uppercase(),
        "target_task_id":format!("{{{block_source}}}"),"reason":"test","sources":[]
    }]))
    .send()
    .await
    .unwrap();
    let self_relation_status = self_relation.status();

    let duplicate_proposal_relation = propose(serde_json::json!([
        {"id":"duplicate-form-a","kind":"relation","relation":"related","source_task_id":block_source.to_string().to_uppercase(),"target_task_id":block_target.to_string(),"reason":"test","sources":[]},
        {"id":"duplicate-form-b","kind":"relation","relation":"related","source_task_id":format!("{{{block_source}}}"),"target_task_id":block_target.to_string(),"reason":"test","sources":[]}
    ]))
    .send()
    .await
    .unwrap();
    let duplicate_proposal_relation_status = duplicate_proposal_relation.status();
    assert_eq!(
        [
            block_cycle_status,
            duplicate_cycle_status,
            self_relation_status,
            duplicate_proposal_relation_status
        ],
        [reqwest::StatusCode::UNPROCESSABLE_ENTITY; 4],
        "UUID endpoint variants must be treated as the same task across relation checks"
    );

    let normalized = propose(serde_json::json!([{
        "id":"normalized-relation","kind":"relation","relation":"related",
        "source_task_id":format!("{{{block_source}}}"),
        "target_task_id":block_target.to_string().to_uppercase(),"reason":"test","sources":[]
    }]))
    .send()
    .await
    .unwrap();
    assert_eq!(normalized.status(), reqwest::StatusCode::CREATED);
    let normalized: serde_json::Value = normalized.json().await.unwrap();
    assert_eq!(
        normalized["items"][0]["source_task_id"],
        block_source.to_string()
    );
    assert_eq!(
        normalized["items"][0]["target_task_id"],
        block_target.to_string()
    );
    let edited = client
        .patch(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}",
            normalized["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "expected_revision":1,
            "items":[{"id":"normalized-relation","kind":"relation","relation":"related","source_task_id":block_source.to_string().to_uppercase(),"target_task_id":format!("{{{block_target}}}"),"reason":"edited","sources":[],"selected":true}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(edited.status(), reqwest::StatusCode::OK);
    let edited: serde_json::Value = edited.json().await.unwrap();
    assert_eq!(
        edited["items"][0]["source_task_id"],
        block_source.to_string()
    );
    assert_eq!(
        edited["items"][0]["target_task_id"],
        block_target.to_string()
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
async fn proposal_ignores_stale_items_that_are_not_selected() {
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
    let workspace = Uuid::parse_str(me["workspaces"][0]["id"].as_str().unwrap()).unwrap();
    let task = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/tasks"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"project_id":project,"title":"Selected task"}))
        .send()
        .await
        .unwrap();
    assert_eq!(task.status(), reqwest::StatusCode::CREATED);
    let task: serde_json::Value = task.json().await.unwrap();
    let scoped = format!(
        "{}?options=-csearch_path%3D{}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into()),
        schema
    );
    let db = sqlx::PgPool::connect(&scoped).await.unwrap();
    let missing = Uuid::new_v4();
    let response = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project]},
            "items":[
                {"id":"selected-task","kind":"task","project_id":project,"title":"Selected task","reason":"test","sources":[],"selected":true},
                {"id":"stale-link","kind":"relation","relation":"blocks","source_task_id":task["id"],"target_task_id":missing,"reason":"outdated","sources":[],"selected":false}
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    db.close().await;
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_applies_trimmed_task_title() {
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
    let workspace = Uuid::parse_str(me["workspaces"][0]["id"].as_str().unwrap()).unwrap();
    let proposal = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project]},
            "items":[{"id":"trimmed-task","kind":"task","project_id":project,"title":"  Trimmed task  ","reason":"test","sources":[]}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(proposal.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = proposal.json().await.unwrap();
    assert_eq!(proposal["items"][0]["title"], "Trimmed task");
    let approved = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "trimmed-task-title")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), reqwest::StatusCode::OK);
    let scoped = format!(
        "{}?options=-csearch_path%3D{}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into()),
        schema
    );
    let db = sqlx::PgPool::connect(&scoped).await.unwrap();
    let title: String =
        sqlx::query_scalar("SELECT title FROM tasks WHERE title LIKE 'Trimmed task%'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(title, "Trimmed task");
    db.close().await;
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn proposal_applies_trimmed_skill_name_and_description() {
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
    let skills: serde_json::Value = client
        .get(format!("{origin}/api/v1/workspaces/{workspace}/skills"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let skill = skills["skills"].as_array().unwrap().first().unwrap();
    let proposal = client
        .post(format!("{origin}/api/v1/workspaces/{workspace}/proposals/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({
            "scope":{"project_ids":[project]},
            "items":[{"id":"trim-skill","kind":"skill","skill_id":skill["id"],"expected_version":skill["version"],"name":"  Trimmed Skill  ","description":"  Trimmed description  ","reason":"test","sources":[]}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(proposal.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = proposal.json().await.unwrap();
    assert_eq!(proposal["items"][0]["name"], "Trimmed Skill");
    assert_eq!(proposal["items"][0]["description"], "Trimmed description");
    let approved = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "trimmed-skill-fields")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(approved.status(), reqwest::StatusCode::OK);
    let updated: serde_json::Value = client
        .get(format!(
            "{origin}/api/v1/workspaces/{workspace}/skills/{}",
            skill["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(updated["name"], "Trimmed Skill");
    assert_eq!(updated["description"], "Trimmed description");
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

async fn two_tasks(
    client: &reqwest::Client,
    origin: &str,
    workspace: &str,
    project: Uuid,
    session: &Session,
) -> Vec<serde_json::Value> {
    let mut tasks = Vec::new();
    for title in ["Cycle X", "Cycle Y"] {
        let response = client
            .post(format!("{origin}/api/v1/workspaces/{workspace}/tasks"))
            .header(reqwest::header::COOKIE, &session.cookie)
            .header("x-csrf-token", &session.csrf)
            .json(&serde_json::json!({"project_id":project,"title":title}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::CREATED);
        tasks.push(response.json::<serde_json::Value>().await.unwrap());
    }
    tasks
}

async fn relation_count(admin: &sqlx::PgPool, schema: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {schema}.task_relations"))
        .fetch_one(admin)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blocks_loop_inside_one_proposal_is_refused_with_a_named_reason_and_writes_nothing() {
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
    let tasks = two_tasks(&client, &origin, workspace, project, &session).await;
    let base = format!("{origin}/api/v1/workspaces/{workspace}/proposals");
    let created = client
        .post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[
            {"id":"xy","kind":"relation","relation":"blocks","source_task_id":tasks[0]["id"],"target_task_id":tasks[1]["id"],"reason":"test","sources":[]},
            {"id":"yx","kind":"relation","relation":"blocks","source_task_id":tasks[1]["id"],"target_task_id":tasks[0]["id"],"reason":"test","sources":[]}
        ]}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = created.json().await.unwrap();
    assert_eq!(body["detail"], "relation cycle", "{body}");
    assert_eq!(relation_count(&admin, &schema).await, 0);
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_edge_added_after_review_is_refused_at_approve_as_a_named_relation_cycle() {
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
    let tasks = two_tasks(&client, &origin, workspace, project, &session).await;
    let base = format!("{origin}/api/v1/workspaces/{workspace}/proposals");
    let created = client
        .post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[
            {"id":"xy","kind":"relation","relation":"blocks","source_task_id":tasks[0]["id"],"target_task_id":tasks[1]["id"],"reason":"test","sources":[]}
        ]}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let proposal: serde_json::Value = created.json().await.unwrap();
    // After review, someone adds Y blocks X to the live graph.
    sqlx::query(&format!("INSERT INTO {schema}.task_relations(workspace_id,source_task_id,target_task_id,kind) SELECT workspace_id,$1,$2,'blocks' FROM {schema}.tasks WHERE id=$1"))
        .bind(tasks[1]["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .bind(tasks[0]["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(&admin)
        .await
        .unwrap();
    let approve = client
        .post(format!(
            "{base}/{}/approve",
            proposal["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .header("idempotency-key", "live-edge")
        .json(&serde_json::json!({"revision":proposal["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(approve.status(), reqwest::StatusCode::CONFLICT);
    let body: serde_json::Value = approve.json().await.unwrap();
    assert_eq!(body["error"], "proposal_invalid", "{body}");
    assert_eq!(body["detail"], "relation cycle", "{body}");
    assert_eq!(
        relation_count(&admin, &schema).await,
        1,
        "only the live edge"
    );
    // A new Proposal over the same loop is refused up front.
    let again = client
        .post(format!("{base}/mock"))
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
        .json(&serde_json::json!({"scope":{"project_ids":[project]},"items":[
            {"id":"xy","kind":"relation","relation":"blocks","source_task_id":tasks[0]["id"],"target_task_id":tasks[1]["id"],"reason":"test","sources":[]}
        ]}))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
