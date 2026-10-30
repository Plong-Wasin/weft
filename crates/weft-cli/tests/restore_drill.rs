use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{env, process::Command, time::Duration};
use uuid::Uuid;

#[tokio::test]
async fn restore_drill_checks_generated_tasks_access_history_attachments_and_vault_index() {
    tokio::time::timeout(Duration::from_secs(180), generated_restore_drill())
        .await
        .unwrap();
}

async fn generated_restore_drill() {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".to_owned());
    let admin = weft_server::connect(&base).await.unwrap();
    let schema = format!("drill_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let database_url = format!("{base}?options=-csearch_path%3D{schema}");
    weft_server::migrate(&database_url).await.unwrap();
    let bootstrap_pool = admin_pool(&database_url).await;
    weft_server::bootstrap_admin(
        &bootstrap_pool,
        "drill@example.com",
        "test password",
        "Drill Workspace",
    )
    .await
    .unwrap();
    bootstrap_pool.close().await;
    let pool = weft_server::connect(&database_url).await.unwrap();
    let workspace = sqlx::query("SELECT id FROM workspaces")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get::<Uuid, _>("id");
    let owner = sqlx::query("SELECT id FROM users")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get::<Uuid, _>("id");
    let project = Uuid::new_v4();
    let task = Uuid::new_v4();
    let team = Uuid::new_v4();
    let vault = Uuid::new_v4();
    let group = Uuid::new_v4();
    let attachment = Uuid::new_v4();
    let operation = Uuid::new_v4();
    let repo = env::temp_dir().join(format!("weft-drill-vault-{}", Uuid::new_v4().simple()));
    let source_repo =
        env::temp_dir().join(format!("weft-drill-source-{}", Uuid::new_v4().simple()));
    let source_for_git = source_repo.clone();
    let repo_for_git = repo.clone();
    let commit = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&source_for_git).unwrap();
        let run_git = |args: &[&str]| {
            let output = Command::new("git").args(args).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            output
        };
        let source = source_for_git.to_string_lossy().to_string();
        let bare = repo_for_git.to_string_lossy().to_string();
        run_git(&["init", &source]);
        run_git(&["-C", &source, "config", "user.name", "Restore drill"]);
        run_git(&[
            "-C",
            &source,
            "config",
            "user.email",
            "drill@example.invalid",
        ]);
        std::fs::write(source_for_git.join("Guide.md"), "Links to [[Runbook]]\n").unwrap();
        run_git(&["-C", &source, "add", "Guide.md"]);
        run_git(&["-C", &source, "commit", "-m", "Generated note"]);
        run_git(&["clone", "--bare", &source, &bare]);
        String::from_utf8(run_git(&["--git-dir", &bare, "rev-parse", "HEAD"]).stdout)
            .unwrap()
            .trim()
            .to_owned()
    })
    .await
    .unwrap();
    let bytes = b"restore drill attachment";
    let digest = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    sqlx::query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,'Restricted','restricted',$3)")
        .bind(project).bind(workspace).bind(owner).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')")
        .bind(workspace).bind(project).bind(owner).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,created_by) VALUES($1,$2,1,$3,'Generated task',$4)")
        .bind(task).bind(workspace).bind(project).bind(owner).execute(&pool).await.unwrap();
    sqlx::query("UPDATE workspaces SET next_task_number=2 WHERE id=$1")
        .bind(workspace)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id,state) VALUES($1,$2,$3,$4,'suppressed')")
        .bind(group).bind(Uuid::new_v4()).bind(workspace).bind(owner).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version,suppressed) VALUES($1,$2,$3,'title',$4,$5,2,true)")
        .bind(operation).bind(group).bind(task).bind(serde_json::json!("before")).bind(serde_json::json!("after"))
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO task_attachments(id,workspace_id,task_id,uploaded_by,file_name,content_type,content) VALUES($1,$2,$3,$4,'note.bin','application/octet-stream',$5)")
        .bind(attachment).bind(workspace).bind(task).bind(owner).bind(bytes.as_slice()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,'Operators')")
        .bind(team)
        .bind(workspace)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO team_memberships(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(team)
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_team_memberships(workspace_id,project_id,team_id,role) VALUES($1,$2,$3,'viewer')")
        .bind(workspace).bind(project).bind(team).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO vaults(id,workspace_id,name,visibility,repository_path,created_by) VALUES($1,$2,'Ops','restricted',$3,$4)")
        .bind(vault).bind(workspace).bind(repo.to_string_lossy().as_ref()).bind(owner).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) VALUES($1,$2,$3,'manager')")
        .bind(workspace).bind(vault).bind(owner).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO vault_team_memberships(workspace_id,vault_id,team_id,role) VALUES($1,$2,$3,'viewer')")
        .bind(workspace).bind(vault).bind(team).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO vault_project_memberships(workspace_id,vault_id,project_id,role) VALUES($1,$2,$3,'viewer')")
        .bind(workspace).bind(vault).bind(project).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO vault_indexed_files(vault_id,path,text_content) VALUES($1,'Guide.md','Links to [[Runbook]]')")
        .bind(vault).execute(&pool).await.unwrap();
    let group_created_at: String =
        sqlx::query_scalar("SELECT created_at::text FROM task_operation_groups WHERE id=$1")
            .bind(group)
            .fetch_one(&pool)
            .await
            .unwrap();
    let operation_created_at: String =
        sqlx::query_scalar("SELECT created_at::text FROM task_operations WHERE id=$1")
            .bind(operation)
            .fetch_one(&pool)
            .await
            .unwrap();

    let root = env::temp_dir().join(format!("weft-drill-archive-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&root).unwrap();
    let expected = serde_json::json!({
        "ai":{"runs":[],"proposals":[],"approvals":[],"secret_rows":0},
        "tasks":1,
        "permissions":[
            {"kind":"project_team","resource":project.to_string(),"principal":team.to_string(),"role":"viewer"},
            {"kind":"project_user","resource":project.to_string(),"principal":owner.to_string(),"role":"manager"},
            {"kind":"team_user","resource":team.to_string(),"principal":owner.to_string(),"role":"member"},
            {"kind":"vault_project","resource":vault.to_string(),"principal":project.to_string(),"role":"viewer"},
            {"kind":"vault_team","resource":vault.to_string(),"principal":team.to_string(),"role":"viewer"},
            {"kind":"vault_user","resource":vault.to_string(),"principal":owner.to_string(),"role":"manager"},
            {"kind":"workspace","resource":workspace.to_string(),"principal":owner.to_string(),"role":"owner"}
        ],
        "history":{
            "groups":[{"id":group.to_string(),"workspace":workspace.to_string(),"actor":owner.to_string(),"state":"suppressed","undo_reason":null,"created_at":group_created_at}],
            "operations":[{"id":operation.to_string(),"group":group.to_string(),"entity_type":"task","entity":task.to_string(),"field":"title","before":"before","after":"after","version":2,"suppressed":true,"created_at":operation_created_at}]
        },
        "attachments":[{"id":attachment.to_string(),"sha256":digest}],
        "notes":1,
        "links":1,
        "vaults":[{"id":vault.to_string(),"commit":commit}]
    });
    std::fs::write(
        root.join("inventory.json"),
        serde_json::to_vec(&expected).unwrap(),
    )
    .unwrap();
    let archive = root.join("generated-backup.tar.gz");
    let root_for_tar = root.clone();
    let archive_for_tar = archive.clone();
    let tar = tokio::task::spawn_blocking(move || {
        Command::new("tar")
            .arg("-czf")
            .arg(archive_for_tar)
            .arg("-C")
            .arg(root_for_tar)
            .arg("inventory.json")
            .status()
            .unwrap()
    })
    .await
    .unwrap();
    assert!(tar.success());
    let output = run_cli(
        vec!["drill".into(), archive.display().to_string()],
        database_url.clone(),
    )
    .await;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    sqlx::query("DELETE FROM tasks WHERE id=$1")
        .bind(task)
        .execute(&pool)
        .await
        .unwrap();
    let mismatch = run_cli(
        vec!["drill".into(), archive.display().to_string()],
        database_url.clone(),
    )
    .await;
    assert!(
        !mismatch.status.success(),
        "drill must fail when restored data differs"
    );

    pool.close().await;
    admin.close().await;
    let _ = tokio::fs::remove_dir_all(&root).await;
    let _ = tokio::fs::remove_dir_all(&repo).await;
    let _ = tokio::fs::remove_dir_all(&source_repo).await;
    let admin = weft_server::connect(&base).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}

async fn admin_pool(database_url: &str) -> sqlx::PgPool {
    weft_server::connect(database_url).await.unwrap()
}

async fn run_cli(args: Vec<String>, database_url: String) -> std::process::Output {
    tokio::time::timeout(
        Duration::from_secs(60),
        tokio::task::spawn_blocking(move || {
            Command::new(env!("CARGO_BIN_EXE_weft"))
                .args(args)
                .env("DATABASE_URL", database_url)
                .output()
                .unwrap()
        }),
    )
    .await
    .unwrap()
    .unwrap()
}
