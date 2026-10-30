use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    collaboration::task_access,
};

const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/tasks/:task_id/comments/:comment_id/attachments",
            post(upload).layer(axum::extract::DefaultBodyLimit::max(21 * 1024 * 1024)),
        )
        .route("/attachments/:storage_key", get(download))
}

#[derive(Deserialize)]
struct AttachmentInput {
    file_name: String,
    content_type: String,
    content_hex: String,
}

#[derive(Deserialize)]
struct DownloadQuery {
    preview: Option<bool>,
}

#[derive(Serialize)]
pub(crate) struct AttachmentView {
    id: Uuid,
    storage_key: Uuid,
    file_name: String,
    content_type: String,
    size: usize,
    download_url: String,
    preview_url: Option<String>,
}

pub(crate) async fn for_comment(
    pool: &sqlx::PgPool,
    comment: Uuid,
) -> Result<Vec<AttachmentView>, sqlx::Error> {
    // Only the signature bytes are needed to decide whether a preview exists: reading the whole
    // column here would pull every attachment body into memory on each comment list.
    let rows = sqlx::query(&format!(
        "SELECT id,storage_key,file_name,content_type,octet_length(content) AS size,substring(content from 1 for {SNIFF_BYTES}) AS head FROM task_attachments WHERE comment_id=$1 ORDER BY created_at,id"
    ))
    .bind(comment)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let key = row.get::<Uuid, _>("storage_key");
            let previewable =
                preview_type(&row.get::<Vec<u8>, _>("head"), row.get("content_type")).is_some();
            let base = format!("/api/v1/attachments/{key}");
            AttachmentView {
                id: row.get("id"),
                storage_key: key,
                file_name: row.get("file_name"),
                content_type: row.get("content_type"),
                size: row.get::<i32, _>("size") as usize,
                download_url: base.clone(),
                preview_url: previewable.then(|| format!("{base}?preview=true")),
            }
        })
        .collect())
}

async fn upload(
    State(state): State<AuthState>,
    Path((task, comment)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<AttachmentInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !matches!(
        task_access(&state.pool, task, user, true).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(comment_row) = sqlx::query(
        "SELECT workspace_id FROM task_comments WHERE id=$1 AND task_id=$2 AND deleted_at IS NULL",
    )
    .bind(comment)
    .bind(task)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(content) = decode_hex(&input.content_hex) else {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    };
    let file_name = input.file_name.trim();
    let content_type = input.content_type.trim();
    if file_name.is_empty()
        || file_name.len() > 255
        || file_name.chars().any(char::is_control)
        || content_type.is_empty()
        || content_type.len() > 255
        || content.len() > MAX_ATTACHMENT_BYTES
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let id = Uuid::new_v4();
    let storage_key = Uuid::new_v4();
    let size = content.len();
    let preview_url = preview_type(&content, content_type)
        .map(|_| format!("/api/v1/attachments/{storage_key}?preview=true"));
    let result = sqlx::query("INSERT INTO task_attachments(id,workspace_id,task_id,uploaded_by,file_name,content_type,content,comment_id,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(id).bind(comment_row.get::<Uuid,_>("workspace_id")).bind(task).bind(user)
        .bind(file_name).bind(content_type).bind(content).bind(comment).bind(storage_key)
        .execute(&state.pool).await;
    match result {
        Ok(_) => (
            StatusCode::CREATED,
            Json(json!({
                "id": id,
                "storage_key": storage_key,
                "file_name": file_name,
                "content_type": content_type,
                "size": size,
                "download_url": format!("/api/v1/attachments/{storage_key}"),
                "preview_url": preview_url,
            })),
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn download(
    State(state): State<AuthState>,
    Path(storage_key): Path<Uuid>,
    Query(query): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let Some(reference) = sqlx::query(
        "SELECT a.task_id FROM task_attachments a JOIN task_comments c ON c.id=a.comment_id WHERE a.storage_key=$1 AND c.deleted_at IS NULL",
    )
    .bind(storage_key)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let task = reference.get::<Uuid, _>("task_id");
    if !matches!(
        task_access(&state.pool, task, user, false).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let row = match sqlx::query("SELECT file_name,content_type,content FROM task_attachments WHERE storage_key=$1 AND comment_id IS NOT NULL")
        .bind(storage_key).fetch_optional(&state.pool).await {
        Ok(Some(row)) => row,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let filename = row.get::<String, _>("file_name");
    let declared_type = row.get::<String, _>("content_type");
    let content = row.get::<Vec<u8>, _>("content");
    let mut response = if query.preview == Some(true) {
        let Some(safe_type) = preview_type(&content, &declared_type) else {
            return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
        };
        (
            [
                (header::CONTENT_TYPE, HeaderValue::from_static(safe_type)),
                (
                    header::CONTENT_DISPOSITION,
                    HeaderValue::from_static("inline"),
                ),
            ],
            content,
        )
            .into_response()
    } else {
        let safe_name = filename
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            .collect::<String>();
        let disposition = format!(
            "attachment; filename=\"{}\"",
            if safe_name.is_empty() {
                "download"
            } else {
                &safe_name
            }
        );
        let Ok(disposition) = HeaderValue::from_str(&disposition) else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/octet-stream"),
                ),
                (header::CONTENT_DISPOSITION, disposition),
            ],
            content,
        )
            .into_response()
    };
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// Longest signature `preview_type` inspects (WebP: `RIFF` + size + `WEBP`).
const SNIFF_BYTES: usize = 16;

fn preview_type(content: &[u8], declared: &str) -> Option<&'static str> {
    match declared
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" if content.starts_with(b"\x89PNG\r\n\x1a\n") => Some("image/png"),
        "image/jpeg" if content.starts_with(b"\xff\xd8\xff") => Some("image/jpeg"),
        "image/gif" if content.starts_with(b"GIF87a") || content.starts_with(b"GIF89a") => {
            Some("image/gif")
        }
        "image/webp"
            if content.len() >= 12 && &content[..4] == b"RIFF" && &content[8..12] == b"WEBP" =>
        {
            Some("image/webp")
        }
        "application/pdf" if content.starts_with(b"%PDF-") => Some("application/pdf"),
        _ => None,
    }
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let digit = |byte| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            Some(digit(pair[0])? * 16 + digit(pair[1])?)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{preview_type, SNIFF_BYTES};

    #[test]
    fn the_sniffed_prefix_decides_the_preview_type_like_the_whole_file() {
        let mut webp = b"RIFF\0\0\0\0WEBP".to_vec();
        webp.resize(4096, 7);
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.resize(4096, 7);
        for (content, declared) in [(webp, "image/webp"), (png, "image/png")] {
            assert!(preview_type(&content[..SNIFF_BYTES], declared).is_some());
        }
    }
}
