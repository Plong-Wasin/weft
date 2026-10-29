use std::{
    fs::{self, File},
    io::{Read, Seek},
    path::{Path, PathBuf},
    process::Command,
};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use flate2::read::GzDecoder;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    projects::Role,
    vaults::evaluate_access,
};

const BINARY_ATTRIBUTES: &str = "*.7z filter=lfs diff=lfs merge=lfs -text\n*.avif filter=lfs diff=lfs merge=lfs -text\n*.bmp filter=lfs diff=lfs merge=lfs -text\n*.doc filter=lfs diff=lfs merge=lfs -text\n*.docx filter=lfs diff=lfs merge=lfs -text\n*.exe filter=lfs diff=lfs merge=lfs -text\n*.gif filter=lfs diff=lfs merge=lfs -text\n*.gz filter=lfs diff=lfs merge=lfs -text\n*.heic filter=lfs diff=lfs merge=lfs -text\n*.jpg filter=lfs diff=lfs merge=lfs -text\n*.jpeg filter=lfs diff=lfs merge=lfs -text\n*.mov filter=lfs diff=lfs merge=lfs -text\n*.mp3 filter=lfs diff=lfs merge=lfs -text\n*.mp4 filter=lfs diff=lfs merge=lfs -text\n*.pdf filter=lfs diff=lfs merge=lfs -text\n*.png filter=lfs diff=lfs merge=lfs -text\n*.ppt filter=lfs diff=lfs merge=lfs -text\n*.pptx filter=lfs diff=lfs merge=lfs -text\n*.psd filter=lfs diff=lfs merge=lfs -text\n*.rar filter=lfs diff=lfs merge=lfs -text\n*.svgz filter=lfs diff=lfs merge=lfs -text\n*.tar filter=lfs diff=lfs merge=lfs -text\n*.tif filter=lfs diff=lfs merge=lfs -text\n*.tiff filter=lfs diff=lfs merge=lfs -text\n*.wav filter=lfs diff=lfs merge=lfs -text\n*.webm filter=lfs diff=lfs merge=lfs -text\n*.webp filter=lfs diff=lfs merge=lfs -text\n*.zip filter=lfs diff=lfs merge=lfs -text\n";

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/vaults/:vault_id/imports", post(import_repository))
        .route(
            "/vaults/:vault_id/imports/archive",
            post(import_archive).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
        )
        .route("/vaults/:vault_id/imports/:job_id", get(import_status))
}

#[derive(Deserialize)]
struct RepositoryImport {
    repository_url: String,
}

async fn import_repository(
    State(state): State<AuthState>,
    AxumPath(vault): AxumPath<Uuid>,
    headers: HeaderMap,
    Json(input): Json<RepositoryImport>,
) -> Response {
    let url = input.repository_url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("git://")) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let (actor, workspace) = match import_permission(&state, vault, &headers).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let job = match create_job(&state, vault, workspace, actor, "repository").await {
        Ok(job) => job,
        Err(error) => return job_creation_error(error),
    };
    let task_state = state.clone();
    let source = url.to_owned();
    tokio::spawn(async move {
        run_import(task_state, vault, job, ImportSource::Repository(source)).await
    });
    (
        StatusCode::ACCEPTED,
        Json(json!({"id":job,"status":"queued"})),
    )
        .into_response()
}

async fn import_archive(
    State(state): State<AuthState>,
    AxumPath(vault): AxumPath<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (actor, workspace) = match import_permission(&state, vault, &headers).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let job = match create_job(&state, vault, workspace, actor, "archive").await {
        Ok(job) => job,
        Err(error) => return job_creation_error(error),
    };
    let archive = std::env::temp_dir().join(format!("weft-vault-import-{job}.tar"));
    let write_result = tokio::task::spawn_blocking({
        let archive = archive.clone();
        move || fs::write(archive, body)
    })
    .await;
    if !matches!(write_result, Ok(Ok(()))) {
        let _ = mark_failed(&state, job, "Could not store the uploaded archive").await;
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let task_state = state.clone();
    tokio::spawn(async move {
        run_import(task_state, vault, job, ImportSource::Archive(archive)).await
    });
    (
        StatusCode::ACCEPTED,
        Json(json!({"id":job,"status":"queued"})),
    )
        .into_response()
}

fn job_creation_error(error: sqlx::Error) -> Response {
    if error
        .as_database_error()
        .is_some_and(|database| database.code().as_deref() == Some("23505"))
    {
        StatusCode::CONFLICT.into_response()
    } else {
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn import_status(
    State(state): State<AuthState>,
    AxumPath((vault, job)): AxumPath<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    match evaluate_access(&state.pool, vault, user).await {
        Ok(Some(access)) if access.role >= Role::Viewer => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let row = sqlx::query("SELECT status,reindex_status,error,created_at::text AS created_at,updated_at::text AS updated_at FROM vault_import_jobs WHERE id=$1 AND vault_id=$2")
        .bind(job).bind(vault).fetch_optional(&state.pool).await;
    match row {
        Ok(Some(row)) => Json(json!({
            "id": job,
            "status": row.get::<String, _>("status"),
            "reindex_status": row.get::<String, _>("reindex_status"),
            "error": row.get::<Option<String>, _>("error"),
            "created_at": row.get::<String, _>("created_at"),
            "updated_at": row.get::<String, _>("updated_at"),
        }))
        .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn import_permission(
    state: &AuthState,
    vault: Uuid,
    headers: &HeaderMap,
) -> Result<(Uuid, Uuid), StatusCode> {
    let (_, actor) = require_session(&state.pool, headers, true).await?;
    match evaluate_access(&state.pool, vault, actor).await {
        Ok(Some(access)) if access.role == Role::Manager => Ok((actor, access.workspace_id)),
        Ok(_) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn create_job(
    state: &AuthState,
    vault: Uuid,
    workspace: Uuid,
    actor: Uuid,
    source: &str,
) -> Result<Uuid, sqlx::Error> {
    let id = Uuid::new_v4();
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO vault_import_jobs(id,workspace_id,vault_id,actor_id,source,status,reindex_status) VALUES($1,$2,$3,$4,$5,'queued','queued')")
        .bind(id).bind(workspace).bind(vault).bind(actor).bind(source).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO security_audit_events(actor_id,workspace_id,event,subject_id) VALUES($1,$2,'vault.import.started',$3)")
        .bind(actor).bind(workspace).bind(vault).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(id)
}

enum ImportSource {
    Repository(String),
    Archive(PathBuf),
}

async fn run_import(state: AuthState, vault: Uuid, job: Uuid, source: ImportSource) {
    let _maintenance_guard = match crate::maintenance_write_guard(&state.pool).await {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            let _ = mark_failed(
                &state,
                job,
                "Import paused because the installation is in maintenance mode",
            )
            .await;
            return;
        }
        Err(_) => {
            let _ = mark_failed(
                &state,
                job,
                "Import could not acquire the maintenance guard",
            )
            .await;
            return;
        }
    };
    let _ = set_status(&state, job, "importing", "queued").await;
    let repo = sqlx::query_scalar::<_, String>("SELECT repository_path FROM vaults WHERE id=$1")
        .bind(vault)
        .fetch_optional(&state.pool)
        .await;
    let Ok(Some(repo)) = repo else {
        let _ = mark_failed(&state, job, "Vault repository is unavailable").await;
        return;
    };
    let repository = PathBuf::from(repo);
    let import_result = tokio::task::spawn_blocking({
        let repository = repository.clone();
        move || match source {
            ImportSource::Repository(url) => import_repository_history(&url, &repository),
            ImportSource::Archive(path) => import_archive_files(&path, &repository),
        }
    })
    .await;
    match import_result {
        Ok(Ok(())) => {
            let _ = set_status(&state, job, "reindexing", "running").await;
            let indexed = tokio::task::spawn_blocking(move || index_files(&repository)).await;
            match indexed {
                Ok(Ok(files)) => {
                    let result = async {
                        crate::knowledge::search::reindex_import(&state, vault, files).await?;
                        set_status(&state, job, "completed", "completed").await
                    }
                    .await;
                    if result.is_err() {
                        let _ = mark_failed(&state, job, "Vault reindex failed").await;
                    }
                }
                _ => {
                    let _ = mark_failed(&state, job, "Vault reindex failed").await;
                }
            }
        }
        _ => {
            let _ = mark_failed(
                &state,
                job,
                "Import failed; check that the repository or archive is valid",
            )
            .await;
        }
    }
}

pub(crate) fn index_files(repository: &Path) -> Result<Vec<(String, Option<String>)>, ()> {
    let listed = Command::new("git")
        .arg("--git-dir")
        .arg(repository)
        .args(["ls-tree", "-r", "--full-tree", "-z", "HEAD"])
        .output()
        .map_err(|_| ())?;
    if !listed.status.success() {
        return Err(());
    }
    let mut files = Vec::new();
    for record in listed
        .stdout
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
    {
        let tab = record.iter().position(|byte| *byte == b'\t').ok_or(())?;
        let (metadata, path) = record.split_at(tab);
        let path = &path[1..];
        let path = std::str::from_utf8(path).map_err(|_| ())?;
        if path == ".obsidian" || path.starts_with(".obsidian/") {
            continue;
        }
        let object = metadata
            .split(|byte| *byte == b' ')
            .nth(2)
            .and_then(|value| std::str::from_utf8(value).ok())
            .ok_or(())?;
        let content = Command::new("git")
            .arg("--git-dir")
            .arg(repository)
            .args(["cat-file", "blob", object])
            .output()
            .map_err(|_| ())?;
        if !content.status.success() {
            return Err(());
        }
        let text = if content
            .stdout
            .starts_with(b"version https://git-lfs.github.com/spec/v1\n")
            || content.stdout.contains(&0)
        {
            None
        } else {
            String::from_utf8(content.stdout).ok()
        };
        files.push((path.to_owned(), text));
    }
    Ok(files)
}

async fn set_status(
    state: &AuthState,
    job: Uuid,
    status: &str,
    reindex: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE vault_import_jobs SET status=$2,reindex_status=$3,updated_at=now() WHERE id=$1",
    )
    .bind(job)
    .bind(status)
    .bind(reindex)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn mark_failed(state: &AuthState, job: Uuid, message: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE vault_import_jobs SET status='failed',reindex_status=CASE WHEN reindex_status='running' THEN 'failed' ELSE reindex_status END,error=$2,updated_at=now() WHERE id=$1")
        .bind(job).bind(message).execute(&state.pool).await?;
    Ok(())
}

fn import_repository_history(url: &str, repository: &Path) -> Result<(), ()> {
    let staging = repository.with_extension("import");
    let _ = fs::remove_dir_all(&staging);
    let clone = Command::new("git")
        .args(["clone", "--mirror", "--", url])
        .arg(&staging)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|_| ())?;
    if !clone.status.success() {
        let _ = fs::remove_dir_all(&staging);
        return Err(());
    }
    if Command::new("git-lfs").arg("version").output().is_ok() {
        let lfs = Command::new("git")
            .arg("--git-dir")
            .arg(&staging)
            .args(["lfs", "fetch", "--all"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|_| ())?;
        if !lfs.status.success() {
            let _ = fs::remove_dir_all(&staging);
            return Err(());
        }
    }
    seed_attributes(&staging)?;
    fs::remove_dir_all(repository).map_err(|_| ())?;
    fs::rename(staging, repository).map_err(|_| ())?;
    Ok(())
}

fn import_archive_files(archive_path: &Path, repository: &Path) -> Result<(), ()> {
    let unpacked = repository.with_extension("archive");
    let staged_repo = repository.with_extension("new");
    let _ = fs::remove_dir_all(&unpacked);
    let _ = fs::remove_dir_all(&staged_repo);
    fs::create_dir_all(&unpacked).map_err(|_| ())?;
    let file = File::open(archive_path).map_err(|_| ())?;
    let gzip = {
        let mut reader = std::io::BufReader::new(file);
        let mut magic = [0; 2];
        let read = reader.read(&mut magic).map_err(|_| ())?;
        reader.rewind().map_err(|_| ())?;
        if read == 2 && magic == [0x1f, 0x8b] {
            Some(reader)
        } else {
            None
        }
    };
    let unpack = match gzip {
        Some(reader) => unpack_archive(GzDecoder::new(reader), &unpacked),
        None => unpack_archive(File::open(archive_path).map_err(|_| ())?, &unpacked),
    };
    unpack?;
    seed_attributes_file(&unpacked.join(".gitattributes"))?;
    let init = Command::new("git")
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&staged_repo)
        .output()
        .map_err(|_| ())?;
    if !init.status.success() {
        return Err(());
    }
    let worktree = repository.with_extension("work");
    let _ = fs::remove_dir_all(&worktree);
    let clone = Command::new("git")
        .args(["clone", "--", staged_repo.to_str().ok_or(())?])
        .arg(&worktree)
        .output()
        .map_err(|_| ())?;
    if !clone.status.success() {
        return Err(());
    }
    copy_tree(&unpacked, &worktree)?;
    store_binary_files_as_lfs(&worktree, &staged_repo)?;
    let add = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["add", "-A"])
        .output()
        .map_err(|_| ())?;
    if !add.status.success() {
        return Err(());
    }
    let commit = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args([
            "-c",
            "user.name=Weft",
            "-c",
            "user.email=weft@localhost",
            "commit",
            "-m",
            "Import Vault archive",
        ])
        .output()
        .map_err(|_| ())?;
    if !commit.status.success() {
        return Err(());
    }
    let push = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["push", "origin", "main"])
        .output()
        .map_err(|_| ())?;
    if !push.status.success() {
        return Err(());
    }
    let _ = fs::remove_dir_all(repository);
    fs::rename(staged_repo, repository).map_err(|_| ())?;
    let _ = fs::remove_dir_all(unpacked);
    let _ = fs::remove_dir_all(worktree);
    let _ = fs::remove_file(archive_path);
    Ok(())
}

fn unpack_archive<R: Read>(reader: R, destination: &Path) -> Result<(), ()> {
    let mut archive = tar::Archive::new(reader);
    let mut expanded_size = 0_u64;
    for entry in archive.entries().map_err(|_| ())? {
        let mut entry = entry.map_err(|_| ())?;
        let size = entry.size();
        expanded_size = expanded_size.checked_add(size).ok_or(())?;
        if size > 50 * 1024 * 1024 || expanded_size > 512 * 1024 * 1024 {
            return Err(());
        }
        let unpacked = entry.unpack_in(destination).map_err(|_| ())?;
        if !unpacked {
            return Err(());
        }
    }
    Ok(())
}

fn store_binary_files_as_lfs(worktree: &Path, repository: &Path) -> Result<(), ()> {
    fn visit(directory: &Path, repository: &Path) -> Result<(), ()> {
        for entry in fs::read_dir(directory).map_err(|_| ())? {
            let entry = entry.map_err(|_| ())?;
            let path = entry.path();
            let kind = entry.file_type().map_err(|_| ())?;
            if kind.is_dir() {
                if entry.file_name() != ".git" {
                    visit(&path, repository)?;
                }
                continue;
            }
            if !kind.is_file()
                || path
                    .file_name()
                    .is_some_and(|name| name == ".gitattributes")
            {
                continue;
            }
            let content = fs::read(&path).map_err(|_| ())?;
            if !is_binary(&path, &content) {
                continue;
            }
            let hash = format!("{:x}", Sha256::digest(&content));
            let object = repository
                .join("lfs/objects")
                .join(&hash[..2])
                .join(&hash[2..4])
                .join(&hash);
            if let Some(parent) = object.parent() {
                fs::create_dir_all(parent).map_err(|_| ())?;
            }
            fs::write(object, &content).map_err(|_| ())?;
            let pointer = format!(
                "version https://git-lfs.github.com/spec/v1\noid sha256:{hash}\nsize {}\n",
                content.len()
            );
            fs::write(path, pointer).map_err(|_| ())?;
        }
        Ok(())
    }

    visit(worktree, repository)
}

fn is_binary(path: &Path, content: &[u8]) -> bool {
    const BINARY_EXTENSIONS: &[&str] = &[
        "7z", "avif", "bmp", "doc", "docx", "exe", "gif", "gz", "heic", "jpg", "jpeg", "mov",
        "mp3", "mp4", "pdf", "png", "ppt", "pptx", "psd", "rar", "svgz", "tar", "tif", "tiff",
        "wav", "webm", "webp", "zip",
    ];
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            BINARY_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
        || content.contains(&0)
        || std::str::from_utf8(content).is_err()
}

fn seed_attributes(repository: &Path) -> Result<(), ()> {
    let worktree = repository.with_extension("seed");
    let _ = fs::remove_dir_all(&worktree);
    let clone = Command::new("git")
        .args(["clone", "--no-hardlinks", "--"])
        .arg(repository)
        .arg(&worktree)
        .output()
        .map_err(|_| ())?;
    if !clone.status.success() {
        return Err(());
    }
    let attrs = worktree.join(".gitattributes");
    seed_attributes_file(&attrs)?;
    let add = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["add", ".gitattributes"])
        .output()
        .map_err(|_| ())?;
    if !add.status.success() {
        return Err(());
    }
    let changed = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["diff", "--cached", "--quiet"])
        .status()
        .map_err(|_| ())?;
    if !changed.success() {
        let commit = Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args([
                "-c",
                "user.name=Weft",
                "-c",
                "user.email=weft@localhost",
                "commit",
                "-m",
                "Seed binary file attributes",
            ])
            .output()
            .map_err(|_| ())?;
        if !commit.status.success() {
            return Err(());
        }
        let push = Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args(["push", "origin", "HEAD:main"])
            .output()
            .map_err(|_| ())?;
        if !push.status.success() {
            return Err(());
        }
    }
    let _ = fs::remove_dir_all(worktree);
    for (key, value) in [
        ("filter.lfs.clean", "git-lfs clean -- %f"),
        ("filter.lfs.smudge", "git-lfs smudge -- %f"),
        ("filter.lfs.process", "git-lfs filter-process"),
        ("filter.lfs.required", "true"),
    ] {
        let config = Command::new("git")
            .arg("--git-dir")
            .arg(repository)
            .args(["config", key, value])
            .status()
            .map_err(|_| ())?;
        if !config.success() {
            return Err(());
        }
    }
    Ok(())
}

fn seed_attributes_file(attrs: &Path) -> Result<(), ()> {
    let mut existing = fs::read_to_string(attrs).unwrap_or_default();
    for line in BINARY_ATTRIBUTES.lines() {
        let pattern = line.split_whitespace().next().unwrap_or_default();
        if !existing
            .lines()
            .any(|current| current.split_whitespace().next() == Some(pattern))
        {
            existing.push_str(line);
            existing.push('\n');
        }
    }
    fs::write(attrs, existing).map_err(|_| ())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), ()> {
    for entry in fs::read_dir(from).map_err(|_| ())? {
        let entry = entry.map_err(|_| ())?;
        let source = entry.path();
        let destination = to.join(entry.file_name());
        let kind = entry.file_type().map_err(|_| ())?;
        if kind.is_dir() {
            fs::create_dir_all(&destination).map_err(|_| ())?;
            copy_tree(&source, &destination)?;
        } else if kind.is_file() {
            fs::copy(source, destination).map_err(|_| ())?;
        } else {
            return Err(());
        }
    }
    Ok(())
}
