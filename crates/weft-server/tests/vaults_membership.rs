use sha2::{Digest, Sha256};
use std::{
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

#[derive(Clone)]
struct Session {
    user: Uuid,
    cookie: String,
    csrf: String,
}

struct Setup {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    pool: sqlx::PgPool,
    workspace: Uuid,
    owner: Session,
    member: Session,
    viewer: Session,
    vault_root: PathBuf,
}

async fn setup() -> Setup {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("vaults_{}_{}", std::process::id(), Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let scoped = format!("{base}?options=-csearch_path%3D{schema}");
    let vault_root = env::temp_dir().join(format!("weft-vault-repos-{schema}"));
    std::fs::create_dir_all(&vault_root).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    let web_root = env::temp_dir().join(format!("weft-web-{schema}"));
    std::fs::create_dir_all(&web_root).unwrap();
    std::fs::write(web_root.join("index.html"), "Weft").unwrap();
    let server_db = scoped.clone();
    let server_root = vault_root.clone();
    let server = tokio::spawn(async move {
        let config = ServerConfig::new(server_db, web_root).with_vault_root(server_root);
        let _ = serve(listener, config).await;
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
    weft_server::bootstrap_admin(&pool, "owner@example.com", "secret", "Test Workspace")
        .await
        .unwrap();
    let (workspace, owner): (Uuid, Uuid) = sqlx::query_as(
        "SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let member = add_user(&pool, workspace, "member@example.com", "member").await;
    let viewer = add_user(&pool, workspace, "viewer@example.com", "viewer").await;
    Setup {
        origin,
        server,
        schema,
        admin,
        pool: pool.clone(),
        workspace,
        owner: session(&pool, owner).await,
        member: session(&pool, member).await,
        viewer: session(&pool, viewer).await,
        vault_root,
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

async fn cleanup(setup: Setup) {
    setup.server.abort();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", setup.schema))
        .execute(&setup.admin)
        .await
        .unwrap();
    setup.admin.close().await;
    setup.pool.close().await;
    let _ = std::fs::remove_dir_all(setup.vault_root);
}

async fn create_vault(setup: &Setup, visibility: &str) -> Uuid {
    let response = request(
        &reqwest::Client::new(),
        reqwest::Method::POST,
        format!(
            "{}/api/v1/workspaces/{}/vaults",
            setup.origin, setup.workspace
        ),
        &setup.member,
    )
    .json(&serde_json::json!({"name":format!("Vault {visibility}"),"visibility":visibility}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    response.json::<serde_json::Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn visible_role(setup: &Setup, user: &Session, vault: Uuid) -> Option<String> {
    let response: serde_json::Value = request(
        &reqwest::Client::new(),
        reqwest::Method::GET,
        format!(
            "{}/api/v1/workspaces/{}/vaults",
            setup.origin, setup.workspace
        ),
        user,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    response["vaults"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == vault.to_string())
        .map(|entry| entry["role"].as_str().unwrap().to_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn member_creates_restricted_vault_as_first_manager_and_viewer_cannot_create() {
    let setup = setup().await;
    let client = reqwest::Client::new();
    let vaults_url = format!(
        "{}/api/v1/workspaces/{}/vaults",
        setup.origin, setup.workspace
    );

    let denied = request(
        &client,
        reqwest::Method::POST,
        vaults_url.clone(),
        &setup.viewer,
    )
    .json(&serde_json::json!({"name":"Handbook"}))
    .send()
    .await
    .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);

    let created = request(&client, reqwest::Method::POST, vaults_url, &setup.member)
        .json(&serde_json::json!({"name":"Handbook"}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let vault: serde_json::Value = created.json().await.unwrap();
    assert_eq!(vault["name"], "Handbook");
    assert_eq!(vault["visibility"], "restricted");
    let vault_id = vault["id"].as_str().unwrap().parse::<Uuid>().unwrap();

    let membership: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault_id}/members", setup.origin),
        &setup.member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(membership["members"][0]["principal_type"], "user");
    assert_eq!(
        membership["members"][0]["principal_id"],
        setup.member.user.to_string()
    );
    assert_eq!(membership["members"][0]["role"], "manager");

    let contents: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault_id}/contents", setup.origin),
        &setup.member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(contents["files"], serde_json::json!([]));
    let read_audit: i64 = sqlx::query_scalar("SELECT count(*) FROM security_audit_events WHERE workspace_id=$1 AND event='vault.contents.read' AND subject_id=$2")
        .bind(setup.workspace)
        .bind(vault_id)
        .fetch_one(&setup.pool)
        .await
        .unwrap();
    assert_eq!(read_audit, 1);

    let repo_path: String = sqlx::query_scalar("SELECT repository_path FROM vaults WHERE id=$1")
        .bind(vault_id)
        .fetch_one(&setup.pool)
        .await
        .unwrap();
    assert!(std::path::Path::new(&repo_path).join("HEAD").is_file());
    let repository = std::process::Command::new("git")
        .args(["--git-dir", &repo_path, "rev-parse", "--is-bare-repository"])
        .output()
        .unwrap();
    assert!(repository.status.success());
    assert_eq!(String::from_utf8_lossy(&repository.stdout).trim(), "true");
    let refs = std::process::Command::new("git")
        .args(["--git-dir", &repo_path, "show-ref"])
        .output()
        .unwrap();
    assert!(!refs.status.success());
    assert!(refs.stdout.is_empty());
    cleanup(setup).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn user_team_and_project_grants_resolve_independently_and_viewer_ceiling_caps_each() {
    let setup = setup().await;
    let vault = create_vault(&setup, "restricted").await;
    let roles = ["viewer", "contributor", "manager"];
    let kinds = ["user", "team", "project"];
    let client = reqwest::Client::new();
    let mut first_user_grant = None;

    for (index, principal_type) in kinds.iter().enumerate() {
        for role in roles {
            let identity = add_user(
                &setup.pool,
                setup.workspace,
                &format!("{principal_type}-{role}-{index}@example.com"),
                "member",
            )
            .await;
            let target = session(&setup.pool, identity).await;
            let principal_id = match *principal_type {
                "user" => identity,
                "team" => {
                    let team = Uuid::new_v4();
                    sqlx::query("INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,$3)")
                        .bind(team)
                        .bind(setup.workspace)
                        .bind(format!("{role} team {index}"))
                        .execute(&setup.pool)
                        .await
                        .unwrap();
                    sqlx::query("INSERT INTO team_memberships(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
                        .bind(setup.workspace)
                        .bind(team)
                        .bind(identity)
                        .execute(&setup.pool)
                        .await
                        .unwrap();
                    team
                }
                "project" => {
                    let project = Uuid::new_v4();
                    sqlx::query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,'restricted',$4)")
                        .bind(project)
                        .bind(setup.workspace)
                        .bind(format!("{role} project {index}"))
                        .bind(setup.member.user)
                        .execute(&setup.pool)
                        .await
                        .unwrap();
                    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')")
                        .bind(setup.workspace)
                        .bind(project)
                        .bind(identity)
                        .execute(&setup.pool)
                        .await
                        .unwrap();
                    project
                }
                _ => unreachable!(),
            };
            if *principal_type == "user" && role == "viewer" {
                first_user_grant = Some((principal_id, target.clone()));
            }
            let grant = request(
                &client,
                reqwest::Method::POST,
                format!("{}/api/v1/vaults/{vault}/members", setup.origin),
                &setup.member,
            )
            .json(&serde_json::json!({"principal_type":principal_type,"principal_id":principal_id,"role":role}))
            .send()
            .await
            .unwrap();
            assert_eq!(grant.status(), reqwest::StatusCode::NO_CONTENT);
            assert_eq!(
                visible_role(&setup, &target, vault).await.as_deref(),
                Some(role)
            );
        }
    }

    let (revoked_user, revoked_session) = first_user_grant.unwrap();
    let removed = request(
        &client,
        reqwest::Method::DELETE,
        format!(
            "{}/api/v1/vaults/{vault}/members/user/{revoked_user}",
            setup.origin
        ),
        &setup.member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(removed.status(), reqwest::StatusCode::NO_CONTENT);
    assert_eq!(visible_role(&setup, &revoked_session, vault).await, None);

    let viewer_id = add_user(
        &setup.pool,
        setup.workspace,
        "ceiling@example.com",
        "viewer",
    )
    .await;
    let ceiling_user = session(&setup.pool, viewer_id).await;
    let team = Uuid::new_v4();
    sqlx::query("INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,'Ceiling team')")
        .bind(team)
        .bind(setup.workspace)
        .execute(&setup.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO team_memberships(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
        .bind(setup.workspace)
        .bind(team)
        .bind(viewer_id)
        .execute(&setup.pool)
        .await
        .unwrap();
    let project = Uuid::new_v4();
    sqlx::query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,'Ceiling project','restricted',$3)")
        .bind(project)
        .bind(setup.workspace)
        .bind(setup.member.user)
        .execute(&setup.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')")
        .bind(setup.workspace)
        .bind(project)
        .bind(viewer_id)
        .execute(&setup.pool)
        .await
        .unwrap();
    for (principal_type, principal_id) in
        [("user", viewer_id), ("team", team), ("project", project)]
    {
        let grant = request(
            &client,
            reqwest::Method::POST,
            format!("{}/api/v1/vaults/{vault}/members", setup.origin),
            &setup.member,
        )
        .json(&serde_json::json!({"principal_type":principal_type,"principal_id":principal_id,"role":"manager"}))
        .send()
        .await
        .unwrap();
        assert_eq!(grant.status(), reqwest::StatusCode::NO_CONTENT);
        assert_eq!(
            visible_role(&setup, &ceiling_user, vault).await.as_deref(),
            Some("viewer")
        );
    }

    let owner_list = request(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/workspaces/{}/vaults",
            setup.origin, setup.workspace
        ),
        &setup.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(owner_list.status(), reqwest::StatusCode::OK);
    let before_self_grant = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/members", setup.origin),
        &setup.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(before_self_grant.status(), reqwest::StatusCode::OK);
    let admin_content = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/contents", setup.origin),
        &setup.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(admin_content.status(), reqwest::StatusCode::NOT_FOUND);
    let self_grant = request(
        &client,
        reqwest::Method::POST,
        format!("{}/api/v1/vaults/{vault}/members", setup.origin),
        &setup.owner,
    )
    .json(&serde_json::json!({"principal_type":"user","principal_id":setup.owner.user,"role":"manager"}))
    .send()
    .await
    .unwrap();
    assert_eq!(self_grant.status(), reqwest::StatusCode::NO_CONTENT);
    let audit_count: i64 = sqlx::query_scalar("SELECT count(*) FROM security_audit_events WHERE workspace_id=$1 AND event='vault.admin_self_membership' AND subject_id=$2")
        .bind(setup.workspace)
        .bind(vault)
        .fetch_one(&setup.pool)
        .await
        .unwrap();
    assert_eq!(audit_count, 1);
    let admin_content = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/contents", setup.origin),
        &setup.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(admin_content.status(), reqwest::StatusCode::OK);

    let workspace_vault = create_vault(&setup, "workspace").await;
    assert_eq!(
        visible_role(&setup, &ceiling_user, workspace_vault)
            .await
            .as_deref(),
        Some("viewer")
    );
    cleanup(setup).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn manager_can_import_a_vault_archive_and_observe_completion() {
    let setup = setup().await;
    let vault = create_vault(&setup, "restricted").await;
    let sample = env::temp_dir().join(format!("weft-vault-import-{}", Uuid::new_v4()));
    std::fs::create_dir_all(sample.join("Notes/nested")).unwrap();
    std::fs::create_dir_all(sample.join("Other")).unwrap();
    std::fs::create_dir_all(sample.join(".obsidian/plugins")).unwrap();
    std::fs::write(sample.join("Notes/nested/guide.md"), "# Imported note").unwrap();
    std::fs::write(sample.join("Other/guide.md"), "# Same name elsewhere").unwrap();
    std::fs::write(sample.join("Notes/image.png"), [0, 1, 2, 255]).unwrap();
    std::fs::write(
        sample.join(".obsidian/plugins/config.json"),
        "must stay hidden",
    )
    .unwrap();
    let archive = env::temp_dir().join(format!("weft-vault-import-{}.tar.gz", Uuid::new_v4()));
    let archived = std::process::Command::new("tar")
        .args(["-czf"])
        .arg(&archive)
        .arg("-C")
        .arg(&sample)
        .arg(".")
        .status()
        .unwrap();
    assert!(archived.success());
    let client = reqwest::Client::new();
    let denied = request(
        &client,
        reqwest::Method::POST,
        format!("{}/api/v1/vaults/{vault}/imports/archive", setup.origin),
        &setup.viewer,
    )
    .body("not an archive")
    .send()
    .await
    .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::NOT_FOUND);
    let response = request(
        &client,
        reqwest::Method::POST,
        format!("{}/api/v1/vaults/{vault}/imports/archive", setup.origin),
        &setup.member,
    )
    .header(reqwest::header::CONTENT_TYPE, "application/gzip")
    .body(std::fs::read(&archive).unwrap())
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let job: serde_json::Value = response.json().await.unwrap();
    let job_id = job["id"].as_str().unwrap();
    let mut status = serde_json::Value::Null;
    for _ in 0..100 {
        status = request(
            &client,
            reqwest::Method::GET,
            format!("{}/api/v1/vaults/{vault}/imports/{job_id}", setup.origin),
            &setup.member,
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        if status["status"] == "completed" || status["status"] == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(status["status"], "completed");
    assert_eq!(status["reindex_status"], "completed");
    let contents: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/contents", setup.origin),
        &setup.member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let files = contents["files"].as_array().unwrap();
    assert!(
        files.iter().any(|file| file == "Notes/nested/guide.md"),
        "{files:?}"
    );
    assert!(files.iter().any(|file| file == "Other/guide.md"));
    assert!(files.iter().any(|file| file == "Notes/image.png"));
    assert!(!files
        .iter()
        .any(|file| file.as_str().unwrap().starts_with(".obsidian/")));
    let repository: String = sqlx::query_scalar("SELECT repository_path FROM vaults WHERE id=$1")
        .bind(vault)
        .fetch_one(&setup.pool)
        .await
        .unwrap();
    let pointer = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repository)
        .args(["show", "HEAD:Notes/image.png"])
        .output()
        .unwrap();
    let pointer = String::from_utf8(pointer.stdout).unwrap();
    assert!(pointer.contains("oid sha256:"));
    assert!(pointer.contains("size 4"));
    let hidden_config = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repository)
        .args(["show", "HEAD:.obsidian/plugins/config.json"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(hidden_config.stdout).unwrap(),
        "must stay hidden"
    );
    let indexed_paths: Vec<String> =
        sqlx::query_scalar("SELECT path FROM vault_indexed_files WHERE vault_id=$1 ORDER BY path")
            .bind(vault)
            .fetch_all(&setup.pool)
            .await
            .unwrap();
    assert!(indexed_paths
        .iter()
        .any(|path| path == "Notes/nested/guide.md"));
    assert!(!indexed_paths
        .iter()
        .any(|path| path.starts_with(".obsidian/")));
    let second_import = request(
        &client,
        reqwest::Method::POST,
        format!("{}/api/v1/vaults/{vault}/imports/archive", setup.origin),
        &setup.member,
    )
    .body("another archive")
    .send()
    .await
    .unwrap();
    assert_eq!(second_import.status(), reqwest::StatusCode::CONFLICT);
    let _ = std::fs::remove_dir_all(sample);
    let _ = std::fs::remove_file(archive);
    cleanup(setup).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn manager_can_mirror_repository_history_without_rewriting_existing_commits() {
    let setup = setup().await;
    let vault = create_vault(&setup, "restricted").await;
    let source = env::temp_dir().join(format!("weft-vault-source-{}", Uuid::new_v4()));
    let working = source.join("working");
    let exported = source.join("source.git");
    std::fs::create_dir_all(&working).unwrap();
    let run = |directory: &std::path::Path, args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(directory)
            .args(args)
            .output()
            .unwrap()
    };
    assert!(std::process::Command::new("git")
        .args(["init", "--initial-branch=main"])
        .arg(&working)
        .status()
        .unwrap()
        .success());
    std::fs::create_dir_all(working.join("Notes")).unwrap();
    std::fs::create_dir_all(working.join(".obsidian/plugins")).unwrap();
    std::fs::write(working.join("Notes/original.md"), "# History stays intact").unwrap();
    std::fs::write(
        working.join(".obsidian/plugins/settings.json"),
        "private config",
    )
    .unwrap();
    assert!(run(&working, &["add", "."]).status.success());
    assert!(run(
        &working,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "original vault",
        ],
    )
    .status
    .success());
    let original_commit = String::from_utf8(run(&working, &["rev-parse", "HEAD"]).stdout)
        .unwrap()
        .trim()
        .to_owned();
    assert!(std::process::Command::new("git")
        .args(["clone", "--bare"])
        .arg(&working)
        .arg(&exported)
        .status()
        .unwrap()
        .success());
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    drop(socket);
    let base_path = format!("--base-path={}", source.display());
    let listen_port = format!("--port={port}");
    let mut daemon = std::process::Command::new("git")
        .args([
            "daemon",
            "--reuseaddr",
            "--export-all",
            &base_path,
            "--listen=127.0.0.1",
            &listen_port,
        ])
        .spawn()
        .unwrap();
    let client = reqwest::Client::new();
    let response = request(
        &client,
        reqwest::Method::POST,
        format!("{}/api/v1/vaults/{vault}/imports", setup.origin),
        &setup.member,
    )
    .json(&serde_json::json!({"repository_url":format!("git://127.0.0.1:{port}/source.git")}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let job: serde_json::Value = response.json().await.unwrap();
    let job_id = job["id"].as_str().unwrap();
    let mut status = serde_json::Value::Null;
    for _ in 0..150 {
        status = request(
            &client,
            reqwest::Method::GET,
            format!("{}/api/v1/vaults/{vault}/imports/{job_id}", setup.origin),
            &setup.member,
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        if status["status"] == "completed" || status["status"] == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _ = daemon.kill();
    let _ = daemon.wait();
    assert_eq!(status["status"], "completed", "{status}");
    let repository: String = sqlx::query_scalar("SELECT repository_path FROM vaults WHERE id=$1")
        .bind(vault)
        .fetch_one(&setup.pool)
        .await
        .unwrap();
    assert!(std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repository)
        .args(["cat-file", "-e", &original_commit])
        .status()
        .unwrap()
        .success());
    let contents: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/contents", setup.origin),
        &setup.member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let files = contents["files"].as_array().unwrap();
    assert!(files.iter().any(|path| path == "Notes/original.md"));
    assert!(!files
        .iter()
        .any(|path| path.as_str().unwrap().starts_with(".obsidian/")));
    let attributes = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(&repository)
        .args(["show", "HEAD:.gitattributes"])
        .output()
        .unwrap();
    assert!(String::from_utf8(attributes.stdout)
        .unwrap()
        .contains("*.png filter=lfs"));
    let _ = std::fs::remove_dir_all(source);
    cleanup(setup).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_vault_archive_reports_a_failed_import_job() {
    let setup = setup().await;
    let vault = create_vault(&setup, "restricted").await;
    let client = reqwest::Client::new();
    let response = request(
        &client,
        reqwest::Method::POST,
        format!("{}/api/v1/vaults/{vault}/imports/archive", setup.origin),
        &setup.member,
    )
    .header(reqwest::header::CONTENT_TYPE, "application/gzip")
    .body("not a tar archive")
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let job: serde_json::Value = response.json().await.unwrap();
    let job_id = job["id"].as_str().unwrap();
    let mut status = serde_json::Value::Null;
    for _ in 0..100 {
        status = request(
            &client,
            reqwest::Method::GET,
            format!("{}/api/v1/vaults/{vault}/imports/{job_id}", setup.origin),
            &setup.member,
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
        if status["status"] == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(status["status"], "failed");
    assert_eq!(status["reindex_status"], "queued");
    assert!(status["error"]
        .as_str()
        .is_some_and(|message| !message.is_empty()));
    cleanup(setup).await;
}

fn push_reader_files(root: &Path, vault: Uuid, files: &[(&str, &[u8])]) -> (PathBuf, PathBuf) {
    let source = std::env::temp_dir().join(format!("weft-reader-source-{}", Uuid::new_v4()));
    let repository = root.join(format!("{vault}.git"));
    assert!(std::process::Command::new("git")
        .args(["init", "--initial-branch=main"])
        .arg(&source)
        .status()
        .unwrap()
        .success());
    for (path, content) in files {
        let destination = source.join(path);
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::write(destination, content).unwrap();
    }
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["add", "."])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&source)
        .args([
            "-c",
            "user.name=Reader Test",
            "-c",
            "user.email=reader@example.com",
            "commit",
            "-m",
            "reader fixture",
        ])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["push", repository.to_str().unwrap(), "main"])
        .status()
        .unwrap()
        .success());
    (source, repository)
}

#[tokio::test(flavor = "multi_thread")]
async fn reader_resolves_links_renders_safe_markdown_and_serves_lfs_files_and_history() {
    let setup = setup().await;
    let vault = create_vault(&setup, "restricted").await;
    let lfs_bytes = b"\x89PNG\r\n\x1a\nfixture image bytes";
    let digest = format!("{:x}", Sha256::digest(lfs_bytes));
    let pointer = format!(
        "version https://git-lfs.github.com/spec/v1\noid sha256:{digest}\nsize {}\n",
        lfs_bytes.len()
    );
    let home = b"---\ntitle: Home\naliases: [Start Here]\n---\n\n# Home\n\n[[Topic|Friendly topic]] and [[Topic#Details]] and [[Topic^block-id]] and [[Nowhere]]. [[Alias target]] [[Shared]] [[OnlyForeign]]\n\n![[image.png]]\n\n#knowledge\n\n> [!warning] Notice\n> Safe note.\n\n<details onclick=\"run()\"><script>run()</script></details>\n";
    let topic =
        b"---\naliases: [Alias target]\n---\n\n# Topic\n\n## Details\n\nTopic text. ^block-id\n";
    let (source, repository) = push_reader_files(
        &setup.vault_root,
        vault,
        &[
            ("Home.md", home),
            ("Topic.md", topic),
            ("east/Shared.md", b"# Shared from east"),
            ("west/Shared.md", b"# Shared from west"),
            ("image.png", pointer.as_bytes()),
            ("preview.html", b"<script>source only</script>"),
        ],
    );
    let foreign_vault = create_vault(&setup, "workspace").await;
    let (foreign_source, _) = push_reader_files(
        &setup.vault_root,
        foreign_vault,
        &[("OnlyForeign.md", b"# Foreign note")],
    );
    assert!(std::os::unix::fs::symlink("Home.md", source.join("Linked.md")).is_ok());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["add", "Linked.md"])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&source)
        .args([
            "-c",
            "user.name=Reader Test",
            "-c",
            "user.email=reader@example.com",
            "commit",
            "-m",
            "add symlink",
        ])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["push", repository.to_str().unwrap(), "main"])
        .status()
        .unwrap()
        .success());
    let lfs_object = repository
        .join("lfs/objects")
        .join(&digest[0..2])
        .join(&digest[2..4])
        .join(&digest);
    std::fs::create_dir_all(lfs_object.parent().unwrap()).unwrap();
    std::fs::write(&lfs_object, lfs_bytes).unwrap();

    let client = reqwest::Client::new();
    let contents: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/contents", setup.origin),
        &setup.member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(contents["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file == "Home.md"));
    let note_response = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/notes?path=Home.md", setup.origin),
        &setup.member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(
        note_response.status(),
        reqwest::StatusCode::OK,
        "note endpoint returned an unexpected status"
    );
    let note: serde_json::Value = note_response.json().await.unwrap();
    assert_eq!(note["properties"]["title"], "Home");
    assert_eq!(note["aliases"][0], "Start Here");
    assert!(note["tags"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag == "knowledge"));
    assert!(note["html"].as_str().unwrap().contains("callout"));
    assert!(note["html"]
        .as_str()
        .unwrap()
        .contains(&format!("/api/v1/vaults/{vault}/notes?path=Topic.md")));
    assert!(
        note["html"]
            .as_str()
            .unwrap()
            .contains(&format!("/api/v1/vaults/{vault}/files?path=image.png")),
        "rendered html: {}",
        note["html"]
    );
    assert!(note["html"].as_str().unwrap().contains("<img src="));
    assert!(note["html"].as_str().unwrap().contains("#weft-details"));
    assert!(
        note["html"]
            .as_str()
            .unwrap()
            .contains("#weft-block-block-id"),
        "rendered html: {}",
        note["html"]
    );
    assert!(!note["html"].as_str().unwrap().contains("<script"));
    assert!(!note["html"].as_str().unwrap().contains("onclick"));
    assert!(note["links"]
        .as_array()
        .unwrap()
        .iter()
        .any(|link| link["resolution"]["status"] == "unresolved"));
    assert!(note["links"]
        .as_array()
        .unwrap()
        .iter()
        .any(|link| link["resolution"]["path"] == "Topic.md"));
    assert!(note["links"].as_array().unwrap().iter().any(|link| {
        link["target"] == "Alias target" && link["resolution"]["path"] == "Topic.md"
    }));
    assert!(note["links"]
        .as_array()
        .unwrap()
        .iter()
        .any(|link| { link["target"] == "Shared" && link["resolution"]["status"] == "ambiguous" }));
    assert!(note["links"].as_array().unwrap().iter().any(|link| {
        link["target"] == "OnlyForeign" && link["resolution"]["status"] == "unresolved"
    }));

    let linked_note: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/notes?path=Topic.md", setup.origin),
        &setup.member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(linked_note["html"]
        .as_str()
        .unwrap()
        .contains("id=\"weft-details\""));
    assert!(linked_note["html"]
        .as_str()
        .unwrap()
        .contains("id=\"weft-block-block-id\""));

    let backlinks: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/vaults/{vault}/backlinks?path=Topic.md",
            setup.origin
        ),
        &setup.member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(backlinks["backlinks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|link| link["path"] == "Home.md"));

    let history: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/vaults/{vault}/history?path=Home.md",
            setup.origin
        ),
        &setup.member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(history["commits"][0]["author"], "Reader Test");
    assert!(!history["commits"][0]["time"].as_str().unwrap().is_empty());

    let file = request(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/vaults/{vault}/files?path=image.png",
            setup.origin
        ),
        &setup.member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(file.headers()[reqwest::header::CONTENT_TYPE], "image/png");
    assert_eq!(file.headers()["x-content-type-options"], "nosniff");
    assert!(file.headers()[reqwest::header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .starts_with("inline"));
    assert_eq!(file.bytes().await.unwrap().as_ref(), lfs_bytes);

    for route in ["notes?path=Linked.md", "files?path=Linked.md"] {
        let response = request(
            &client,
            reqwest::Method::GET,
            format!("{}/api/v1/vaults/{vault}/{route}", setup.origin),
            &setup.member,
        )
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    }

    let standalone: serde_json::Value = request(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/vaults/{vault}/notes?path=preview.html",
            setup.origin
        ),
        &setup.member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(standalone["format"], "source");
    assert_eq!(standalone["source"], "<script>source only</script>");

    let traversal = request(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/vaults/{vault}/notes?path=%2E%2E%2Fsecrets.md",
            setup.origin
        ),
        &setup.member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(traversal.status(), reqwest::StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(source);
    let _ = std::fs::remove_dir_all(foreign_source);
    cleanup(setup).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn nonmember_cannot_distinguish_existing_or_missing_vault_notes() {
    let setup = setup().await;
    let vault = create_vault(&setup, "restricted").await;
    let (source, _) = push_reader_files(&setup.vault_root, vault, &[("Known.md", b"# Known")]);
    let client = reqwest::Client::new();
    for path in ["Known.md", "Missing.md"] {
        let response = request(
            &client,
            reqwest::Method::GET,
            format!("{}/api/v1/vaults/{vault}/notes?path={path}", setup.origin),
            &setup.viewer,
        )
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
        assert!(response.bytes().await.unwrap().is_empty());
    }
    let file = request(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/files?path=Known.md", setup.origin),
        &setup.viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(file.status(), reqwest::StatusCode::NOT_FOUND);
    assert!(file.bytes().await.unwrap().is_empty());
    let _ = std::fs::remove_dir_all(source);
    cleanup(setup).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn viewer_reads_a_rendered_note_through_the_vault_api() {
    let setup = setup().await;
    let vault = create_vault(&setup, "restricted").await;
    let repository = setup.vault_root.join(format!("{vault}.git"));
    let source = std::env::temp_dir().join(format!("weft-reader-source-{}", Uuid::new_v4()));
    assert!(std::process::Command::new("git")
        .args(["init", "--initial-branch=main"])
        .arg(&source)
        .status()
        .unwrap()
        .success());
    std::fs::write(
        source.join("Guide.md"),
        "# Guide\n\nHello from Knowledge.\n",
    )
    .unwrap();
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&source)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "add",
            "."
        ])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&source)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "add guide"
        ])
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["push", repository.to_str().unwrap(), "main"])
        .status()
        .unwrap()
        .success());

    let response = request(
        &reqwest::Client::new(),
        reqwest::Method::GET,
        format!("{}/api/v1/vaults/{vault}/notes?path=Guide.md", setup.origin),
        &setup.member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let note: serde_json::Value = response.json().await.unwrap();
    assert_eq!(note["path"], "Guide.md");
    assert!(note["html"]
        .as_str()
        .unwrap()
        .contains("Hello from Knowledge."));

    let _ = std::fs::remove_dir_all(source);
    cleanup(setup).await;
}
