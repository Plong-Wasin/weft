//! Backup and restore drill for AI records: runs, Proposals and approvals travel within the
//! retention window, provider credentials never do. The host has no PostgreSQL client tools, so
//! the tests put fake `pg_dump` and `pg_restore` programs first on PATH and assert what the CLI
//! asks them to do.

use sqlx::Row;
use std::{env, fs, os::unix::fs::PermissionsExt, path::Path, process::Command, time::Duration};
use uuid::Uuid;

/// `pg_restore --list` output captured from a real PostgreSQL 16 `pg_dump --format=custom
/// --no-owner --exclude-table-data=...` of the two secret tables: their structure is listed as
/// `TABLE`, their rows are absent, and other tables keep their `TABLE DATA` line.
const REAL_TOC_WITH_EXCLUSIONS: &str = ";\n; Archive created at 2026-10-30 06:07:51 UTC\n;     dbname: weft\n;     TOC Entries: 8\n;     Format: CUSTOM\n;     Dumped by pg_dump version: 16.15\n;\n;\n; Selected TOC Entries:\n;\n215; 1259 10908216 TABLE public ai_connection_credentials weft\n216; 1259 10908221 TABLE public ai_runner_pairing_codes weft\n217; 1259 10908226 TABLE public tasks weft\n3451; 0 10908226 TABLE DATA public tasks weft\n";

fn install_fake_tools(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    let dump = r#"#!/bin/sh
echo "$@" >> "$FAKE_LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = "--file" ]; then shift; echo dump > "$1"; fi
  shift
done
"#;
    let restore = r#"#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--list" ]; then cat "$FAKE_TOC"; exit 0; fi
done
exit 0
"#;
    for (name, body) in [("pg_dump", dump), ("pg_restore", restore)] {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

async fn run_cli(args: Vec<String>, envs: Vec<(String, String)>) -> std::process::Output {
    tokio::time::timeout(
        Duration::from_secs(120),
        tokio::task::spawn_blocking(move || {
            let mut command = Command::new(env!("CARGO_BIN_EXE_weft"));
            command.args(args);
            for (key, value) in envs {
                command.env(key, value);
            }
            command.output().unwrap()
        }),
    )
    .await
    .unwrap()
    .unwrap()
}

#[tokio::test]
async fn backup_carries_ai_records_within_retention_and_never_credentials() {
    tokio::time::timeout(Duration::from_secs(300), scenario())
        .await
        .unwrap();
}

async fn scenario() {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".to_owned());
    let admin = weft_server::connect(&base).await.unwrap();
    let schema = format!("ai_backup_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let database_url = format!("{base}?options=-csearch_path%3D{schema}");
    weft_server::migrate(&database_url).await.unwrap();
    let pool = weft_server::connect(&database_url).await.unwrap();
    weft_server::bootstrap_admin(&pool, "backup@example.com", "test password", "Backup")
        .await
        .unwrap();
    let workspace: Uuid = sqlx::query("SELECT id FROM workspaces")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("id");
    let owner: Uuid = sqlx::query("SELECT id FROM users")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("id");
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) VALUES($1,'workspace',$2,'scripted','api_key','api','ready','ready',$3)")
        .bind(connection).bind(workspace).bind(owner).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO ai_connection_credentials(connection_id,ciphertext) VALUES($1,$2)")
        .bind(connection)
        .bind(b"sealed-provider-key".as_slice())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO ai_runner_pairing_codes(id,connection_id,owner_id,code_hash,expires_at) VALUES($1,$2,$3,'hash',now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(connection).bind(owner).execute(&pool).await.unwrap();
    // One fresh and one expired run, each with a Proposal and an approval audit row.
    let mut ids = Vec::new();
    for age_days in [0_i32, 90] {
        let run = Uuid::new_v4();
        let proposal = Uuid::new_v4();
        sqlx::query("INSERT INTO ai_runs(id,initiator_id,workspace_id,connection_id,capability,scope,run_limits,prompt,session_key,state,summary,deadline_at,updated_at) VALUES($1,$2,$3,$4,'generate','{}','{}','plan','session','completed','done',now(),now()-make_interval(days=>$5))")
            .bind(run).bind(owner).bind(workspace).bind(connection).bind(age_days).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO proposals(id,workspace_id,initiator_id,scope,items,status,ai_run_id,provider,updated_at) VALUES($1,$2,$3,'{}','[]','applied',$4,'scripted',now()-make_interval(days=>$5))")
            .bind(proposal).bind(workspace).bind(owner).bind(run).bind(age_days).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO ai_approval_audit(id,workspace_id,run_id,proposal_id,proposal_revision,connection_id,provider,capability,initiator_id,approved_by,run_summary,run_scope,expires_at) VALUES($1,$2,$3,$4,1,$5,'scripted','generate',$6,$6,'done','{}',now()+make_interval(days=>30-$7))")
            .bind(Uuid::new_v4()).bind(workspace).bind(run).bind(proposal).bind(connection).bind(owner).bind(age_days).execute(&pool).await.unwrap();
        ids.push((run, proposal));
    }
    let (fresh_run, fresh_proposal) = ids[0];
    let (old_run, old_proposal) = ids[1];

    let root = env::temp_dir().join(format!("weft-ai-backup-{}", Uuid::new_v4().simple()));
    let tools = root.join("bin");
    install_fake_tools(&tools);
    let log = root.join("pg_dump.log");
    let toc = root.join("toc.txt");
    fs::write(&toc, REAL_TOC_WITH_EXCLUSIONS).unwrap();
    let archive = root.join("backup.tar.gz");
    let path = format!(
        "{}:{}",
        tools.display(),
        env::var("PATH").unwrap_or_default()
    );
    let envs = vec![
        ("DATABASE_URL".to_owned(), database_url.clone()),
        ("PATH".to_owned(), path),
        ("FAKE_LOG".to_owned(), log.display().to_string()),
        ("FAKE_TOC".to_owned(), toc.display().to_string()),
        (
            "WEFT_ATTACHMENT_ROOT".to_owned(),
            root.join("attachments").display().to_string(),
        ),
        (
            "WEFT_VAULT_ROOT".to_owned(),
            root.join("vaults").display().to_string(),
        ),
        ("WEFT_AI_RETENTION_DAYS".to_owned(), "30".to_owned()),
    ];
    let output = run_cli(
        vec!["backup".into(), archive.display().to_string()],
        envs.clone(),
    )
    .await;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    // The dump program was told to leave out every credential table's rows.
    let dump_args = fs::read_to_string(&log).unwrap();
    assert!(
        dump_args.contains("--exclude-table-data=ai_connection_credentials"),
        "{dump_args}"
    );
    assert!(
        dump_args.contains("--exclude-table-data=ai_runner_pairing_codes"),
        "{dump_args}"
    );

    // Backup never deletes data: records past the retention window are still in the live database.
    let count = |table: &'static str, column: &'static str, id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table} WHERE {column}=$1"))
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert_eq!(count("ai_runs", "id", fresh_run).await, 1);
    assert_eq!(count("proposals", "id", fresh_proposal).await, 1);
    assert_eq!(
        count("ai_approval_audit", "proposal_id", fresh_proposal).await,
        1
    );
    assert_eq!(count("ai_runs", "id", old_run).await, 1);
    assert_eq!(count("proposals", "id", old_proposal).await, 1);
    assert_eq!(
        count("ai_approval_audit", "proposal_id", old_proposal).await,
        1
    );

    // The archive inventory lists the retained records and promises no credential rows.
    let unpack = root.join("unpacked");
    fs::create_dir_all(&unpack).unwrap();
    assert!(Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(&unpack)
        .status()
        .unwrap()
        .success());
    let inventory: serde_json::Value =
        serde_json::from_slice(&fs::read(unpack.join("inventory.json")).unwrap()).unwrap();
    let ai = &inventory["ai"];
    let first_ids: Vec<&str> = ai["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run["id"].as_str().unwrap())
        .collect();
    assert!(first_ids.contains(&fresh_run.to_string().as_str()));
    assert!(first_ids.contains(&old_run.to_string().as_str()));
    assert_eq!(ai["secret_rows"], 0);
    assert!(
        !String::from_utf8_lossy(&fs::read(unpack.join("inventory.json")).unwrap())
            .contains("sealed-provider-key")
    );

    // The restore drill refuses a database that still holds credential rows ...
    let drill = |envs: Vec<(String, String)>| {
        run_cli(vec!["drill".into(), archive.display().to_string()], envs)
    };
    let live = drill(envs.clone()).await;
    assert!(
        !live.status.success(),
        "drill must flag credential rows after restore"
    );
    assert!(String::from_utf8_lossy(&live.stderr).contains("secret_rows"));
    // ... passes once none remain ...
    sqlx::query("DELETE FROM ai_connection_credentials")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM ai_runner_pairing_codes")
        .execute(&pool)
        .await
        .unwrap();
    let clean = drill(envs.clone()).await;
    assert!(
        clean.status.success(),
        "{}",
        String::from_utf8_lossy(&clean.stderr)
    );
    // ... fails when a restored record is missing ...
    sqlx::query("DELETE FROM ai_approval_audit")
        .execute(&pool)
        .await
        .unwrap();
    let missing = drill(envs.clone()).await;
    assert!(
        !missing.status.success(),
        "drill must flag a missing approval"
    );
    // ... and fails when the archive itself carries credential data.
    fs::write(
        &toc,
        "124; 0 16390 TABLE DATA public ai_connection_credentials weft\n",
    )
    .unwrap();
    let leaked = drill(envs.clone()).await;
    assert!(!leaked.status.success());
    assert!(String::from_utf8_lossy(&leaked.stderr).contains("credential rows"));

    // Pruning is its own explicit command.
    sqlx::query("INSERT INTO ai_approval_audit(id,workspace_id,run_id,proposal_id,proposal_revision,connection_id,provider,capability,initiator_id,approved_by,run_summary,run_scope,expires_at) VALUES($1,$2,$3,$4,1,$5,'scripted','generate',$6,$6,'done','{}',now()-interval '1 day')")
        .bind(Uuid::new_v4()).bind(workspace).bind(old_run).bind(old_proposal).bind(connection).bind(owner).execute(&pool).await.unwrap();
    let pruned = run_cli(vec!["prune-ai".into()], envs.clone()).await;
    assert!(
        pruned.status.success(),
        "{}",
        String::from_utf8_lossy(&pruned.stderr)
    );
    assert_eq!(count("ai_runs", "id", old_run).await, 0);
    assert_eq!(count("proposals", "id", old_proposal).await, 0);
    assert_eq!(count("ai_runs", "id", fresh_run).await, 1);

    // A run without a provider connection (MCP) is part of the drill inventory.
    let mcp_run = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_runs(id,initiator_id,workspace_id,connection_id,capability,scope,run_limits,prompt,session_key,state,summary,deadline_at) VALUES($1,$2,$3,NULL,'generate','{}','{}','plan','session','completed','done',now())")
        .bind(mcp_run).bind(owner).bind(workspace).execute(&pool).await.unwrap();
    let mcp_token = Uuid::new_v4();
    sqlx::query("INSERT INTO mcp_tokens(id,user_id,workspace_id,name,token_hash,capabilities) VALUES($1,$2,$3,'t','hash-mcp',ARRAY['read'])")
        .bind(mcp_token).bind(owner).bind(workspace).execute(&pool).await.unwrap();
    let runner_id = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_runners(id,connection_id,owner_id,name,version,token_hash) VALUES($1,$2,$3,'r','1','hash-runner')")
        .bind(runner_id).bind(connection).bind(owner).execute(&pool).await.unwrap();
    let second = root.join("second.tar.gz");
    let output = run_cli(
        vec!["backup".into(), second.display().to_string()],
        envs.clone(),
    )
    .await;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let second_unpack = root.join("second-unpacked");
    fs::create_dir_all(&second_unpack).unwrap();
    assert!(Command::new("tar")
        .arg("-xzf")
        .arg(&second)
        .arg("-C")
        .arg(&second_unpack)
        .status()
        .unwrap()
        .success());
    let second_inventory: serde_json::Value =
        serde_json::from_slice(&fs::read(second_unpack.join("inventory.json")).unwrap()).unwrap();
    let mcp_entry = second_inventory["ai"]["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|run| run["id"] == mcp_run.to_string())
        .expect("MCP run missing from inventory");
    assert_eq!(mcp_entry["provider"], "mcp");

    // Restore revokes runner and MCP tokens: both must be re-issued on the new installation.
    let mut restore_envs: Vec<(String, String)> = envs
        .into_iter()
        .filter(|(key, _)| key != "WEFT_ATTACHMENT_ROOT" && key != "WEFT_VAULT_ROOT")
        .collect();
    restore_envs.push((
        "WEFT_ATTACHMENT_ROOT".into(),
        root.join("restored-attachments").display().to_string(),
    ));
    restore_envs.push((
        "WEFT_VAULT_ROOT".into(),
        root.join("restored-vaults").display().to_string(),
    ));
    let restored = run_cli(
        vec!["restore".into(), second.display().to_string()],
        restore_envs,
    )
    .await;
    assert!(
        restored.status.success(),
        "{}",
        String::from_utf8_lossy(&restored.stderr)
    );
    let token_revoked: bool =
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM mcp_tokens WHERE id=$1")
            .bind(mcp_token)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(token_revoked);
    let runner_revoked: bool =
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM ai_runners WHERE id=$1")
            .bind(runner_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(runner_revoked);

    pool.close().await;
    let _ = fs::remove_dir_all(&root);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
}
