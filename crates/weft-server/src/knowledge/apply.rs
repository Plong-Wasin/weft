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
use sqlx::{Connection, Row};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use uuid::Uuid;

/// Items a Knowledge Apply owns. A Proposal mixing them with any other kind cannot be applied by
/// either engine, so it is refused whole.
fn is_knowledge_kind(item: &Value) -> bool {
    ["note_edit", "file_add"].contains(&item["kind"].as_str().unwrap_or(""))
}

fn mixed_proposal() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"error":"knowledge_items_cannot_be_mixed"})),
    )
        .into_response()
}

/// Runs detached from the request: a client that disconnects (or the write timeout) must not drop the
/// handler between the committed Apply transaction and the ref update.
pub(crate) async fn approve(
    state: &AuthState,
    workspace: Uuid,
    id: Uuid,
    headers: &HeaderMap,
    body: &Value,
) -> Option<Response> {
    let (state, headers, body) = (state.clone(), headers.clone(), body.clone());
    tokio::spawn(async move { approve_inner(&state, workspace, id, &headers, &body).await })
        .await
        .unwrap_or_else(|_| Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

async fn approve_inner(
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
    if !selected.iter().any(|i| is_knowledge_kind(i)) {
        return None;
    }
    if row.get::<Uuid, _>("initiator_id") != actor {
        return Some(StatusCode::FORBIDDEN.into_response());
    }
    if !selected.iter().all(|i| is_knowledge_kind(i)) {
        return Some(mixed_proposal());
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
    let mut vault_inputs = Vec::new();
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
        vault_inputs.push((vault, path, changes));
    }
    // Vault inputs are ordered by UUID. The non-blocking session locks live on the one connection that
    // also runs the Apply transaction, so a busy Vault answers 409 instead of parking a pooled connection.
    let vault_ids: Vec<Uuid> = vault_inputs.iter().map(|(vault, _, _)| *vault).collect();
    let mut lock = match VaultLock::acquire(&state.pool, &vault_ids).await {
        Ok(Some(lock)) => lock,
        Ok(None) => return Some(vault_busy()),
        Err(_) => return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    };
    let outcome = async {
        let mut prepared = Vec::new();
        for (vault, path, changes) in vault_inputs {
            let prepared_commit = {
                let (path, changes) = (path.clone(), changes.clone());
                tokio::task::spawn_blocking(move || prepare(&path, &changes))
                    .await
                    .unwrap_or_else(|e| Err(e.to_string()))
            };
            match prepared_commit {
                Ok((base, commit)) => prepared.push((vault, path, base, commit, changes)),
                Err(e) if e == "note_changed_since_proposal" => {
                    return Some(
                        (
                            StatusCode::CONFLICT,
                            Json(json!({"error":"note_changed_since_proposal","vault_id":vault})),
                        )
                            .into_response(),
                    )
                }
                Err(e) => {
                    // Git's own message carries host paths: keep it in the log, not in the response.
                    tracing::warn!(vault_id=%vault, error=%e, "Knowledge Apply could not prepare the commit");
                    let code = e
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b == b'_')
                        .then_some(e);
                    let body = match code {
                        Some(code) => json!({"error":"knowledge_prepare_failed","detail":code}),
                        None => json!({"error":"knowledge_prepare_failed"}),
                    };
                    return Some((StatusCode::CONFLICT, Json(body)).into_response());
                }
            }
        }
        let mut tx = match lock.conn().begin().await {
            Ok(t) => t,
            Err(_) => return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        };
        let result = json!({"proposal_id":id,"revision":rev,"applied":true,"knowledge":prepared.iter().map(|(v,_,b,c,_)|json!({"vault_id":v,"base_commit":b,"commit":c})).collect::<Vec<_>>()});
        // The Proposal may have been edited or already applied since it was read: claim exactly the revision approved.
        match sqlx::query("UPDATE proposals SET status='applying',applied_revision=revision,apply_result=$2,updated_at=now() WHERE id=$1 AND revision=$3 AND status IN ('pending','ready')").bind(id).bind(&result).bind(rev).execute(&mut *tx).await {
            Ok(done) if done.rows_affected() == 1 => {}
            Ok(_) => {
                return Some(
                    (
                        StatusCode::CONFLICT,
                        Json(json!({"error":"proposal_revision_changed"})),
                    )
                        .into_response(),
                )
            }
            Err(_) => return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        }
        for (vault, path, base, commit, changes) in &prepared {
            if sqlx::query("INSERT INTO knowledge_apply_groups(proposal_id,revision,vault_id,base_commit,prepared_commit,state) VALUES($1,$2,$3,$4,$5,'applying')").bind(id).bind(rev).bind(vault).bind(base).bind(commit).execute(&mut *tx).await.is_err(){return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());}
            if replace_index(&mut tx, *vault, path, commit, changes).await.is_err() {
                return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
            }
        }
        if sqlx::query("INSERT INTO proposal_applications(proposal_id,revision,idempotency_key,result) VALUES($1,$2,$3,$4)").bind(id).bind(rev).bind(key).bind(&result).execute(&mut *tx).await.is_err(){return Some(StatusCode::CONFLICT.into_response());}
        if tx.commit().await.is_err() {
            return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
        let mut failures = Vec::new();
        for (vault, path, base, commit, changes) in &prepared {
            if update_ref_blocking(path, base, commit).await.is_err() {
                failures.push((*vault, path, changes));
            }
        }
        if failures.is_empty() {
            if sqlx::query("UPDATE knowledge_apply_groups SET state='applied' WHERE proposal_id=$1 AND revision=$2").bind(id).bind(rev).execute(lock.conn()).await.is_err() || sqlx::query("UPDATE proposals SET status='applied' WHERE id=$1").bind(id).execute(lock.conn()).await.is_err(){ return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()); }
            Some((StatusCode::OK, Json(result)).into_response())
        } else {
            let _=sqlx::query("UPDATE knowledge_apply_groups SET state='needs_attention',error='Could not advance main ref' WHERE proposal_id=$1 AND revision=$2").bind(id).bind(rev).execute(lock.conn()).await;
            let _ = sqlx::query("UPDATE proposals SET status='needs_attention' WHERE id=$1")
                .bind(id)
                .execute(lock.conn())
                .await;
            // The committed index describes content that never reached main: rebuild it from the real main.
            // The prepared commit renamed or deleted notes in the identity table: replay those changes in
            // reverse so the identities come back instead of being tombstoned.
            for (vault, path, changes) in &failures {
                rebuild_index_from_main(lock.conn(), *vault, path, changes).await;
            }
            let vault_ids = failures.iter().map(|(vault, _, _)| vault).collect::<Vec<_>>();
            Some(
                (
                    StatusCode::ACCEPTED,
                    Json(json!({"applied":false,"status":"needs_attention","vault_ids":vault_ids})),
                )
                    .into_response(),
            )
        }
    }
    .await;
    lock.release().await;
    outcome
}

fn lock_key(vault: Uuid) -> String {
    format!("weft-vault-apply:{vault}")
}

pub(crate) fn vault_busy() -> Response {
    (StatusCode::CONFLICT, Json(json!({"error":"vault_busy"}))).into_response()
}

/// Takes the per-Vault Apply lock without waiting. `Ok(false)` means another writer holds one of them;
/// nothing stays held in that case. Callers pass Vault ids in a stable order.
pub(crate) async fn lock_vaults(
    conn: &mut sqlx::PgConnection,
    vaults: &[Uuid],
) -> Result<bool, sqlx::Error> {
    for (index, vault) in vaults.iter().enumerate() {
        let taken: Result<bool, _> =
            sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended($1,0))")
                .bind(lock_key(*vault))
                .fetch_one(&mut *conn)
                .await;
        if !matches!(taken, Ok(true)) {
            for held in &vaults[..index] {
                let _ = sqlx::query("SELECT pg_advisory_unlock(hashtextextended($1,0))")
                    .bind(lock_key(*held))
                    .execute(&mut *conn)
                    .await;
            }
            return taken;
        }
    }
    Ok(true)
}

/// The Vault Apply lock is a PostgreSQL session lock, so it lives and dies with one connection. A guard
/// that is dropped without `release` (a cancelled handler, a panic) detaches the connection so it
/// closes and the server drops the lock, instead of returning a still-locked connection to the pool.
pub(crate) struct VaultLock {
    conn: Option<sqlx::pool::PoolConnection<sqlx::Postgres>>,
    vaults: Vec<Uuid>,
}

impl VaultLock {
    /// `Ok(None)` means another writer holds one of the Vaults.
    pub(crate) async fn acquire(
        pool: &sqlx::PgPool,
        vaults: &[Uuid],
    ) -> Result<Option<VaultLock>, sqlx::Error> {
        let mut conn = pool.acquire().await?;
        let taken = lock_vaults(&mut conn, vaults).await;
        match taken {
            Ok(true) => Ok(Some(VaultLock {
                conn: Some(conn),
                vaults: vaults.to_vec(),
            })),
            Ok(false) => {
                // `lock_vaults` swallows errors from its partial unlock, so with more than one Vault the
                // connection may still hold the first lock: drop every session lock or close it.
                if vaults.len() > 1
                    && sqlx::query("SELECT pg_advisory_unlock_all()")
                        .execute(&mut *conn)
                        .await
                        .is_err()
                {
                    drop(conn.detach());
                }
                Ok(None)
            }
            Err(error) => {
                // The connection is in an unknown lock state: close it, never pool it.
                drop(conn.detach());
                Err(error)
            }
        }
    }

    /// Waits (bounded) for one Vault's lock, polling so no pooled connection is parked on a blocking lock.
    pub(crate) async fn wait(pool: &sqlx::PgPool, vault: Uuid) -> Option<VaultLock> {
        for _ in 0..600 {
            if let Some(lock) = Self::acquire(pool, &[vault]).await.ok()? {
                return Some(lock);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        None
    }

    pub(crate) fn conn(&mut self) -> &mut sqlx::PgConnection {
        self.conn
            .as_mut()
            .expect("the lock connection is held until release")
    }

    /// Releases the locks; a connection that cannot unlock is closed so the session lock dies with it.
    pub(crate) async fn release(mut self) {
        if let Some(conn) = self.conn.take() {
            unlock_vaults(conn, &self.vaults).await;
        }
    }
}

impl Drop for VaultLock {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            drop(conn.detach());
        }
    }
}

async fn unlock_vaults(mut conn: sqlx::pool::PoolConnection<sqlx::Postgres>, vaults: &[Uuid]) {
    let mut failed = false;
    for vault in vaults {
        if sqlx::query("SELECT pg_advisory_unlock(hashtextextended($1,0))")
            .bind(lock_key(*vault))
            .execute(&mut *conn)
            .await
            .is_err()
        {
            failed = true;
        }
    }
    if failed {
        let _ = conn.close().await;
    }
}

async fn rebuild_index_from_main(
    conn: &mut sqlx::PgConnection,
    vault: Uuid,
    repo: &Path,
    changes: &[Value],
) {
    let rebuilt = async {
        let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
        replace_index(&mut tx, vault, repo, "refs/heads/main", changes).await?;
        tx.commit().await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(error) = rebuilt {
        tracing::error!(vault_id=%vault, %error, "Could not rebuild the note index from main after a failed ref update");
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
    ensure_notes_unchanged_since_proposal(repo, &base, items)?;
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
        let mut lfs_paths = Vec::new();
        for item in items {
            let path = item["path"].as_str().ok_or("path missing")?;
            validate_path(path)?;
            if item["delete"] == true {
                if item["kind"] != "note_edit" || item["rename_to"].as_str().is_some() {
                    return Err("invalid_note_deletion".into());
                }
                ensure_no_symlink(&temp, path)?;
                let target = temp.join(path);
                if !target.is_file() {
                    return Err("note_to_delete_missing".into());
                }
                std::fs::remove_file(target).map_err(|e| e.to_string())?;
                continue;
            }
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
            if item["kind"] == "file_add"
                && !crate::ai_knowledge_proposals::is_text_file(path, &content)
            {
                lfs_paths.push(path.to_owned());
            }
            let target_path = item["rename_to"].as_str().unwrap_or(path);
            validate_path(target_path)?;
            ensure_no_symlink(&temp, target_path)?;
            let target = temp.join(target_path);
            if target_path != path && target.exists() {
                return Err("rename_destination_exists".into());
            }
            // Only a new path may be added: an existing file or note was never reviewed for overwrite.
            if item["kind"] == "file_add" && target.symlink_metadata().is_ok() {
                return Err("file_already_exists".into());
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(target, &content).map_err(|e| e.to_string())?;
            if target_path != path {
                ensure_no_symlink(&temp, path)?;
                let source = temp.join(path);
                if !source.is_file() {
                    return Err("note_to_rename_missing".into());
                }
                std::fs::remove_file(source).map_err(|e| e.to_string())?;
            }
        }
        if !lfs_paths.is_empty() {
            let installed = Command::new("git")
                .arg("-C")
                .arg(&temp)
                .args(["lfs", "install", "--local"])
                .output();
            if !installed.is_ok_and(|output| output.status.success()) {
                return Err("git_lfs_unavailable".into());
            }
            for path in &lfs_paths {
                let tracked = Command::new("git")
                    .arg("-C")
                    .arg(&temp)
                    .args(["lfs", "track", "--filename", "--", path])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !tracked.status.success() {
                    return Err(String::from_utf8_lossy(&tracked.stderr).to_string());
                }
            }
        }
        let add = Command::new("git")
            .arg("-C")
            .arg(&temp)
            .args(["add", "--all", "--force"])
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
        if !lfs_paths.is_empty() {
            copy_directory(&temp.join(".git/lfs/objects"), &repo.join("lfs/objects"))?;
        }
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

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err("git_lfs_objects_missing".into());
    }
    std::fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = destination.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn validate_path(path: &str) -> Result<(), String> {
    crate::ai_knowledge_proposals::validate_vault_path(path).map_err(str::to_owned)
}

/// A note edit is only applicable on the note it was written against: a human edit committed since
/// the Proposal was created must not be overwritten.
fn ensure_notes_unchanged_since_proposal(
    repo: &Path,
    base: &str,
    items: &[Value],
) -> Result<(), String> {
    for item in items.iter().filter(|item| item["kind"] == "note_edit") {
        let path = item["path"].as_str().ok_or("path missing")?;
        validate_path(path)?;
        if let Some(expected) = item["base_hash"].as_str() {
            let current = git_bytes(repo, &["show", &format!("{base}:{path}")]);
            if !current.is_ok_and(|bytes| crate::ai_knowledge_proposals::sha256(&bytes) == expected)
            {
                return Err("note_changed_since_proposal".into());
            }
        } else if let Some(proposed_on) = item["base_commit"].as_str() {
            if proposed_on != base
                && git(repo, &["diff", "--quiet", proposed_on, base, "--", path]).is_err()
            {
                return Err("note_changed_since_proposal".into());
            }
        }
    }
    Ok(())
}

/// Refuses a write whose path crosses a symlink (a link pushed to main must not lead a write out of
/// the clone). Every existing ancestor and the target itself are checked.
fn ensure_no_symlink(root: &Path, relative: &str) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for part in relative.split('/') {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => return Err("path_crosses_symlink".into()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}
fn update_ref(repo: &Path, base: &str, commit: &str) -> Result<(), String> {
    git(repo, &["update-ref", "refs/heads/main", commit, base]).map(|_| ())
}

async fn update_ref_blocking(repo: &Path, base: &str, commit: &str) -> Result<(), String> {
    let (repo, base, commit) = (repo.to_path_buf(), base.to_owned(), commit.to_owned());
    tokio::task::spawn_blocking(move || update_ref(&repo, &base, &commit))
        .await
        .map_err(|e| e.to_string())?
}

/// Every file of a commit as `(path, text)`; `text` is `None` for non-UTF-8 content. Names are read
/// NUL-delimited so Git does not octal-quote non-ASCII paths, and all blobs come from one `cat-file`
/// process rather than one `git show` per file.
fn read_tree(repo: &Path, commit: &str) -> Result<Vec<(String, Option<String>)>, String> {
    use std::io::{BufRead, Read, Write};
    let listing = git_bytes(repo, &["ls-tree", "-r", "-z", commit])?;
    let mut entries = Vec::new();
    for record in listing.split(|byte| *byte == 0).filter(|r| !r.is_empty()) {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or("malformed tree entry")?;
        let meta = String::from_utf8_lossy(&record[..tab]).to_string();
        let mut fields = meta.split(' ');
        let (_mode, kind, sha) = (fields.next(), fields.next(), fields.next());
        if kind != Some("blob") {
            continue;
        }
        // A name that is not UTF-8 cannot be indexed (paths are text): skip it instead of failing the
        // rebuild, Apply, undo and recover of the whole Vault.
        let Ok(path) = String::from_utf8(record[tab + 1..].to_vec()) else {
            continue;
        };
        entries.push((path, sha.ok_or("malformed tree entry")?.to_owned()));
    }
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let mut child = ReapedChild(Some(
        Command::new("git")
            .arg("--git-dir")
            .arg(repo)
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?,
    ));
    let mut stdin = child.get().stdin.take().ok_or("cat-file stdin")?;
    let requests = entries
        .iter()
        .map(|(_, sha)| format!("{sha}\n"))
        .collect::<String>();
    // Writing from a thread keeps a large tree from deadlocking against the unread stdout pipe.
    let writer = std::thread::spawn(move || stdin.write_all(requests.as_bytes()));
    let mut out = std::io::BufReader::new(child.get().stdout.take().ok_or("cat-file stdout")?);
    let mut files = Vec::with_capacity(entries.len());
    for (path, _) in entries {
        let mut header = String::new();
        out.read_line(&mut header).map_err(|e| e.to_string())?;
        let size: usize = header
            .split_whitespace()
            .nth(2)
            .and_then(|n| n.parse().ok())
            .ok_or("malformed cat-file header")?;
        let mut bytes = vec![0u8; size + 1];
        out.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        bytes.truncate(size);
        files.push((path, String::from_utf8(bytes).ok()));
    }
    let _ = writer.join();
    child.finish();
    Ok(files)
}

/// Owns a spawned child so an early return (a read error, a malformed header) kills and waits for it
/// instead of leaving a running process and a zombie behind.
struct ReapedChild(Option<std::process::Child>);

impl ReapedChild {
    fn get(&mut self) -> &mut std::process::Child {
        self.0.as_mut().expect("the child is held until finish")
    }

    /// Normal end: the child exits on its own once its stdin is closed.
    fn finish(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.wait();
        }
    }
}

impl Drop for ReapedChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

async fn replace_index(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    vault: Uuid,
    repo: &Path,
    commit: &str,
    changes: &[Value],
) -> Result<(), String> {
    let source = tokio::task::spawn_blocking({
        let (repo, commit) = (repo.to_path_buf(), commit.to_owned());
        move || read_tree(&repo, &commit)
    })
    .await
    .map_err(|e| e.to_string())??;
    let files = crate::knowledge::index::build(source);
    let paths = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<std::collections::HashSet<_>>();
    let identities = sqlx::query("SELECT id,path,deleted_at IS NOT NULL AS deleted FROM vault_note_identities WHERE vault_id=$1")
        .bind(vault)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let renames = changes
        .iter()
        .filter_map(|item| Some((item["path"].as_str()?, item["rename_to"].as_str()?)))
        .collect::<Vec<_>>();
    let deletions = changes
        .iter()
        .filter(|item| item["kind"] == "note_edit" && item["delete"] == true)
        .filter_map(|item| item["path"].as_str())
        .collect::<std::collections::HashSet<_>>();
    for row in &identities {
        let id: Uuid = row.get("id");
        let path: String = row.get("path");
        let deleted: bool = row.get("deleted");
        if !deleted && paths.contains(path.as_str()) {
            continue;
        }
        if deleted {
            continue;
        }
        if let Some((_, new_path)) = renames.iter().find(|(old_path, _)| *old_path == path) {
            if paths.contains(new_path) {
                if !crate::note_reference_text::rename_note(tx, vault, id, &path, new_path)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    return Err("note_reference_rename_failed".into());
                }
                continue;
            }
        }
        if let Some((old_path, _)) = renames.iter().find(|(_, new_path)| *new_path == path) {
            if paths.contains(old_path) {
                if !crate::note_reference_text::restore_note(tx, id, old_path)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    return Err("note_reference_rename_undo_failed".into());
                }
                continue;
            }
        }
        if !crate::note_reference_text::delete_note(tx, vault, id, &path)
            .await
            .map_err(|e| e.to_string())?
        {
            return Err("note_reference_delete_failed".into());
        }
    }
    for path in &deletions {
        if paths.contains(path) {
            let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vault_note_identities WHERE vault_id=$1 AND path=$2 AND deleted_at IS NULL)")
                .bind(vault).bind(path).fetch_one(&mut **tx).await.map_err(|e|e.to_string())?;
            if !active {
                let deleted_id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM vault_note_identities WHERE vault_id=$1 AND path=$2 AND deleted_at IS NOT NULL ORDER BY created_at DESC LIMIT 1")
                    .bind(vault).bind(path).fetch_optional(&mut **tx).await.map_err(|e|e.to_string())?;
                if let Some(id) = deleted_id {
                    if !crate::note_reference_text::restore_note(tx, id, path)
                        .await
                        .map_err(|e| e.to_string())?
                    {
                        return Err("note_reference_delete_undo_failed".into());
                    }
                }
            }
        }
    }
    for file in &files {
        let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vault_note_identities WHERE vault_id=$1 AND path=$2 AND deleted_at IS NULL)")
            .bind(vault).bind(&file.path).fetch_one(&mut **tx).await.map_err(|e|e.to_string())?;
        if !active {
            sqlx::query("INSERT INTO vault_note_identities(id,vault_id,path) VALUES($1,$2,$3)")
                .bind(Uuid::new_v4())
                .bind(vault)
                .bind(&file.path)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
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

fn items_for_vault(items: &Value, vault: Uuid) -> Vec<Value> {
    items
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| {
            item["selected"] == true
                && item["vault_id"]
                    .as_str()
                    .and_then(|id| Uuid::parse_str(id).ok())
                    == Some(vault)
        })
        .cloned()
        .collect()
}

pub(crate) async fn recover(pool: &sqlx::PgPool) {
    let rows=sqlx::query("SELECT g.proposal_id,g.revision,g.vault_id,g.base_commit,g.prepared_commit,v.repository_path,g.state,g.undo_base_commit,g.undo_commit,p.items FROM knowledge_apply_groups g JOIN vaults v ON v.id=g.vault_id JOIN proposals p ON p.id=g.proposal_id WHERE g.state IN ('applying','needs_attention','undoing') ORDER BY g.vault_id").fetch_all(pool).await.unwrap_or_default();
    for row in rows {
        let vault: Uuid = row.get("vault_id");
        // Recovery moves refs and rewrites the index like an Apply does, so it takes the same Vault lock.
        let Some(lock) = VaultLock::wait(pool, vault).await else {
            tracing::error!(vault_id=%vault, "Apply recovery skipped a Vault that stayed busy");
            continue;
        };
        recover_group(pool, row).await;
        lock.release().await;
    }
}

async fn recover_group(pool: &sqlx::PgPool, row: sqlx::postgres::PgRow) {
    {
        let id: Uuid = row.get("proposal_id");
        let rev: i32 = row.get("revision");
        let vault: Uuid = row.get("vault_id");
        let state: String = row.get("state");
        let proposal_items: Value = row.get("items");
        let changes = items_for_vault(&proposal_items, vault);
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
        let repo = PathBuf::from(row.get::<String, _>("repository_path"));
        let (Some(base), Some(commit)) = (base, commit) else {
            return;
        };
        let head = tokio::task::spawn_blocking({
            let repo = repo.clone();
            move || git(&repo, &["rev-parse", "refs/heads/main"]).ok()
        })
        .await
        .unwrap_or_default();
        let done = head.as_deref() == Some(commit.as_str())
            || update_ref_blocking(&repo, &base, &commit).await.is_ok();
        if done {
            let target_state = if undoing { "undone" } else { "applied" };
            let mut tx = match pool.begin().await {
                Ok(tx) => tx,
                Err(_) => return,
            };
            if undoing {
                if let Err(error) = replace_index(&mut tx, vault, &repo, &commit, &changes).await {
                    tracing::error!(proposal_id=%id, vault_id=%vault, %error, "Could not rebuild note index during Apply recovery");
                    let _ = tx.rollback().await;
                    let _=sqlx::query("UPDATE knowledge_apply_groups SET state='needs_attention',error='Could not rebuild index after revert' WHERE proposal_id=$1 AND revision=$2 AND vault_id=$3").bind(id).bind(rev).bind(vault).execute(pool).await;
                    return;
                }
            }
            let updated=sqlx::query("UPDATE knowledge_apply_groups SET state=$4,error=NULL WHERE proposal_id=$1 AND revision=$2 AND vault_id=$3").bind(id).bind(rev).bind(vault).bind(target_state).execute(&mut *tx).await;
            if updated.is_err() || tx.commit().await.is_err() {
                return;
            }
        } else {
            let _=sqlx::query("UPDATE knowledge_apply_groups SET state='needs_attention',error='Vault main advanced beyond prepared commit' WHERE proposal_id=$1 AND revision=$2 AND vault_id=$3").bind(id).bind(rev).bind(vault).execute(pool).await;
            if let Ok(mut conn) = pool.acquire().await {
                rebuild_index_from_main(&mut conn, vault, &repo, &[]).await;
            }
            // A stuck Apply must be visible on the Proposal itself, never left looking in progress.
            let _ = sqlx::query("UPDATE proposals SET status='needs_attention' WHERE id=$1 AND status IN ('applying','applied')")
                .bind(id)
                .execute(pool)
                .await;
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

/// Detached from the request for the same reason as `approve`.
pub(crate) async fn undo(
    state: &AuthState,
    workspace: Uuid,
    id: Uuid,
    headers: &HeaderMap,
) -> Option<Response> {
    let (state, headers) = (state.clone(), headers.clone());
    tokio::spawn(async move { undo_inner(&state, workspace, id, &headers).await })
        .await
        .unwrap_or_else(|_| Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

async fn undo_inner(
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
    if !selected.iter().any(|i| is_knowledge_kind(i)) {
        return None;
    }
    if row.get::<Uuid, _>("initiator_id") != actor {
        return Some(StatusCode::FORBIDDEN.into_response());
    }
    if !selected.iter().all(|i| is_knowledge_kind(i)) {
        return Some(mixed_proposal());
    }
    if row.get::<String, _>("status") == "undone" {
        return Some((StatusCode::OK, Json(json!({"undone":true}))).into_response());
    }
    let locked: Vec<Uuid> = match sqlx::query_scalar("SELECT vault_id FROM knowledge_apply_groups WHERE proposal_id=$1 AND state='applied' ORDER BY vault_id").bind(id).fetch_all(&state.pool).await{Ok(r)=>r,Err(_)=>return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response())};
    let lock = match VaultLock::acquire(&state.pool, &locked).await {
        Ok(Some(lock)) => lock,
        Ok(None) => return Some(vault_busy()),
        Err(_) => return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    };
    let outcome = undo_locked(state, workspace, actor, id, &items).await;
    lock.release().await;
    outcome
}

async fn undo_locked(
    state: &AuthState,
    workspace: Uuid,
    actor: Uuid,
    id: Uuid,
    items: &Value,
) -> Option<Response> {
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
        let (paths, current_changed) = tokio::task::spawn_blocking({
            let (repo, original, base) = (repo.clone(), original.clone(), base.clone());
            move || {
                let paths = git(&repo, &["diff", "-z", "--name-only", &base, &original]);
                let current = git(
                    &repo,
                    &["diff", "-z", "--name-only", &original, "refs/heads/main"],
                );
                (paths.unwrap_or_default(), current.unwrap_or_default())
            }
        })
        .await
        .unwrap_or_default();
        // NUL-delimited, so Git does not octal-quote non-ASCII names in the conflict list.
        let expected: Vec<_> = paths.split('\0').filter(|p| !p.is_empty()).collect();
        let current_changed: Vec<_> = current_changed
            .split('\0')
            .filter(|p| !p.is_empty())
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
        let changes = items_for_vault(items, vault);
        let reverted = {
            let (repo, original) = (repo.clone(), original.clone());
            tokio::task::spawn_blocking(move || prepare_revert(&repo, &original))
                .await
                .unwrap_or_else(|e| Err(e.to_string()))
        };
        match reverted {
            Ok((undo_base, undo_commit)) => {
                reversions.push((vault, repo, undo_base, undo_commit, changes))
            }
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
    for (vault, _, base, commit, _) in &reversions {
        if sqlx::query("UPDATE knowledge_apply_groups SET state='undoing',undo_base_commit=$3,undo_commit=$4 WHERE proposal_id=$1 AND revision=(SELECT applied_revision FROM proposals WHERE id=$1) AND vault_id=$2 AND state='applied'").bind(id).bind(vault).bind(base).bind(commit).execute(&mut *tx).await.is_err(){return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());}
    }
    if tx.commit().await.is_err() {
        return Some(StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    let mut failed = Vec::new();
    for (vault, repo, base, commit, _) in &reversions {
        if update_ref_blocking(repo, base, commit).await.is_err() {
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
    for (vault, repo, _, commit, changes) in &reversions {
        if let Err(error) = replace_index(&mut tx, *vault, repo, commit, changes).await {
            tracing::error!(proposal_id=%id, vault_id=%vault, %error, "Could not rebuild the note index after undo");
            drop(tx);
            // main already holds the revert: make the stuck index visible instead of leaving `undoing`.
            let _ = sqlx::query("UPDATE knowledge_apply_groups SET state='needs_attention',error='Could not rebuild index after revert' WHERE proposal_id=$1 AND state='undoing'").bind(id).execute(&state.pool).await;
            let _ = sqlx::query("UPDATE proposals SET status='needs_attention' WHERE id=$1")
                .bind(id)
                .execute(&state.pool)
                .await;
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
    Some((StatusCode::OK,Json(json!({"undone":true,"revert_commits":reversions.iter().map(|(v,_,_,c,_)|json!({"vault_id":v,"commit":c})).collect::<Vec<_>>()}))).into_response())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_dropped_vault_lock_does_not_leave_its_session_lock_in_the_pool() {
        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let vault = Uuid::new_v4();
        let lock = VaultLock::acquire(&pool, &[vault]).await.unwrap().unwrap();
        // A cancelled handler drops the guard without `release`.
        drop(lock);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // Another session (another request) must be able to take the lock: a pooled connection that
        // kept it would answer 409 vault_busy forever.
        let mut other = sqlx::PgConnection::connect(&url).await.unwrap();
        let taken = lock_vaults(&mut other, &[vault]).await.unwrap();
        assert!(
            taken,
            "the dropped guard returned a still-locked connection to the pool"
        );
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn read_tree_skips_a_non_utf8_file_name_instead_of_failing() {
        use std::os::unix::ffi::OsStrExt;
        let dir = std::env::temp_dir().join(format!("weft-read-tree-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        run_git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("ok.md"), "fine").unwrap();
        std::fs::write(dir.join("ทำไม.md"), "thai").unwrap();
        std::fs::write(
            dir.join(std::ffi::OsStr::from_bytes(b"latin1-\xe9.md")),
            "bad name",
        )
        .unwrap();
        run_git(&dir, &["add", "--all"]);
        run_git(&dir, &["commit", "-q", "-m", "x"]);
        let files = read_tree(&dir.join(".git"), "HEAD").unwrap();
        let mut names: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
        names.sort();
        assert_eq!(names, ["ok.md", "ทำไม.md"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_failed_multi_vault_acquire_leaves_no_lock_on_the_pooled_connection() {
        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
        // Another session holds the second Vault, so taking [first, second] fails after locking `first`.
        let mut other = sqlx::PgConnection::connect(&url).await.unwrap();
        assert!(lock_vaults(&mut other, &[second]).await.unwrap());
        assert!(VaultLock::acquire(&pool, &[first, second])
            .await
            .unwrap()
            .is_none());
        let mut third = sqlx::PgConnection::connect(&url).await.unwrap();
        assert!(
            lock_vaults(&mut third, &[first]).await.unwrap(),
            "the pooled connection kept the first Vault's lock"
        );
    }
}
