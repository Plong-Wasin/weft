use std::{
    fs::{self, File},
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
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

const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_ARCHIVE_PATH_DEPTH: usize = 64;
const MAX_IMPORTED_REPOSITORY_BYTES: u64 = 512 * 1024 * 1024;
const REPOSITORY_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

pub fn git_command() -> Command {
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "http.followRedirects=false",
        ])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("NO_PROXY", "*")
        .env("no_proxy", "*")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_TEMPLATE_DIR");
    command
}

pub fn git_readonly_command() -> Command {
    let mut command = git_command();
    command.args([
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=never",
    ]);
    command
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
    if !repository_url_is_allowed(url).await {
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

async fn repository_url_is_allowed(url: &str) -> bool {
    let (scheme, remainder) = match url.split_once("://") {
        Some(parts) => parts,
        None => return false,
    };
    let default_port = match scheme {
        "http" => 80,
        "https" => 443,
        "git" => 9418,
        _ => return false,
    };
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    let allowed_hosts = std::env::var("WEFT_VAULT_IMPORT_HOSTS").unwrap_or_default();
    repository_authority_is_allowed(authority, default_port, &allowed_hosts)
}

fn repository_authority_is_allowed(authority: &str, default_port: u16, allowed: &str) -> bool {
    let Some(requested) = parse_repository_authority(authority, default_port) else {
        return false;
    };
    allowed
        .split(',')
        .filter_map(|entry| parse_repository_authority(entry.trim(), default_port))
        .any(|entry| entry.0 == requested.0)
}

fn parse_repository_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let (host, port) = if let Some(ipv6) = authority.strip_prefix('[') {
        let (host, suffix) = ipv6.split_once(']')?;
        let port = if suffix.is_empty() {
            default_port
        } else {
            suffix.strip_prefix(':')?.parse::<u16>().ok()?
        };
        (host, port)
    } else if let Some((host, value)) = authority.rsplit_once(':') {
        if value.bytes().all(|byte| byte.is_ascii_digit()) {
            (host, value.parse::<u16>().ok()?)
        } else {
            return None;
        }
    } else {
        (authority, default_port)
    };
    if host.is_empty() {
        return None;
    }
    Some((host.trim_end_matches('.').to_ascii_lowercase(), port))
}

fn lfs_endpoint(repository_url: &str) -> String {
    let repository_url = repository_url
        .split(['?', '#'])
        .next()
        .unwrap_or(repository_url)
        .trim_end_matches('/');
    format!("{repository_url}/info/lfs")
}

fn run_limited_git(mut command: Command, repository: &Path) -> Result<(), ()> {
    use std::process::Stdio;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(()) },
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(());
            }
        }
        let size_exceeded = repository.exists()
            && directory_size(repository).is_none_or(|size| size > MAX_IMPORTED_REPOSITORY_BYTES);
        if started.elapsed() >= REPOSITORY_COMMAND_TIMEOUT || size_exceeded {
            let _ = child.kill();
            let _ = child.wait();
            return Err(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn directory_size(root: &Path) -> Option<u64> {
    let mut total = 0_u64;
    let mut pending = vec![root.to_owned()];
    while let Some(path) = pending.pop() {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            match fs::read_dir(path) {
                Ok(entries) => {
                    for entry in entries {
                        match entry {
                            Ok(entry) => pending.push(entry.path()),
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                            Err(_) => return None,
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return None,
            }
        } else if metadata.is_file() {
            total = total.checked_add(metadata.len())?;
            if total > MAX_IMPORTED_REPOSITORY_BYTES {
                return Some(total);
            }
        }
    }
    Some(total)
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
    let archive_dir = std::env::temp_dir().join(format!("weft-vault-import-{job}"));
    let archive = archive_dir.join("upload.tar");
    let write_result = tokio::task::spawn_blocking({
        let archive_dir = archive_dir.clone();
        let archive = archive.clone();
        move || write_private_upload(&archive_dir, &archive, &body)
    })
    .await;
    if !matches!(write_result, Ok(Ok(()))) {
        let _ = fs::remove_dir_all(&archive_dir);
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

fn write_private_upload(directory: &Path, archive: &Path, body: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        fs::DirBuilder::new().mode(0o700).create(directory)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(archive)?;
        std::io::Write::write_all(&mut file, body)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(directory)?;
        fs::write(archive, body)
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
    let archive_path = match &source {
        ImportSource::Archive(path) => Some(path.clone()),
        ImportSource::Repository(_) => None,
    };
    let mut cleanup = ImportCleanup { paths: Vec::new() };
    if let Some(path) = archive_path.as_ref() {
        if let Some(parent) = path.parent() {
            cleanup.paths.push(parent.to_owned());
        }
    }
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
    cleanup.paths.extend(
        ["archive", "new", "work", "import", "seed"]
            .map(|suffix| repository.with_extension(suffix)),
    );
    let import_result = tokio::task::spawn_blocking({
        let repository = repository.clone();
        move || match source {
            ImportSource::Repository(url) => import_repository_history(&url, &repository),
            ImportSource::Archive(path) => import_archive_files(&path, &repository),
        }
    })
    .await;
    match import_result {
        Ok(Ok(staged_repository)) => {
            let swap = {
                let mut maintenance_guard = match crate::maintenance_write_guard(&state.pool).await
                {
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
                if set_status(&state, job, "reindexing", "running")
                    .await
                    .is_err()
                {
                    let _ =
                        mark_failed(&state, job, "Could not prepare the Vault search index").await;
                    return;
                }
                if sqlx::query("INSERT INTO vault_search_states(vault_id,status,parser_version) VALUES($1,'running',NULL) ON CONFLICT(vault_id) DO UPDATE SET status='running',updated_at=now()")
                    .bind(vault)
                    .execute(&mut *maintenance_guard)
                    .await
                    .is_err()
                {
                    let _ = mark_failed(&state, job, "Could not prepare the Vault search index").await;
                    return;
                }
                tokio::task::spawn_blocking({
                    let repository = repository.clone();
                    move || replace_repository(&staged_repository, &repository)
                })
                .await
            };
            if !matches!(swap, Ok(Ok(()))) {
                let _ = mark_failed(&state, job, "Could not install imported repository").await;
                return;
            }
            let indexed = tokio::task::spawn_blocking(move || index_files(&repository)).await;
            match indexed {
                Ok(Ok(files)) => {
                    let result = async {
                        crate::knowledge::search::reindex_import(&state, vault, files).await?;
                        cleanup.clean();
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
    let listed = git_readonly_command()
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
        let Ok(path) = std::str::from_utf8(path) else {
            continue;
        };
        if path == ".obsidian" || path.starts_with(".obsidian/") {
            continue;
        }
        let object = metadata
            .split(|byte| *byte == b' ')
            .nth(2)
            .and_then(|value| std::str::from_utf8(value).ok())
            .ok_or(())?;
        let content = git_readonly_command()
            .arg("--git-dir")
            .arg(repository)
            .args(["cat-file", "blob", object])
            .output()
            .map_err(|_| ())?;
        if !content.status.success() {
            files.push((path.to_owned(), None));
            continue;
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
    let mut tx = state.pool.begin().await?;
    let job_state: Option<(Uuid, String)> = sqlx::query_as("UPDATE vault_import_jobs SET status='failed',reindex_status=CASE WHEN reindex_status='running' THEN 'failed' ELSE reindex_status END,error=$2,updated_at=now() WHERE id=$1 RETURNING vault_id,reindex_status")
        .bind(job).bind(message).fetch_optional(&mut *tx).await?;
    if let Some((vault, _)) = job_state.filter(|(_, status)| status == "failed") {
        sqlx::query("UPDATE vault_search_states SET status='failed',updated_at=now() WHERE vault_id=$1 AND status='running'")
            .bind(vault).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

fn import_repository_history(url: &str, repository: &Path) -> Result<PathBuf, ()> {
    let staging = repository.with_extension("import");
    let _ = fs::remove_dir_all(&staging);
    let mut clone = git_command();
    clone
        .arg("-c")
        .arg("protocol.allow=always")
        .args(["clone", "--mirror", "--filter=blob:limit=16m", "--", url])
        .arg(&staging)
        .env("GIT_TERMINAL_PROMPT", "0");
    if run_limited_git(clone, &staging).is_err() {
        let _ = fs::remove_dir_all(&staging);
        return Err(());
    }
    if Command::new("git-lfs").arg("version").output().is_ok() {
        let mut lfs = git_command();
        let lfs_url = lfs_endpoint(url);
        lfs.args([
            "-c",
            "protocol.allow=always",
            "-c",
            &format!("lfs.url={lfs_url}"),
        ])
        .arg("--git-dir")
        .arg(&staging)
        .args(["lfs", "fetch", "--all"])
        .env("GIT_TERMINAL_PROMPT", "0");
        if run_limited_git(lfs, &staging).is_err() {
            let _ = fs::remove_dir_all(&staging);
            return Err(());
        }
    }
    // The clone is deliberately partial for bandwidth, but subsequent Vault reads are
    // offline. Remove promisor metadata before any read-only Git command can inspect it.
    for key in [
        "remote.origin.promisor",
        "remote.origin.partialclonefilter",
        "extensions.partialclone",
    ] {
        let _ = git_command()
            .arg("--git-dir")
            .arg(&staging)
            .args(["config", "--unset-all", key])
            .status();
    }
    seed_attributes(&staging)?;
    Ok(staging)
}

fn import_archive_files(archive_path: &Path, repository: &Path) -> Result<PathBuf, ()> {
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
    let init = git_command()
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&staged_repo)
        .output()
        .map_err(|_| ())?;
    if !init.status.success() {
        return Err(());
    }
    let worktree = repository.with_extension("work");
    let _ = fs::remove_dir_all(&worktree);
    let clone = git_command()
        .args(["clone", "--", staged_repo.to_str().ok_or(())?])
        .arg(&worktree)
        .output()
        .map_err(|_| ())?;
    if !clone.status.success() {
        return Err(());
    }
    copy_tree(&unpacked, &worktree)?;
    store_binary_files_as_lfs(&worktree, &staged_repo)?;
    let add = git_command()
        .arg("-C")
        .arg(&worktree)
        .args(["add", "-A"])
        .output()
        .map_err(|_| ())?;
    if !add.status.success() {
        return Err(());
    }
    let commit = git_command()
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
    let push = git_command()
        .arg("-C")
        .arg(&worktree)
        .args(["push", "origin", "main"])
        .output()
        .map_err(|_| ())?;
    if !push.status.success() {
        return Err(());
    }
    Ok(staged_repo)
}

struct ImportCleanup {
    paths: Vec<PathBuf>,
}

impl ImportCleanup {
    fn clean(&mut self) {
        for path in self.paths.drain(..) {
            if path.is_dir() {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
        }
    }
}

impl Drop for ImportCleanup {
    fn drop(&mut self) {
        self.clean();
    }
}

fn replace_repository(staged: &Path, repository: &Path) -> Result<(), ()> {
    let old = repository.with_extension("old");
    if old.exists() && !repository.exists() {
        fs::rename(&old, repository).map_err(|_| ())?;
    } else if old.exists() {
        fs::remove_dir_all(&old).map_err(|_| ())?;
    }
    if repository.exists() {
        fs::rename(repository, &old).map_err(|_| ())?;
    }
    if fs::rename(staged, repository).is_err() {
        if old.exists() {
            let _ = fs::rename(&old, repository);
        }
        return Err(());
    }
    if old.exists() {
        fs::remove_dir_all(old).map_err(|_| ())?;
    }
    Ok(())
}

fn unpack_archive<R: Read>(reader: R, destination: &Path) -> Result<(), ()> {
    let mut archive = tar::Archive::new(reader);
    let mut expanded_size = 0_u64;
    let mut entry_count = 0_usize;
    for entry in archive.entries().map_err(|_| ())? {
        let mut entry = entry.map_err(|_| ())?;
        entry_count = entry_count.checked_add(1).ok_or(())?;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err(());
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(());
        }
        let path = entry.path().map_err(|_| ())?;
        if path.as_os_str().to_string_lossy().len() > 4096 {
            return Err(());
        }
        let mut depth = 0;
        for component in path.components() {
            match component {
                Component::Normal(part) => {
                    depth += 1;
                    if part.to_string_lossy().eq_ignore_ascii_case(".git") {
                        return Err(());
                    }
                }
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => return Err(()),
            }
        }
        if depth > MAX_ARCHIVE_PATH_DEPTH {
            return Err(());
        }
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
    let clone = git_command()
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
    let add = git_command()
        .arg("-C")
        .arg(&worktree)
        .args(["add", ".gitattributes"])
        .output()
        .map_err(|_| ())?;
    if !add.status.success() {
        return Err(());
    }
    let changed = git_command()
        .arg("-C")
        .arg(&worktree)
        .args(["diff", "--cached", "--quiet"])
        .status()
        .map_err(|_| ())?;
    if !changed.success() {
        let commit = git_command()
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
        let push = git_command()
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
        let config = git_command()
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
    let existing = read_regular_file_without_following_links(attrs)?;
    let mut additions = String::new();
    for line in BINARY_ATTRIBUTES.lines() {
        let pattern = line.split_whitespace().next().unwrap_or_default();
        if !existing
            .lines()
            .any(|current| current.split_whitespace().next() == Some(pattern))
        {
            additions.push_str(line);
            additions.push('\n');
        }
    }
    if additions.is_empty() {
        return Ok(());
    }
    append_regular_file_without_following_links(attrs, additions.as_bytes())
}

fn read_regular_file_without_following_links(path: &Path) -> Result<String, ()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(_) => return Err(()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix_o_nofollow());
    }
    let mut file = options.open(path).map_err(|_| ())?;
    let mut existing = String::new();
    file.read_to_string(&mut existing).map_err(|_| ())?;
    Ok(existing)
}

fn append_regular_file_without_following_links(path: &Path, additions: &[u8]) -> Result<(), ()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix_o_nofollow());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            options.create_new(true);
        }
        Err(_) => return Err(()),
    }
    let mut file = options.open(path).map_err(|_| ())?;
    file.write_all(additions).map_err(|_| ())
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn nix_o_nofollow() -> i32 {
    0x8000
}

#[cfg(all(target_os = "linux", not(target_arch = "aarch64")))]
fn nix_o_nofollow() -> i32 {
    0x20000
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), ()> {
    for entry in fs::read_dir(from).map_err(|_| ())? {
        let entry = entry.map_err(|_| ())?;
        if entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(".git")
        {
            continue;
        }
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

#[cfg(test)]
mod tests {
    use super::seed_attributes_file;
    use std::process::Command;
    use std::{fs, os::unix::fs::symlink};
    use uuid::Uuid;

    #[test]
    fn attribute_seeding_rejects_symlinks_without_modifying_the_target() {
        let directory = std::env::temp_dir().join(format!("weft-gitattributes-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let target = directory.join("outside");
        let attributes = directory.join(".gitattributes");
        fs::write(&target, "keep this file unchanged\n").unwrap();
        symlink(&target, &attributes).unwrap();

        assert!(seed_attributes_file(&attributes).is_err());
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            "keep this file unchanged\n"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn repository_allowlist_normalizes_hosts_and_validates_ports() {
        use super::{parse_repository_authority, repository_authority_is_allowed};

        assert_eq!(
            parse_repository_authority("Git.Example.", 443),
            Some(("git.example".to_owned(), 443))
        );
        assert_eq!(
            parse_repository_authority("git.example:8443", 443),
            Some(("git.example".to_owned(), 8443))
        );
        assert_eq!(
            parse_repository_authority("[::1]:9418", 443),
            Some(("::1".to_owned(), 9418))
        );
        assert_eq!(parse_repository_authority("user@git.example", 443), None);
        assert_eq!(
            parse_repository_authority("git.example:not-a-port", 443),
            None
        );
        assert!(repository_authority_is_allowed(
            "Git.Example.",
            443,
            "git.example"
        ));
        assert!(repository_authority_is_allowed(
            "git.example:8443",
            443,
            "git.example"
        ));
        assert!(!repository_authority_is_allowed(
            "git.other:8443",
            443,
            "git.example"
        ));
        assert!(!repository_authority_is_allowed(
            "user@git.example",
            443,
            "git.example"
        ));
        assert!(repository_authority_is_allowed("[::1]", 9418, "[::1]"));
        assert!(repository_authority_is_allowed("[::1]:80", 9418, "[::1]"));
        assert_ne!(
            parse_repository_authority("git.example:8443", 443),
            parse_repository_authority("git.example", 443)
        );
    }

    #[test]
    fn read_only_git_commands_block_network_access() {
        use super::git_readonly_command;

        assert!(git_readonly_command()
            .get_args()
            .any(|arg| arg == "protocol.allow=never"));
    }

    #[test]
    fn non_utf8_repository_paths_are_skipped_during_indexing() {
        use std::os::unix::ffi::OsStringExt;

        let root = std::env::temp_dir().join(format!("weft-index-test-{}", Uuid::new_v4()));
        let repo = root.join("repo.git");
        let work = root.join("work");
        assert!(Command::new("git")
            .args(["init", "--bare", "--initial-branch=main"])
            .arg(&repo)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["clone", "--"])
            .arg(&repo)
            .arg(&work)
            .status()
            .unwrap()
            .success());
        fs::write(
            work.join(std::ffi::OsString::from_vec(b"bad-\xff.md".to_vec())),
            "ignored",
        )
        .unwrap();
        assert!(Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["add", "--all"])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&work)
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "test"
            ])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["push", "origin", "HEAD:main"])
            .status()
            .unwrap()
            .success());
        assert!(super::index_files(&repo).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nofollow_flag_matches_linux_architecture() {
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        assert_eq!(super::nix_o_nofollow(), 0x8000);
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        assert_eq!(super::nix_o_nofollow(), 0x20000);
    }

    #[test]
    fn lfs_endpoint_uses_only_the_validated_repository_origin_and_path() {
        use super::lfs_endpoint;

        assert_eq!(
            lfs_endpoint("https://git.example/team/notes.git?token=ignored#fragment"),
            "https://git.example/team/notes.git/info/lfs"
        );
    }
}
