use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use axum::{
    body::Body,
    extract::{Path as AxumPath, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
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

    let archive = match tokio::task::spawn_blocking(move || build_archive(&repository)).await {
        Ok(Ok(path)) => path,
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
        let _ = fs::remove_file(archive);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let file = match tokio::fs::File::open(&archive).await {
        Ok(file) => file,
        Err(_) => {
            let _ = fs::remove_file(archive);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // Unlinking an open file keeps the archive alive for the response and cleans it up when the
    // client disconnects or finishes downloading.
    if fs::remove_file(&archive).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
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
    response
}

fn build_archive(repository: &str) -> Result<PathBuf, ()> {
    let archive = std::env::temp_dir().join(format!("weft-vault-export-{}.zip", Uuid::new_v4()));
    let file = File::options()
        .write(true)
        .read(true)
        .create_new(true)
        .open(&archive)
        .map_err(|_| ())?;
    let result = write_archive(repository, file);
    if result.is_err() {
        let _ = fs::remove_file(&archive);
    }
    result.map(|()| archive)
}

fn write_archive(repository: &str, file: File) -> Result<(), ()> {
    let listing = Command::new("git")
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
        let head = Command::new("git")
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
            return ZipWriter::new(file).finish().map(|_| ()).map_err(|_| ());
        }
        return Err(());
    }

    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    for record in listing
        .stdout
        .split(|byte| *byte == 0)
        .filter(|row| !row.is_empty())
    {
        let separator = record.iter().position(|byte| *byte == b'\t').ok_or(())?;
        let (metadata, path) = record.split_at(separator);
        let path = std::str::from_utf8(&path[1..]).map_err(|_| ())?;
        if path == ".git" || path.starts_with(".git/") {
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
        zip.start_file(path, options).map_err(|_| ())?;
        write_blob(&mut zip, repository, object)?;
    }
    zip.finish().map(|_| ()).map_err(|_| ())
}

fn write_blob(zip: &mut ZipWriter<File>, repository: &str, object: &[u8]) -> Result<(), ()> {
    let object = std::str::from_utf8(object).map_err(|_| ())?;
    let size = Command::new("git")
        .args(["--git-dir", repository, "cat-file", "-s", object])
        .output()
        .map_err(|_| ())?;
    if !size.status.success() {
        return Err(());
    }
    let size = std::str::from_utf8(&size.stdout)
        .map_err(|_| ())?
        .trim()
        .parse::<u64>()
        .map_err(|_| ())?;

    if size <= 1024 {
        let content = Command::new("git")
            .args(["--git-dir", repository, "cat-file", "blob", object])
            .output()
            .map_err(|_| ())?;
        if !content.status.success() {
            return Err(());
        }
        if let Some(pointer) = lfs_pointer(&content.stdout) {
            return copy_lfs_object(repository, &pointer, zip);
        }
        zip.write_all(&content.stdout).map_err(|_| ())?;
        return Ok(());
    }

    let mut child = Command::new("git")
        .args(["--git-dir", repository, "cat-file", "blob", object])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| ())?;
    let mut stdout = child.stdout.take().ok_or(())?;
    io::copy(&mut stdout, zip).map_err(|_| ())?;
    if !child.wait().map_err(|_| ())?.success() {
        return Err(());
    }
    Ok(())
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
