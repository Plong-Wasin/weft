use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

pub async fn backup(destination: &Path) -> Result<()> {
    let database_url = env::var("DATABASE_URL")?;
    weft_server::set_maintenance_mode(&database_url, true).await?;
    let staging = temp_dir("weft-backup")?;
    let result = async {
        let pool = weft_server::connect(&database_url).await?;
        let inventory = inventory(&pool).await?;
        pool.close().await;
        let mut dump = Command::new("pg_dump");
        dump.args(["--format=custom", "--no-owner", "--file"])
            .arg(staging.join("database.dump"));
        configure_pg_connection(&mut dump, &database_url)?;
        run(&mut dump)?;

        let attachments = configured_path("WEFT_ATTACHMENT_ROOT", "/var/lib/weft/attachments");
        let vaults = configured_path("WEFT_VAULT_ROOT", "/var/lib/weft/vaults");
        archive_directory(&attachments, &staging.join("attachments.tar.gz"))?;
        archive_directory(&vaults, &staging.join("vaults.tar.gz"))?;
        let config = serde_json::json!({
            "web_root": env::var("WEFT_WEB_ROOT").unwrap_or_else(|_| "/app/web".into()),
            "attachment_root": attachments,
            "vault_root": vaults,
            "database_url_included": false,
            "secrets_note": "Supply DATABASE_URL and any deployment secrets separately during restore."
        });
        fs::write(staging.join("config.json"), serde_json::to_vec_pretty(&config)?)?;
        fs::write(staging.join("inventory.json"), serde_json::to_vec_pretty(&inventory)?)?;
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        run(Command::new("tar").arg("-czf").arg(destination).arg("-C").arg(&staging).args(["database.dump", "attachments.tar.gz", "vaults.tar.gz", "config.json", "inventory.json"]))?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }.await;
    let _ = fs::remove_dir_all(&staging);
    result?;
    eprintln!("backup created at {} (maintenance remains enabled; run `weft maintenance off` after verification)", destination.display());
    Ok(())
}

pub async fn restore(archive: &Path) -> Result<()> {
    let database_url = env::var("DATABASE_URL")?;
    let staging = temp_dir("weft-restore")?;
    let result = async {
        run(Command::new("tar").arg("-xzf").arg(archive).arg("-C").arg(&staging))?;
        let attachments = configured_path("WEFT_ATTACHMENT_ROOT", "/var/lib/weft/attachments");
        let vaults = configured_path("WEFT_VAULT_ROOT", "/var/lib/weft/vaults");
        ensure_empty_or_missing(&attachments)?;
        ensure_empty_or_missing(&vaults)?;
        let config: serde_json::Value = serde_json::from_slice(&fs::read(staging.join("config.json"))?)?;
        let mut pg_restore = Command::new("pg_restore");
        pg_restore.args(["--clean", "--if-exists", "--no-owner", "--exit-on-error"]);
        configure_pg_connection(&mut pg_restore, &database_url)?;
        pg_restore.arg(staging.join("database.dump"));
        run(&mut pg_restore)?;
        fs::create_dir_all(&attachments)?;
        fs::create_dir_all(&vaults)?;
        run(Command::new("tar").arg("-xzf").arg(staging.join("attachments.tar.gz")).arg("-C").arg(&attachments))?;
        run(Command::new("tar").arg("-xzf").arg(staging.join("vaults.tar.gz")).arg("-C").arg(&vaults))?;
        let source_root = config["vault_root"].as_str().ok_or("backup has no Vault root")?;
        let pool = weft_server::connect(&database_url).await?;
        sqlx::query("UPDATE vaults SET repository_path=$2 || substring(repository_path from length($1)+1) WHERE left(repository_path,length($1))=$1")
            .bind(source_root)
            .bind(vaults.to_string_lossy().as_ref())
            .execute(&pool).await?;
        pool.close().await;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }.await;
    let _ = fs::remove_dir_all(&staging);
    result?;
    eprintln!(
        "restore completed; run `weft drill {}` before disabling maintenance",
        archive.display()
    );
    Ok(())
}

pub async fn drill(archive: &Path) -> Result<()> {
    let database_url = env::var("DATABASE_URL")?;
    let staging = temp_dir("weft-drill")?;
    let result = async {
        run(Command::new("tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(&staging))?;
        let expected: serde_json::Value =
            serde_json::from_slice(&fs::read(staging.join("inventory.json"))?)?;
        let pool = weft_server::connect(&database_url).await?;
        let actual = inventory(&pool).await?;
        pool.close().await;
        let mut differences = Vec::new();
        compare_json(&expected, &actual, "$", &mut differences);
        if !differences.is_empty() {
            return Err(format!("restore drill mismatch:\n{}", differences.join("\n")).into());
        }
        println!("restore drill passed: {}", actual);
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }
    .await;
    let _ = fs::remove_dir_all(&staging);
    result
}

fn compare_json(
    expected: &serde_json::Value,
    actual: &serde_json::Value,
    path: &str,
    differences: &mut Vec<String>,
) {
    match (expected, actual) {
        (serde_json::Value::Object(expected), serde_json::Value::Object(actual)) => {
            let keys = expected
                .keys()
                .chain(actual.keys())
                .collect::<std::collections::BTreeSet<_>>();
            for key in keys {
                let child = format!("{path}.{key}");
                match (expected.get(key), actual.get(key)) {
                    (Some(left), Some(right)) => compare_json(left, right, &child, differences),
                    (Some(left), None) => differences
                        .push(format!("{child}: missing after restore (expected {left})")),
                    (None, Some(right)) => {
                        differences.push(format!("{child}: unexpected after restore ({right})"))
                    }
                    (None, None) => unreachable!(),
                }
            }
        }
        (serde_json::Value::Array(expected), serde_json::Value::Array(actual)) => {
            if expected.len() != actual.len() {
                differences.push(format!(
                    "{path}: expected {} entries, found {}",
                    expected.len(),
                    actual.len()
                ));
            } else {
                for (index, (left, right)) in expected.iter().zip(actual).enumerate() {
                    compare_json(left, right, &format!("{path}[{index}]"), differences);
                }
            }
        }
        _ if expected != actual => {
            differences.push(format!("{path}: expected {expected}, found {actual}"))
        }
        _ => {}
    }
}

async fn inventory(pool: &sqlx::PgPool) -> Result<serde_json::Value> {
    let tasks: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks")
        .fetch_one(pool)
        .await?;
    let permission_rows = sqlx::query("SELECT 'workspace'::text AS kind,workspace_id::text AS resource,user_id::text AS principal,role FROM workspace_memberships UNION ALL SELECT 'project_user',project_id::text,user_id::text,role FROM project_memberships UNION ALL SELECT 'project_team',project_id::text,team_id::text,role FROM project_team_memberships UNION ALL SELECT 'team_user',team_id::text,user_id::text,'member'::text FROM team_memberships UNION ALL SELECT 'vault_user',vault_id::text,user_id::text,role FROM vault_user_memberships UNION ALL SELECT 'vault_team',vault_id::text,team_id::text,role FROM vault_team_memberships UNION ALL SELECT 'vault_project',vault_id::text,project_id::text,role FROM vault_project_memberships ORDER BY 1,2,3,4")
        .fetch_all(pool).await?;
    let permissions = permission_rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "kind":row.get::<String,_>("kind"),
                "resource":row.get::<String,_>("resource"),
                "principal":row.get::<String,_>("principal"),
                "role":row.get::<String,_>("role")
            })
        })
        .collect::<Vec<_>>();
    let groups = sqlx::query("SELECT id::text,workspace_id::text,actor_id::text,state,undo_reason,created_at::text FROM task_operation_groups ORDER BY id")
        .fetch_all(pool).await?.into_iter().map(|row| serde_json::json!({
            "id":row.get::<String,_>("id"),
            "workspace":row.get::<String,_>("workspace_id"),
            "actor":row.get::<String,_>("actor_id"),
            "state":row.get::<String,_>("state"),
            "undo_reason":row.get::<Option<String>,_>("undo_reason"),
            "created_at":row.get::<String,_>("created_at")
        })).collect::<Vec<_>>();
    let operations = sqlx::query("SELECT o.id::text,g.id::text AS group_id,o.task_id::text AS entity_id,'task'::text AS entity_type,o.field_key,o.before_value,o.after_value,o.task_version,o.suppressed,o.created_at::text FROM task_operations o JOIN task_operation_groups g ON g.id=o.group_id UNION ALL SELECT o.id::text,g.id::text,o.skill_id::text,'skill'::text,o.field_key,o.before_value,o.after_value,o.skill_version,o.suppressed,o.created_at::text FROM skill_operations o JOIN task_operation_groups g ON g.id=o.group_id ORDER BY 2,3,1")
        .fetch_all(pool).await?.into_iter().map(|row| serde_json::json!({
            "id":row.get::<String,_>("id"),
            "group":row.get::<String,_>("group_id"),
            "entity_type":row.get::<String,_>("entity_type"),
            "entity":row.get::<String,_>("entity_id"),
            "field":row.get::<String,_>("field_key"),
            "before":row.get::<serde_json::Value,_>("before_value"),
            "after":row.get::<serde_json::Value,_>("after_value"),
            "version":row.get::<i64,_>("task_version"),
            "suppressed":row.get::<bool,_>("suppressed"),
            "created_at":row.get::<String,_>("created_at")
        })).collect::<Vec<_>>();
    let attachments = sqlx::query("SELECT id::text,content FROM task_attachments ORDER BY id")
        .fetch_all(pool).await?.into_iter().map(|row| {
            let bytes: Vec<u8> = row.get("content");
            let digest = Sha256::digest(bytes);
            serde_json::json!({"id":row.get::<String,_>("id"),"sha256":digest.iter().map(|b|format!("{b:02x}")).collect::<String>()})
        }).collect::<Vec<_>>();
    let indexed = sqlx::query("SELECT path,text_content FROM vault_indexed_files WHERE text_content IS NOT NULL ORDER BY vault_id,path")
        .fetch_all(pool).await?;
    let note_count = indexed
        .iter()
        .filter(|row| {
            row.get::<String, _>("path")
                .to_ascii_lowercase()
                .ends_with(".md")
        })
        .count();
    let link_count: usize = indexed
        .iter()
        .map(|row| {
            let text: String = row.get("text_content");
            text.matches("[[").count().min(text.matches("]]").count())
        })
        .sum();
    let vault_rows = sqlx::query("SELECT id::text,repository_path FROM vaults ORDER BY id")
        .fetch_all(pool)
        .await?;
    let mut vaults = Vec::new();
    for row in vault_rows {
        let id: String = row.get("id");
        let repository: String = row.get("repository_path");
        let commit = git_head(Path::new(&repository))?;
        vaults.push(serde_json::json!({"id":id,"commit":commit}));
    }
    Ok(serde_json::json!({
        "tasks":tasks,
        "permissions":permissions,
        "history":{"groups":groups,"operations":operations},
        "attachments":attachments,
        "notes":note_count,
        "links":link_count,
        "vaults":vaults
    }))
}

fn git_head(repository: &Path) -> Result<Option<String>> {
    let bare = Command::new("git")
        .arg("--git-dir")
        .arg(repository)
        .args(["rev-parse", "--is-bare-repository"])
        .output()?;
    if !bare.status.success() || String::from_utf8_lossy(&bare.stdout).trim() != "true" {
        return Err(format!(
            "Vault repository {} is missing or invalid",
            repository.display()
        )
        .into());
    }
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(repository)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()?;
    if output.status.success() {
        Ok(Some(String::from_utf8(output.stdout)?.trim().to_owned()))
    } else if output.status.code() == Some(128) {
        let refs = Command::new("git")
            .arg("--git-dir")
            .arg(repository)
            .args(["show-ref", "--head"])
            .output()?;
        if refs.status.success() && !refs.stdout.is_empty() {
            Err(format!(
                "Vault repository {} has refs but no readable HEAD",
                repository.display()
            )
            .into())
        } else {
            Ok(None)
        }
    } else {
        Err(format!(
            "could not read Vault repository {}: {}",
            repository.display(),
            String::from_utf8_lossy(&output.stderr)
        )
        .into())
    }
}

fn archive_directory(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(source)?;
    run(Command::new("tar")
        .arg("-czf")
        .arg(destination)
        .arg("-C")
        .arg(source)
        .arg("."))?;
    Ok(())
}

fn configured_path(variable: &str, fallback: &str) -> PathBuf {
    env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(fallback))
}

fn ensure_empty_or_missing(path: &Path) -> Result<()> {
    if path.exists() && fs::read_dir(path)?.next().is_some() {
        return Err(format!("restore target {} is not empty", path.display()).into());
    }
    Ok(())
}

fn temp_dir(prefix: &str) -> Result<PathBuf> {
    let path = env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4().simple()));
    fs::create_dir(&path)?;
    Ok(path)
}

fn run(command: &mut Command) -> Result<Output> {
    let output = command.output()?;
    if !output.status.success() {
        return Err(format!(
            "external command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(output)
}

fn configure_pg_connection(command: &mut Command, database_url: &str) -> Result<()> {
    let mut parsed = url::Url::parse(database_url)?;
    let password = parsed.password().map(str::to_owned);
    if password.is_some() {
        parsed
            .set_password(None)
            .map_err(|_| "could not redact database password")?;
    }
    command.arg("--dbname").arg(parsed.as_str());
    if let Some(password) = password {
        command.env("PGPASSWORD", password);
    }
    Ok(())
}
