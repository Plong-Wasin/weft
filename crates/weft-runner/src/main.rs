//! Outbound-only Weft runner. This build supports only the scripted provider; provider CLI
//! modes remain unsupported until their scoped-tool guarantees have been verified.
use reqwest::{Client, Url};
use ring::signature;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

mod provider;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const POLL_DELAY: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize, Deserialize)]
struct Store {
    origin: String,
    runner_id: Uuid,
    token: String,
    server_signing_key: String,
    scope: String,
    version: String,
}

#[derive(Deserialize)]
struct JobEnvelope {
    job: Option<Job>,
}
#[derive(Deserialize)]
struct Job {
    id: Uuid,
    connection_id: Uuid,
    provider_mode: String,
    payload: Value,
    signature: String,
    server_signing_key: String,
}

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        eprintln!("weft-runner: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("pair") => {
            let options = parse_options(args.collect())?;
            let origin = required(&options, "origin")?;
            validate_origin(origin)?;
            let code = required(&options, "code")?;
            let name = options.get("name").map(String::as_str).unwrap_or("Weft runner");
            let scope = options.get("scope").map(String::as_str).unwrap_or("personal");
            if scope != "personal" && scope != "global" { return Err("scope must be personal or global".into()); }
            let store_root = PathBuf::from(required(&options, "store-root")?);
            let client = client()?;
            let response = client.post(endpoint(origin, "/api/v1/ai/agent/pair"))
                .json(&json!({"code":code,"name":name,"version":VERSION,"supported_modes":["scripted"]}))
                .send().await.map_err(|_| "could not reach the configured Weft origin")?;
            if !response.status().is_success() { return Err(format!("pairing failed with HTTP {}", response.status())); }
            let value: Value = response.json().await.map_err(|_| "invalid pairing response")?;
            let store = Store {
                origin: origin.to_owned(),
                runner_id: value["runner_id"].as_str().ok_or("pairing response missing runner id")?.parse().map_err(|_| "invalid runner id")?,
                token: value["token"].as_str().ok_or("pairing response missing token")?.to_owned(),
                server_signing_key: value["server_signing_key"].as_str().ok_or("pairing response missing signing key")?.to_owned(),
                scope: scope.to_owned(),
                version: VERSION.to_owned(),
            };
            let path = store_path(&store_root, &store.scope, store.runner_id);
            write_private(&path, &serde_json::to_vec(&store).map_err(|_| "could not encode runner store")?)?;
            println!("paired runner {}; store: {}", store.runner_id, path.display());
            Ok(())
        }
        Some("run") => {
            let options = parse_options(args.collect())?;
            let store_root = PathBuf::from(required(&options, "store-root")?);
            let scope = options.get("scope").map(String::as_str).unwrap_or("personal");
            if scope != "personal" && scope != "global" { return Err("scope must be personal or global".into()); }
            let runner = required(&options, "runner-id")?.parse::<Uuid>().map_err(|_| "invalid runner id")?;
            let path = store_path(&store_root, scope, runner);
            let store: Store = serde_json::from_slice(&fs::read(path).map_err(|_| "runner store is missing")?).map_err(|_| "runner store is invalid")?;
            if store.scope != scope || store.runner_id != runner { return Err("runner store scope mismatch".into()); }
            serve_jobs(store).await
        }
        _ => Err("usage: weft-runner pair --origin ORIGIN --code CODE --store-root DIR [--scope personal|global] | run --store-root DIR --runner-id ID [--scope personal|global]".into()),
    }
}

async fn serve_jobs(store: Store) -> Result<(), String> {
    validate_origin(&store.origin)?;
    let client = client()?;
    loop {
        let heartbeat = client
            .post(endpoint(&store.origin, "/api/v1/ai/agent/heartbeat"))
            .bearer_auth(&store.token)
            .json(&json!({"version":VERSION}))
            .send()
            .await;
        let Ok(heartbeat) = heartbeat else {
            tokio::time::sleep(POLL_DELAY).await;
            continue;
        };
        if !heartbeat.status().is_success() {
            return Err("runner authentication was rejected".into());
        }
        let response = client
            .post(endpoint(&store.origin, "/api/v1/ai/agent/jobs/lease"))
            .bearer_auth(&store.token)
            .json(&json!({"lease_seconds":60}))
            .send()
            .await;
        let Ok(response) = response else {
            tokio::time::sleep(POLL_DELAY).await;
            continue;
        };
        if !response.status().is_success() {
            return Err("job lease request was rejected".into());
        }
        let envelope: JobEnvelope = response.json().await.map_err(|_| "invalid job response")?;
        let Some(job) = envelope.job else {
            tokio::time::sleep(POLL_DELAY).await;
            continue;
        };
        if job.server_signing_key != store.server_signing_key
            || job.payload["type"] != "provider_job"
            || job.payload["schema_version"] != 1
            || job.payload.get("command").is_some()
            || job.payload.get("shell").is_some()
            || !job.payload["arguments"]
                .as_array()
                .is_some_and(|args| args.len() <= 128 && args.iter().all(Value::is_string))
        {
            return Err("unsupported or invalid signed provider job".into());
        }
        verify_signature(&job, &store.server_signing_key)?;
        let (result, failed) = if job.provider_mode == "scripted" {
            (
                execute_scripted_job(&job, &store.server_signing_key)?,
                false,
            )
        } else {
            let (provider, billing) = match job.provider_mode.as_str() {
                "codex_subscription" => (
                    provider::Provider::Codex,
                    provider::BillingMode::Subscription,
                ),
                "codex_api_key" => (provider::Provider::Codex, provider::BillingMode::ApiKey),
                "claude_subscription" => (
                    provider::Provider::ClaudeCode,
                    provider::BillingMode::Subscription,
                ),
                "claude_api_key" => (
                    provider::Provider::ClaudeCode,
                    provider::BillingMode::ApiKey,
                ),
                _ => return Err("unsupported provider mode".into()),
            };
            let directory = isolated_working_directory(job.id)?;
            let outcome = provider::run(
                provider,
                billing,
                job.payload["arguments"][0].as_str().unwrap_or_default(),
                None,
                &directory,
                Duration::from_secs(120),
            )
            .await;
            fs::remove_dir_all(directory).map_err(|_| "could not remove isolated directory")?;
            match outcome {
                Ok(value) => (
                    json!({"outcome":"completed","result":value.text,"usage":value.usage}),
                    false,
                ),
                Err(provider::AdapterError::RateLimited {
                    retry_after_seconds,
                }) => (
                    json!({"outcome":"rate_limited","retry_after_seconds":retry_after_seconds}),
                    false,
                ),
                Err(provider::AdapterError::NeedsLogin) => {
                    (json!({"outcome":"needs_login"}), false)
                }
                Err(provider::AdapterError::Unsupported(_)) => (
                    json!({"outcome":"failed","summary":"Provider mode is disabled until scoped tools are enforceable"}),
                    true,
                ),
                Err(provider::AdapterError::MalformedOutput) => (
                    json!({"outcome":"failed","summary":"Provider returned malformed structured output"}),
                    true,
                ),
                Err(provider::AdapterError::TimedOut) => (
                    json!({"outcome":"failed","summary":"Provider exceeded its time limit"}),
                    true,
                ),
                Err(provider::AdapterError::Failed) => (
                    json!({"outcome":"failed","summary":"Provider CLI failed"}),
                    true,
                ),
            }
        };
        let response = client
            .post(endpoint(
                &store.origin,
                &format!("/api/v1/ai/agent/jobs/{}/result", job.id),
            ))
            .bearer_auth(&store.token)
            .json(&json!({"result":result,"failed":failed}))
            .send()
            .await
            .map_err(|_| "could not report job result")?;
        if !response.status().is_success() {
            return Err(format!(
                "job result rejected with HTTP {}",
                response.status()
            ));
        }
    }
}

/// The scripted provider exercises the agent protocol without invoking a shell or host CLI.
/// Each job gets a fresh empty directory, and only typed string arguments are exposed to it.
fn execute_scripted_job(job: &Job, expected_public_key: &str) -> Result<Value, String> {
    if job.provider_mode != "scripted"
        || job.payload["type"] != "provider_job"
        || job.payload["schema_version"] != 1
        || job.payload.get("command").is_some()
        || job.payload.get("shell").is_some()
    {
        return Err("unsupported provider mode or job type".into());
    }
    if job.server_signing_key != expected_public_key {
        return Err("server signing key changed".into());
    }
    let args = job.payload["arguments"]
        .as_array()
        .ok_or("job arguments must be an array")?;
    if args.iter().any(|arg| !arg.is_string()) {
        return Err("job arguments must contain strings".into());
    }
    verify_signature(job, expected_public_key)?;
    let directory = isolated_working_directory(job.id)?;
    let result = json!({"provider":"scripted","working_directory_empty":fs::read_dir(&directory).map_err(|_| "isolated directory unavailable")?.next().is_none(),"arguments":args});
    fs::remove_dir_all(directory).map_err(|_| "could not remove isolated directory")?;
    Ok(result)
}

fn verify_signature(job: &Job, public_key: &str) -> Result<(), String> {
    let key = decode_hex(public_key)?;
    let signature_bytes = decode_hex(&job.signature)?;
    let body = format!(
        "weft-agent-job-v1\n{}\n{}\n{}\n{}",
        job.id, job.connection_id, job.provider_mode, job.payload
    );
    signature::UnparsedPublicKey::new(&signature::ED25519, &key)
        .verify(body.as_bytes(), &signature_bytes)
        .map_err(|_| "job signature is invalid".into())
}

fn isolated_working_directory(job: Uuid) -> Result<PathBuf, String> {
    let path = env::temp_dir().join(format!("weft-runner-{job}-{}", Uuid::new_v4()));
    fs::create_dir(&path).map_err(|_| "could not create isolated working directory")?;
    Ok(path)
}

fn store_path(root: &Path, scope: &str, runner: Uuid) -> PathBuf {
    root.join(scope)
        .join(runner.to_string())
        .join("runner-store.json")
}
fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid store path")?;
    fs::create_dir_all(parent).map_err(|_| "could not create runner store")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| "could not secure runner store directory")?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options
        .open(path)
        .and_then(|mut file| file.write_all(data))
        .map_err(|_| "could not securely create runner credential file")?;
    Ok(())
}
fn validate_origin(origin: &str) -> Result<(), String> {
    let url = Url::parse(origin).map_err(|_| "invalid Weft origin")?;
    let local_http = url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
    if (url.scheme() != "https" && !local_http)
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("origin must contain only one http(s) origin".into());
    }
    Ok(())
}
fn endpoint(origin: &str, path: &str) -> String {
    format!("{}{}", origin.trim_end_matches('/'), path)
}
fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "could not initialize HTTP client".into())
}
fn parse_options(args: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
    let mut result = std::collections::HashMap::new();
    let mut values = args.into_iter();
    while let Some(key) = values.next() {
        let key = key
            .strip_prefix("--")
            .ok_or("options must use --name value form")?
            .to_owned();
        let value = values.next().ok_or("option is missing its value")?;
        if result.insert(key, value).is_some() {
            return Err("duplicate option".into());
        }
    }
    Ok(result)
}
fn required<'a>(
    options: &'a std::collections::HashMap<String, String>,
    key: &str,
) -> Result<&'a str, String> {
    options
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| format!("missing --{key}"))
}
fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("invalid signature encoding".into());
    }
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let hi = (pair[0] as char)
                .to_digit(16)
                .ok_or("invalid signature encoding")?;
            let lo = (pair[1] as char)
                .to_digit(16)
                .ok_or("invalid signature encoding")?;
            Ok(((hi << 4) | lo) as u8)
        })
        .collect()
}
#[cfg(test)]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };
    #[test]
    fn personal_and_global_stores_have_distinct_auth_directories() {
        let root = Path::new("/var/lib/weft/runner-store");
        let id = Uuid::nil();
        assert_ne!(
            store_path(root, "personal", id),
            store_path(root, "global", id)
        );
    }
    #[test]
    fn origin_rejects_extra_paths_and_credentials() {
        assert!(validate_origin("https://weft.example").is_ok());
        assert!(validate_origin("https://user:secret@weft.example").is_err());
        assert!(validate_origin("https://weft.example/other").is_err());
    }
    #[test]
    fn unsupported_modes_and_non_array_arguments_are_rejected() {
        let job = Job {
            id: Uuid::nil(),
            connection_id: Uuid::nil(),
            provider_mode: "codex_subscription".into(),
            payload: json!({}),
            signature: String::new(),
            server_signing_key: String::new(),
        };
        assert!(execute_scripted_job(&job, "").is_err());
    }

    #[test]
    fn scripted_provider_runs_only_a_signed_typed_job_in_an_empty_directory() {
        let connection_id = Uuid::new_v4();
        let payload =
            json!({"type":"provider_job","schema_version":1,"arguments":["draft", "task"]});
        let id = Uuid::new_v4();
        let key_pair = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key_pair = Ed25519KeyPair::from_pkcs8(key_pair.as_ref()).unwrap();
        let body = format!("weft-agent-job-v1\n{id}\n{connection_id}\nscripted\n{payload}");
        let public_key = super::hex(key_pair.public_key().as_ref());
        let job = Job {
            id,
            connection_id,
            provider_mode: "scripted".into(),
            payload,
            signature: super::hex(key_pair.sign(body.as_bytes()).as_ref()),
            server_signing_key: public_key.clone(),
        };
        let result = execute_scripted_job(&job, &public_key).unwrap();
        assert_eq!(result["provider"], "scripted");
        assert_eq!(result["working_directory_empty"], true);
        assert_eq!(result["arguments"], json!(["draft", "task"]));
    }
}
