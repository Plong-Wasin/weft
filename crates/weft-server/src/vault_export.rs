use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
};

use axum::{
    body::Body,
    extract::{Path as AxumPath, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::io::ReaderStream;
use uuid::Uuid;
use zip::{write::SimpleFileOptions, ZipWriter};

use crate::{
    auth::{require_session, AuthState},
    projects::Role,
    vaults::evaluate_access,
};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new().route("/vaults/:vault_id/export", get(export_vault))
}

const MAX_EXPORT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CONCURRENT_EXPORTS: usize = 2;

fn global_semaphore() -> Arc<Semaphore> {
    static GLOBAL: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GLOBAL
        .get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_EXPORTS)))
        .clone()
}

enum UserPermitError {
    Busy,
    Capacity,
}

fn try_user_permit(actor: Uuid) -> Result<OwnedSemaphorePermit, UserPermitError> {
    static USERS: OnceLock<Mutex<HashMap<Uuid, Arc<Semaphore>>>> = OnceLock::new();
    let users = USERS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut users = users
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !users.contains_key(&actor) {
        users.retain(|_, semaphore| semaphore.available_permits() == 0);
        if users.len() >= 1024 {
            return Err(UserPermitError::Capacity);
        }
        users.insert(actor, Arc::new(Semaphore::new(1)));
    }
    users[&actor]
        .clone()
        .try_acquire_owned()
        .map_err(|_| UserPermitError::Busy)
}

async fn export_vault(
    State(state): State<AuthState>,
    AxumPath(vault): AxumPath<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let access = match evaluate_access(&state.pool, vault, actor).await {
        Ok(Some(access)) if access.role >= Role::Viewer => access,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let user_permit = match try_user_permit(actor) {
        Ok(permit) => permit,
        Err(UserPermitError::Busy) => return StatusCode::TOO_MANY_REQUESTS.into_response(),
        Err(UserPermitError::Capacity) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let Ok(global_permit) = global_semaphore().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let repository = sqlx::query_scalar::<_, String>(
        "SELECT repository_path FROM vaults WHERE id=$1 AND workspace_id=$2",
    )
    .bind(vault)
    .bind(access.workspace_id)
    .fetch_optional(&state.pool)
    .await;
    let Ok(Some(repository)) = repository else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };

    let (archive, skipped_entries) = match tokio::task::spawn_blocking(move || {
        let _permits = (user_permit, global_permit);
        build_archive(&repository)
    })
    .await
    {
        Ok(Ok(result)) => result,
        _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("INSERT INTO security_audit_events(actor_id,workspace_id,event,subject_id) VALUES($1,$2,'vault.exported',$3)")
        .bind(actor)
        .bind(access.workspace_id)
        .bind(vault)
        .execute(&state.pool)
        .await
        .is_err()
    {
        remove_archive(&archive);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let file = match tokio::fs::File::open(&archive).await {
        Ok(file) => file,
        Err(_) => {
            remove_archive(&archive);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // Unlinking an open file keeps the archive alive for the response and cleans it up when the
    // client disconnects or finishes downloading.
    if fs::remove_file(&archive).is_err() {
        remove_archive(&archive);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Some(parent) = archive.parent() {
        let _ = fs::remove_dir(parent);
    }
    let filename = format!("vault-{vault}.zip");
    let mut response = Body::from_stream(ReaderStream::new(file)).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .expect("UUID-derived content disposition is valid"),
    );
    response.headers_mut().insert(
        "x-weft-skipped-entries",
        HeaderValue::from_str(&skipped_entries.to_string()).expect("integer header is valid"),
    );
    response
}

fn remove_archive(archive: &Path) {
    let _ = fs::remove_file(archive);
    if let Some(parent) = archive.parent() {
        let _ = fs::remove_dir_all(parent);
    }
}

fn build_archive(repository: &str) -> Result<(PathBuf, usize), ()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let directory = std::env::temp_dir().join(format!("weft-vault-export-{}", Uuid::new_v4()));
    fs::create_dir(&directory).map_err(|_| ())?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(|_| ())?;
    let archive = directory.join("export.zip");
    let file = OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .mode(0o600)
        .open(&archive)
        .map_err(|_| ())?;
    let result = write_archive_with_limit(repository, file, MAX_EXPORT_BYTES);
    if result.is_err() {
        let _ = fs::remove_dir_all(&directory);
    }
    result.map(|skipped| (archive, skipped))
}

fn safe_export_path(path: &str) -> bool {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') {
        return false;
    }
    let mut depth = 0;
    for component in Path::new(path).components() {
        match component {
            std::path::Component::Normal(part) => {
                depth += 1;
                if part.to_string_lossy().eq_ignore_ascii_case(".git") {
                    return false;
                }
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => return false,
        }
    }
    depth <= 64
}

fn write_archive_with_limit(repository: &str, file: File, max_bytes: u64) -> Result<usize, ()> {
    let listing = crate::vault_import::git_command()
        .args([
            "--git-dir",
            repository,
            "ls-tree",
            "-rz",
            "--full-tree",
            "HEAD",
        ])
        .output()
        .map_err(|_| ())?;
    if !listing.status.success() {
        // A newly created, not-yet-imported Vault still has a useful empty snapshot.
        let head = crate::vault_import::git_command()
            .args([
                "--git-dir",
                repository,
                "rev-parse",
                "--verify",
                "--quiet",
                "HEAD",
            ])
            .output()
            .map_err(|_| ())?;
        if head.status.code() == Some(1) {
            return ZipWriter::new(file).finish().map(|_| 0).map_err(|_| ());
        }
        return Err(());
    }

    let mut entries = Vec::new();
    let mut skipped_entries = 0;
    let mut total_bytes = 0u64;
    for record in listing
        .stdout
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
    {
        let separator = record.iter().position(|byte| *byte == b'\t').ok_or(())?;
        let (metadata, path) = record.split_at(separator);
        let path = match std::str::from_utf8(&path[1..]) {
            Ok(path) => path,
            Err(_) => {
                skipped_entries += 1;
                continue;
            }
        };
        if !safe_export_path(path) {
            skipped_entries += 1;
            continue;
        }
        let mut metadata = metadata.split(|byte| *byte == b' ');
        let mode = metadata.next().ok_or(())?;
        let kind = metadata.next().ok_or(())?;
        let object = metadata.next().ok_or(())?;
        // Git trees can contain submodules; they are not files in the Vault's current tree.
        if kind != b"blob" || (mode != b"100644" && mode != b"100755" && mode != b"120000") {
            continue;
        }
        entries.push((
            path.to_owned(),
            String::from_utf8(object.to_vec()).map_err(|_| ())?,
        ));
    }
    let sizes = blob_sizes(repository, &entries)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    for ((path, object), size) in entries.iter().zip(sizes) {
        total_bytes = total_bytes.checked_add(size).ok_or(())?;
        if total_bytes > max_bytes {
            return Err(());
        }
        zip.start_file(path, options).map_err(|_| ())?;
        let written = write_blob(
            &mut zip,
            repository,
            object,
            size,
            max_bytes - (total_bytes - size),
        )?;
        if written > size {
            total_bytes = total_bytes.checked_add(written - size).ok_or(())?;
            if total_bytes > max_bytes {
                return Err(());
            }
        }
    }
    zip.finish().map(|_| skipped_entries).map_err(|_| ())
}

fn blob_sizes(repository: &str, entries: &[(String, String)]) -> Result<Vec<u64>, ()> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let mut child = crate::vault_import::git_command()
        .args([
            "--git-dir",
            repository,
            "cat-file",
            "--batch-check=%(objectsize)",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| ())?;
    {
        let mut stdin = child.stdin.take().ok_or(())?;
        for (_, object) in entries {
            writeln!(stdin, "{object}").map_err(|_| ())?;
        }
    }
    let output = child.wait_with_output().map_err(|_| ())?;
    if !output.status.success() {
        return Err(());
    }
    let sizes: Vec<u64> = std::str::from_utf8(&output.stdout)
        .map_err(|_| ())?
        .lines()
        .map(|size| size.parse::<u64>().map_err(|_| ()))
        .collect::<Result<_, _>>()?;
    if sizes.len() != entries.len() {
        return Err(());
    }
    Ok(sizes)
}

fn write_blob(
    zip: &mut ZipWriter<File>,
    repository: &str,
    object: &str,
    size: u64,
    remaining_bytes: u64,
) -> Result<u64, ()> {
    if size <= 1024 {
        let content = crate::vault_import::git_command()
            .args(["--git-dir", repository, "cat-file", "blob", object])
            .output()
            .map_err(|_| ())?;
        if !content.status.success() {
            return Err(());
        }
        if let Some(pointer) = lfs_pointer(&content.stdout) {
            if pointer.size > remaining_bytes {
                return Err(());
            }
            copy_lfs_object(repository, &pointer, zip)?;
            return Ok(pointer.size);
        }
        zip.write_all(&content.stdout).map_err(|_| ())?;
        return Ok(size);
    }

    let mut child = crate::vault_import::git_command()
        .args(["--git-dir", repository, "cat-file", "blob", object])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| ())?;
    let mut stdout = child.stdout.take().ok_or(())?;
    io::copy(&mut stdout, zip).map_err(|_| ())?;
    if !child.wait().map_err(|_| ())?.success() {
        return Err(());
    }
    Ok(size)
}

struct LfsPointer {
    oid: String,
    size: u64,
}

fn lfs_pointer(content: &[u8]) -> Option<LfsPointer> {
    let text = std::str::from_utf8(content).ok()?;
    let mut lines = text.lines();
    if lines.next()? != "version https://git-lfs.github.com/spec/v1" {
        return None;
    }
    let oid = lines.next()?.strip_prefix("oid sha256:")?;
    if oid.len() != 64 || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let size = lines.next()?.strip_prefix("size ")?.parse().ok()?;
    Some(LfsPointer {
        oid: oid.to_ascii_lowercase(),
        size,
    })
}

fn copy_lfs_object(
    repository: &str,
    pointer: &LfsPointer,
    zip: &mut ZipWriter<File>,
) -> Result<(), ()> {
    let object = Path::new(repository)
        .join("lfs/objects")
        .join(&pointer.oid[..2])
        .join(&pointer.oid[2..4])
        .join(&pointer.oid);
    let mut file = File::open(object).map_err(|_| ())?;
    if file.metadata().map_err(|_| ())?.len() != pointer.size {
        return Err(());
    }
    io::copy(&mut file, zip).map_err(|_| ())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    fn repository(with_invalid_name: bool) -> PathBuf {
        let root = std::env::temp_dir().join(format!("weft-export-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let repo = root.join("repo.git");
        assert!(std::process::Command::new("git")
            .args(["init", "--bare", "--initial-branch=main"])
            .arg(&repo)
            .status()
            .unwrap()
            .success());
        let work = root.join("work");
        assert!(std::process::Command::new("git")
            .args(["clone", "--"])
            .arg(&repo)
            .arg(&work)
            .status()
            .unwrap()
            .success());
        fs::write(work.join("note.md"), "note").unwrap();
        if with_invalid_name {
            let invalid_name = std::ffi::OsString::from_vec(b"bad-\xff.md".to_vec());
            fs::write(work.join(invalid_name), "skip me").unwrap();
        }
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&work)
                .args(args)
                .output()
                .unwrap()
        };
        assert!(git(&["add", "--all"]).status.success());
        assert!(git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "test"
        ])
        .status
        .success());
        assert!(git(&["push", "origin", "HEAD:main"]).status.success());
        repo
    }

    #[test]
    fn export_skips_non_utf8_paths_and_counts_them() {
        let repo = repository(true);
        let (archive, skipped) = build_archive(repo.to_str().unwrap()).unwrap();
        assert_eq!(skipped, 1);
        let mut zip = zip::ZipArchive::new(File::open(&archive).unwrap()).unwrap();
        assert_eq!(zip.len(), 1);
        assert!(zip.by_name("note.md").is_ok());
        let parent = archive.parent().unwrap().to_owned();
        fs::remove_file(archive).unwrap();
        let _ = fs::remove_dir_all(repo.parent().unwrap());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn export_archive_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let repo = repository(false);
        let (archive, _) = build_archive(repo.to_str().unwrap()).unwrap();
        assert_eq!(
            fs::metadata(&archive).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let dir = archive.parent().unwrap();
        assert_eq!(
            fs::metadata(dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let _ = fs::remove_dir_all(repo.parent().unwrap());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn export_refuses_a_tree_larger_than_its_byte_limit() {
        let repo = repository(false);
        let (path, file) = create_output_file();
        assert!(write_archive_with_limit(repo.to_str().unwrap(), file, 3).is_err());
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(repo.parent().unwrap());
    }

    fn create_output_file() -> (PathBuf, File) {
        let path = std::env::temp_dir().join(format!("weft-export-output-{}.zip", Uuid::new_v4()));
        (path.clone(), File::create(path).unwrap())
    }
}
