//! Cross-store Knowledge proposal application. Prepared commits are durable so startup
//! recovery can finish ref updates after PostgreSQL has committed.
use crate::{
    auth::{require_session, AuthState},
    projects::Role,
    vaults,
};
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use sqlx::Row;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use uuid::Uuid;

pub(crate) async fn approve(
    state: &AuthState,
    workspace: Uuid,
    id: Uuid,
    headers: &HeaderMap,
    body: &Value,
) -> Option<Response> {
    let actor = match require_session(&state.pool, headers, true).await {
        Ok((_, u)) => u,
        Err(s) => return Some(s.into_response()),
    };
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let revision = body["revision"].as_i64()?;
    if key.is_empty() {
        return None;
    }
    let row = match sqlx::query("SELECT revision,status,scope,items,initiator_id FROM proposals WHERE workspace_id=$1 AND id=$2").bind(workspace).bind(id).fetch_optional(&state.pool).await { Ok(Some(r))=>r, Ok(None)=>return None, Err(_)=>return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()) };
    let items: Value = row.get("items");
    let selected = items
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["selected"] == true)
        .collect::<Vec<_>>();
    if selected.is_empty()
        || selected
            .iter()
            .any(|i| !["note_edit", "file_add"].contains(&i["kind"].as_str().unwrap_or("")))
    {
        return None;
    }
    if row.get::<Uuid, _>("initiator_id") != actor {
        return Some(StatusCode::FORBIDDEN.into_response());
    }
    let rev: i32 = row.get("revision");
    if i64::from(rev) != revision {
        return Some(
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"proposal_revision_changed","revision":rev})),
            )
                .into_response(),
        );
    }
    if row.get::<String, _>("status") == "applied" {
        return Some(
            match sqlx::query_scalar::<_, Value>(
                "SELECT result FROM proposal_applications WHERE proposal_id=$1 AND revision=$2",
            )
            .bind(id)
            .bind(rev)
            .fetch_optional(&state.pool)
            .await
            {
                Ok(Some(v)) => (StatusCode::OK, Json(v)).into_response(),
                _ => StatusCode::CONFLICT.into_response(),
            },
        );
    }
    if !["pending", "ready"].contains(&row.get::<String, _>("status").as_str()) {
        return Some(StatusCode::CONFLICT.into_response());
    }
    let scope: Value = row.get("scope");
    let mut grouped = std::collections::BTreeMap::<Uuid, Vec<Value>>::new();
    for item in selected {
        let Some(vault) = item["vault_id"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            return Some(StatusCode::CONFLICT.into_response());
        };
        if !scope["vault_ids"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(&vault.to_string())))
            || !matches!(vaults::evaluate_access(&state.pool,vault,actor).await,Ok(Some(a)) if a.workspace_id==workspace && a.role>=Role::Contributor)
        {
            return Some(
                (
                    StatusCode::CONFLICT,
                    Json(json!({"error":"proposal_access_denied"})),
                )
                    .into_response(),
            );
        }
        grouped.entry(vault).or_default().push(item.clone());
    }
    let mut prepared = Vec::new();
    for (vault, changes) in grouped {
        let path = match sqlx::query_scalar::<_, String>(
            "SELECT repository_path FROM vaults WHERE id=$1 AND workspace_id=$2",
        )
        .bind(vault)
        .bind(workspace)
        .fetch_optional(&state.pool)
        .await
        {
            Ok(Some(p)) => PathBuf::from(p),
            _ => return Some(StatusCode::CONFLICT.into_response()),
        };
        match prepare(&path, &changes) {
            Ok((base, commit)) => prepared.push((vault, path, base, commit, changes)),
            Err(e) => {
                return Some(
                    (
                        StatusCode::CONFLICT,
                        Json(json!({"error":"knowledge_prepare_failed","detail":e})),
                    )
                        .into_response(),
                )
            }
        }
    }
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    };
    let result = json!({"proposal_id":id,"revision":rev,"applied":true,"knowledge":prepared.iter().map(|(v,_,b,c,_)|json!({"vault_id":v,"base_commit":b,"commit":c})).collect::<Vec<_>>()});
    if sqlx::query("UPDATE proposals SET status='applying',applied_revision=revision,apply_result=$2,updated_at=now() WHERE id=$1").bind(id).bind(&result).execute(&mut *tx).await.is_err(){return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());}
    for (vault, _, base, commit, _) in &prepared {
        if sqlx::query("INSERT INTO knowledge_apply_groups(proposal_id,revision,vault_id,base_commit,prepared_commit,state) VALUES($1,$2,$3,$4,$5,'applying')").bind(id).bind(rev).bind(vault).bind(base).bind(commit).execute(&mut *tx).await.is_err(){return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());}
        if replace_index(
            &mut tx,
            *vault,
            &prepared.iter().find(|p| p.0 == *vault).unwrap().1,
            commit,
        )
        .await
        .is_err()
        {
            return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    }
    if sqlx::query("INSERT INTO proposal_applications(proposal_id,revision,idempotency_key,result) VALUES($1,$2,$3,$4)").bind(id).bind(rev).bind(key).bind(&result).execute(&mut *tx).await.is_err(){return Some(StatusCode::CONFLICT.into_response());}
    if tx.commit().await.is_err() {
        return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    let mut failures = Vec::new();
    for (vault, path, base, commit, _) in &prepared {
        if update_ref(path, base, commit).is_err() {
            failures.push(vault);
        }
    }
    if failures.is_empty() {
        if sqlx::query("UPDATE knowledge_apply_groups SET state='applied' WHERE proposal_id=$1 AND revision=$2").bind(id).bind(rev).execute(&state.pool).await.is_err() || sqlx::query("UPDATE proposals SET status='applied' WHERE id=$1").bind(id).execute(&state.pool).await.is_err(){ return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()); }
        Some((StatusCode::OK, Json(result)).into_response())
    } else {
        let _=sqlx::query("UPDATE knowledge_apply_groups SET state='needs_attention',error='Could not advance main ref' WHERE proposal_id=$1 AND revision=$2").bind(id).bind(rev).execute(&state.pool).await;
        let _ = sqlx::query("UPDATE proposals SET status='needs_attention' WHERE id=$1")
            .bind(id)
            .execute(&state.pool)
            .await;
        Some(
            (
                StatusCode::ACCEPTED,
                Json(json!({"applied":false,"status":"needs_attention","vault_ids":failures})),
            )
                .into_response(),
        )
    }
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(repo)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}
fn git_bytes(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("--git-dir")
        .arg(repo)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}
fn prepare(repo: &Path, items: &[Value]) -> Result<(String, String), String> {
    let base = git(repo, &["rev-parse", "refs/heads/main"])?;
    let temp = std::env::temp_dir().join(format!("weft-apply-{}", Uuid::new_v4()));
    let clone = Command::new("git")
        .args(["clone", "--shared"])
        .arg(repo)
        .arg(&temp)
        .output()
        .map_err(|e| e.to_string())?;
    if !clone.status.success() {
        return Err("Vault clone failed".into());
    }
    for (key, val) in [("user.name", "Weft"), ("user.email", "weft@localhost")] {
        let _ = Command::new("git")
            .arg("-C")
            .arg(&temp)
            .args(["config", key, val])
            .status();
    }
    let result = (|| {
        for item in items {
            let path = item["path"].as_str().ok_or("path missing")?;
            validate_path(path)?;
            let content = if item["kind"] == "note_edit" {
                item["content"]
                    .as_str()
                    .ok_or("content missing")?
                    .as_bytes()
                    .to_vec()
            } else {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD
                    .decode(
                        item["content_base64"]
                            .as_str()
                            .ok_or("file content missing")?,
                    )
                    .map_err(|e| e.to_string())?
            };
            if content.len() > 50 * 1024 * 1024 {
                return Err("file_too_large".into());
            }
            let target = temp.join(path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(target, &content).map_err(|e| e.to_string())?;
        }
        let _ = Command::new("git")
            .arg("-C")
            .arg(&temp)
            .args(["lfs", "install", "--local"])
            .output();
        for item in items
            .iter()
            .filter(|item| item["kind"] == "file_add" && item["storage"] == "lfs")
        {
            let path = item["path"].as_str().unwrap_or("");
            let extension = Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ![
                "7z", "avif", "bmp", "doc", "docx", "exe", "gif", "gz", "heic", "jpg", "jpeg",
                "mov", "mp3", "mp4", "pdf", "png", "ppt", "pptx", "psd", "rar", "svgz", "tar",
                "tif", "tiff", "wav", "webm", "webp", "zip",
            ]
            .contains(&extension.as_str())
            {
                return Err("unsupported_lfs_extension".into());
            }
            let _ = Command::new("git")
                .arg("-C")
                .arg(&temp)
                .args(["lfs", "track", &format!("*.{extension}")])
                .output();
        }
        let add = Command::new("git")
            .arg("-C")
            .arg(&temp)
            .args(["add", "--all"])
            .output()
            .map_err(|e| e.to_string())?;
        if !add.status.success() {
            return Err(String::from_utf8_lossy(&add.stderr).to_string());
        }
        let commit = Command::new("git")
            .arg("-C")
            .arg(&temp)
            .args(["commit", "-m", "Apply approved Knowledge proposal"])
            .output()
            .map_err(|e| e.to_string())?;
        if !commit.status.success() {
            return Err(String::from_utf8_lossy(&commit.stderr).to_string());
        }
        let hash = Command::new("git")
            .arg("-C")
            .arg(&temp)
            .args(["rev-parse", "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;
        let commit = String::from_utf8_lossy(&hash.stdout).trim().to_owned();
        let fetch = Command::new("git")
            .arg("--git-dir")
            .arg(repo)
            .args(["fetch"])
            .arg(&temp)
            .arg(format!("{commit}:refs/weft/prepared/{commit}"))
            .output()
            .map_err(|e| e.to_string())?;
        if !fetch.status.success() {
            return Err(String::from_utf8_lossy(&fetch.stderr).to_string());
        }
        Ok((base, commit))
    })();
    let _ = std::fs::remove_dir_all(temp);
    result
}
fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        Err("invalid_path".into())
    } else {
        Ok(())
    }
}
fn update_ref(repo: &Path, base: &str, commit: &str) -> Result<(), String> {
    git(repo, &["update-ref", "refs/heads/main", commit, base]).map(|_| ())
}

async fn replace_index(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    vault: Uuid,
    repo: &Path,
    commit: &str,
) -> Result<(), String> {
    let names = git(repo, &["ls-tree", "-r", "--name-only", commit])?;
    let mut source = Vec::new();
    for path in names.lines().filter(|p| !p.is_empty()) {
        let bytes = git_bytes(repo, &["show", &format!("{commit}:{path}")])?;
        let text = String::from_utf8(bytes).ok();
        source.push((path.to_owned(), text));
    }
    let files = crate::knowledge::index::build(source);
    sqlx::query("DELETE FROM vault_indexed_files WHERE vault_id=$1")
        .bind(vault)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    for f in files {
        sqlx::query("INSERT INTO vault_indexed_files(vault_id,path,text_content,title,search_text,properties,tags,outgoing_links,parser_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(vault).bind(f.path).bind(f.text_content).bind(f.title).bind(f.search_text).bind(f.properties).bind(f.tags).bind(f.outgoing_links).bind(crate::knowledge::index::PARSER_VERSION).execute(&mut **tx).await.map_err(|e|e.to_string())?;
    }
    sqlx::query("INSERT INTO vault_search_states(vault_id,status,parser_version) VALUES($1,'ready',$2) ON CONFLICT(vault_id) DO UPDATE SET status='ready',parser_version=EXCLUDED.parser_version,updated_at=now()").bind(vault).bind(crate::knowledge::index::PARSER_VERSION).execute(&mut **tx).await.map_err(|e|e.to_string())?;
    Ok(())
}

pub(crate) async fn recover(pool: &sqlx::PgPool) {
    let rows=sqlx::query("SELECT proposal_id,revision,vault_id,base_commit,prepared_commit,repository_path,state,undo_base_commit,undo_commit FROM knowledge_apply_groups g JOIN vaults v ON v.id=g.vault_id WHERE g.state IN ('applying','needs_attention','undoing') ORDER BY vault_id").fetch_all(pool).await.unwrap_or_default();
    for row in rows {
        let id: Uuid = row.get("proposal_id");
        let rev: i32 = row.get("revision");
        let vault: Uuid = row.get("vault_id");
        let state: String = row.get("state");
        let undoing = state == "undoing";
        let base: Option<String> = if undoing {
            row.get("undo_base_commit")
        } else {
            Some(row.get("base_commit"))
        };
        let commit: Option<String> = if undoing {
            row.get("undo_commit")
        } else {
            Some(row.get("prepared_commit"))
        };
        let repo: String = row.get("repository_path");
        let (Some(base), Some(commit)) = (base, commit) else {
            continue;
        };
        let head = git(Path::new(&repo), &["rev-parse", "refs/heads/main"]).ok();
        let done = head.as_deref() == Some(commit.as_str())
            || update_ref(Path::new(&repo), &base, &commit).is_ok();
        if done {
            let target_state = if undoing { "undone" } else { "applied" };
            let _=sqlx::query("UPDATE knowledge_apply_groups SET state=$4,error=NULL WHERE proposal_id=$1 AND revision=$2 AND vault_id=$3").bind(id).bind(rev).bind(vault).bind(target_state).execute(pool).await;
        } else {
            let _=sqlx::query("UPDATE knowledge_apply_groups SET state='needs_attention',error='Vault main advanced beyond prepared commit' WHERE proposal_id=$1 AND revision=$2 AND vault_id=$3").bind(id).bind(rev).bind(vault).execute(pool).await;
        }
        let remaining:i64=sqlx::query_scalar("SELECT count(*) FROM knowledge_apply_groups WHERE proposal_id=$1 AND revision=$2 AND state<>$3").bind(id).bind(rev).bind(if undoing{"undone"}else{"applied"}).fetch_one(pool).await.unwrap_or(1);
        if remaining == 0 {
            let _ = sqlx::query(
                "UPDATE proposals SET status=$2 WHERE id=$1 AND status IN ('applying','needs_attention','applied')",
            )
            .bind(id)
            .bind(if undoing { "undone" } else { "applied" })
            .execute(pool)
            .await;
        }
    }
}

pub(crate) async fn undo(
    state: &AuthState,
    workspace: Uuid,
    id: Uuid,
    headers: &HeaderMap,
) -> Option<Response> {
    let actor = match require_session(&state.pool, headers, true).await {
        Ok((_, u)) => u,
        Err(s) => return Some(s.into_response()),
    };
    let row = match sqlx::query(
        "SELECT initiator_id,status,items FROM proposals WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return None,
        Err(_) => return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    };
    let items: Value = row.get("items");
    let selected = items
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["selected"] == true)
        .collect::<Vec<_>>();
    if selected.is_empty()
        || selected
            .iter()
            .any(|i| !["note_edit", "file_add"].contains(&i["kind"].as_str().unwrap_or("")))
    {
        return None;
    }
    if row.get::<Uuid, _>("initiator_id") != actor {
        return Some(StatusCode::FORBIDDEN.into_response());
    }
    if row.get::<String, _>("status") == "undone" {
        return Some((StatusCode::OK, Json(json!({"undone":true}))).into_response());
    }
    let rows=match sqlx::query("SELECT g.vault_id,g.base_commit,g.prepared_commit,v.repository_path FROM knowledge_apply_groups g JOIN vaults v ON v.id=g.vault_id WHERE g.proposal_id=$1 AND g.state='applied' ORDER BY g.vault_id").bind(id).fetch_all(&state.pool).await{Ok(r)=>r,Err(_)=>return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response())};
    if rows.is_empty() {
        return Some(
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"proposal_not_applied"})),
            )
                .into_response(),
        );
    }
    let mut reversions = Vec::new();
    let mut conflicts = Vec::new();
    for row in rows {
        let vault: Uuid = row.get("vault_id");
        let original: String = row.get("prepared_commit");
        let base: String = row.get("base_commit");
        let repo = PathBuf::from(row.get::<String, _>("repository_path"));
        if !matches!(vaults::evaluate_access(&state.pool,vault,actor).await,Ok(Some(a)) if a.workspace_id==workspace && a.role>=Role::Contributor)
        {
            return Some(
                (
                    StatusCode::CONFLICT,
                    Json(json!({"error":"proposal_access_denied"})),
                )
                    .into_response(),
            );
        }
        let changed = git(
            &repo,
            &["diff", "--name-only", &original, "refs/heads/main"],
        )
        .unwrap_or_default();
        let paths = git(&repo, &["diff", "--name-only", &base, &original]).unwrap_or_default();
        let expected: Vec<_> = paths.lines().collect();
        let current_changed: Vec<_> = git(
            &repo,
            &["diff", "--name-only", &original, "refs/heads/main"],
        )
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect();
        let bad: Vec<_> = expected
            .iter()
            .filter(|p| current_changed.iter().any(|c| c == **p))
            .copied()
            .collect();
        if !bad.is_empty() {
            conflicts.extend(bad.iter().map(|p| json!({"vault_id":vault,"file":p})));
            continue;
        }
        let _ = changed;
        match prepare_revert(&repo, &original) {
            Ok((undo_base, undo_commit)) => reversions.push((vault, repo, undo_base, undo_commit)),
            Err(_) => conflicts.push(json!({"vault_id":vault,"files":expected})),
        }
    }
    if !conflicts.is_empty() {
        return Some(
            (
                StatusCode::CONFLICT,
                Json(json!({"undone":false,"conflicts":conflicts})),
            )
                .into_response(),
        );
    }
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    };
    for (vault, _, base, commit) in &reversions {
        if sqlx::query("UPDATE knowledge_apply_groups SET state='undoing',undo_base_commit=$3,undo_commit=$4 WHERE proposal_id=$1 AND revision=(SELECT applied_revision FROM proposals WHERE id=$1) AND vault_id=$2 AND state='applied'").bind(id).bind(vault).bind(base).bind(commit).execute(&mut *tx).await.is_err(){return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());}
    }
    if tx.commit().await.is_err() {
        return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    let mut failed = Vec::new();
    for (vault, repo, base, commit) in &reversions {
        if update_ref(repo, base, commit).is_err() {
            failed.push(vault);
        }
    }
    if !failed.is_empty() {
        return Some(
            (
                StatusCode::ACCEPTED,
                Json(json!({"undone":false,"status":"needs_attention","vault_ids":failed})),
            )
                .into_response(),
        );
    }
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    };
    for (vault, repo, _, commit) in &reversions {
        if replace_index(&mut tx, *vault, repo, commit).await.is_err() {
            return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
        if sqlx::query(
            "UPDATE knowledge_apply_groups SET state='undone' WHERE proposal_id=$1 AND vault_id=$2",
        )
        .bind(id)
        .bind(vault)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    }
    if sqlx::query("UPDATE proposals SET status='undone' WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    Some((StatusCode::OK,Json(json!({"undone":true,"revert_commits":reversions.iter().map(|(v,_,_,c)|json!({"vault_id":v,"commit":c})).collect::<Vec<_>>()}))).into_response())
}

fn prepare_revert(repo: &Path, applied: &str) -> Result<(String, String), String> {
    let base = git(repo, &["rev-parse", "refs/heads/main"])?;
    let temp = std::env::temp_dir().join(format!("weft-revert-{}", Uuid::new_v4()));
    let clone = Command::new("git")
        .args(["clone", "--shared"])
        .arg(repo)
        .arg(&temp)
        .output()
        .map_err(|e| e.to_string())?;
    if !clone.status.success() {
        return Err("clone failed".into());
    }
    for (key, value) in [("user.name", "Weft"), ("user.email", "weft@localhost")] {
        let _ = Command::new("git")
            .arg("-C")
            .arg(&temp)
            .args(["config", key, value])
            .status();
    }
    let result = (|| {
        let revert = Command::new("git")
            .arg("-C")
            .arg(&temp)
            .args(["revert", "--no-edit", applied])
            .output()
            .map_err(|e| e.to_string())?;
        if !revert.status.success() {
            return Err(String::from_utf8_lossy(&revert.stderr).to_string());
        }
        let hash = Command::new("git")
            .arg("-C")
            .arg(&temp)
            .args(["rev-parse", "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;
        let commit = String::from_utf8_lossy(&hash.stdout).trim().to_owned();
        let fetch = Command::new("git")
            .arg("--git-dir")
            .arg(repo)
            .args(["fetch"])
            .arg(&temp)
            .arg(format!("{commit}:refs/weft/revert/{commit}"))
            .output()
            .map_err(|e| e.to_string())?;
        if !fetch.status.success() {
            return Err("revert object store failed".into());
        }
        Ok((base, commit))
    })();
    let _ = std::fs::remove_dir_all(temp);
    result
}
