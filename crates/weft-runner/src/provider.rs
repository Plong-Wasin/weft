//! Provider CLI adapter boundary. Real provider modes remain gated until the runner can
//! provide Weft's scoped tools without exposing provider-local tools or host configuration.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{env, fs, path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    Codex,
    ClaudeCode,
}

impl Provider {
    fn mode(self, billing: BillingMode) -> &'static str {
        match (self, billing) {
            (Self::Codex, BillingMode::Subscription) => "codex_subscription",
            (Self::Codex, BillingMode::ApiKey) => "codex_api_key",
            (Self::ClaudeCode, BillingMode::Subscription) => "claude_subscription",
            (Self::ClaudeCode, BillingMode::ApiKey) => "claude_api_key",
        }
    }
}

/// Billing choices stay explicit. Credentials are supplied by the runner credential store,
/// never serialized into a job, prompt, result, or Weft connection record.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BillingMode {
    Subscription,
    ApiKey,
}

impl BillingMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Subscription => "subscription sign-in",
            Self::ApiKey => "API key billing",
        }
    }
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderResult {
    pub text: String,
    /// Provider-reported token counts only. `None` means usage is unknown.
    pub usage: Option<Usage>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum AdapterError {
    Unsupported(String),
    RateLimited { retry_after_seconds: u64 },
    NeedsLogin,
    MalformedOutput,
    TimedOut,
    Failed,
}

/// Narrow provider adapter contract. The production adapter guard intentionally rejects
/// every Codex and Claude mode until the supported-tool boundary has passed smoke checks.
pub async fn run(
    provider: Provider,
    billing: BillingMode,
    _prompt: &str,
    _model: Option<&str>,
    _work_dir: &Path,
    _timeout: Duration,
) -> Result<ProviderResult, AdapterError> {
    Err(AdapterError::Unsupported(format!(
        "{} ({}) is disabled until the scoped-tool runtime and smoke checklist are complete",
        provider.mode(billing),
        billing.label()
    )))
}

/// Execute a CLI with a fixed, non-interactive argument array. This lower-level seam is
/// used by the fake-binary contract tests and becomes reachable from `run` after gating is
/// lifted. The CLI inherits no ambient environment other than PATH and an isolated HOME.
#[allow(dead_code)] // Kept behind the support gate until a scoped Weft tool bridge exists.
async fn execute_cli(
    provider: Provider,
    binary: &Path,
    prompt: &str,
    model: Option<&str>,
    work_dir: &Path,
    deadline: Duration,
) -> Result<ProviderResult, AdapterError> {
    let home = env::temp_dir().join(format!("weft-provider-home-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&home).map_err(|_| AdapterError::Failed)?;
    let mut command = Command::new(binary);
    match provider {
        Provider::Codex => {
            command
                .arg("exec")
                .arg("--json")
                .arg("--sandbox")
                .arg("read-only")
                .arg("--ask-for-approval")
                .arg("never")
                .arg("-C")
                .arg(work_dir);
            if let Some(model) = model {
                command.arg("--model").arg(model);
            }
            command.arg("-");
        }
        Provider::ClaudeCode => {
            command
                .arg("-p")
                .arg("--output-format")
                .arg("json")
                .arg("--input-format")
                .arg("text")
                .arg("--tools")
                .arg("")
                .arg("--strict-mcp-config")
                .arg("--max-turns")
                .arg("1");
            if let Some(model) = model {
                command.arg("--model").arg(model);
            }
        }
    }
    command
        .current_dir(work_dir)
        .env_clear()
        .env("PATH", env::var_os("PATH").unwrap_or_default())
        .env("HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = async {
        let mut child = command.spawn().map_err(|_| AdapterError::Failed)?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|_| AdapterError::Failed)?;
        }
        match timeout(deadline, child.wait_with_output()).await {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(_)) => Err(AdapterError::Failed),
            Err(_) => Err(AdapterError::TimedOut),
        }
    }
    .await;
    let _ = fs::remove_dir_all(home);
    let output = output?;
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return Err(AdapterError::MalformedOutput);
    }
    if !output.status.success() {
        return Err(map_cli_error(&output.stdout, &output.stderr));
    }
    parse_output(provider, &output.stdout)
}

fn map_cli_error(stdout: &[u8], stderr: &[u8]) -> AdapterError {
    let text = format!(
        "{} {}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .to_ascii_lowercase();
    if text.contains("rate_limit") || text.contains("rate limit") || text.contains("429") {
        let retry = serde_json::from_slice::<Value>(stdout)
            .or_else(|_| serde_json::from_slice::<Value>(stderr))
            .ok()
            .and_then(|value| value.get("retry_after_seconds").and_then(Value::as_u64))
            .unwrap_or(30)
            .clamp(1, 900);
        AdapterError::RateLimited {
            retry_after_seconds: retry,
        }
    } else if text.contains("expired")
        || text.contains("unauthorized")
        || text.contains("not logged in")
        || text.contains("authentication required")
    {
        AdapterError::NeedsLogin
    } else {
        AdapterError::Failed
    }
}

fn parse_output(provider: Provider, bytes: &[u8]) -> Result<ProviderResult, AdapterError> {
    match provider {
        Provider::ClaudeCode => {
            let value: Value =
                serde_json::from_slice(bytes).map_err(|_| AdapterError::MalformedOutput)?;
            let text = value
                .get("result")
                .and_then(Value::as_str)
                .ok_or(AdapterError::MalformedOutput)?;
            Ok(ProviderResult {
                text: text.to_owned(),
                usage: usage(value.get("usage")),
            })
        }
        Provider::Codex => {
            let mut final_text = None;
            let mut reported_usage = None;
            for line in bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
            {
                let value: Value =
                    serde_json::from_slice(line).map_err(|_| AdapterError::MalformedOutput)?;
                if value.get("type").and_then(Value::as_str) == Some("turn.completed") {
                    if let Some(text) = value
                        .pointer("/item/content/0/text")
                        .and_then(Value::as_str)
                    {
                        final_text = Some(text.to_owned());
                    }
                    reported_usage = usage(value.get("usage"));
                }
                if let Some(text) = value.get("result").and_then(Value::as_str) {
                    final_text = Some(text.to_owned());
                    reported_usage = usage(value.get("usage"));
                }
            }
            Ok(ProviderResult {
                text: final_text.ok_or(AdapterError::MalformedOutput)?,
                usage: reported_usage,
            })
        }
    }
}

fn usage(value: Option<&Value>) -> Option<Usage> {
    let value = value?;
    let input = value.get("input_tokens").and_then(Value::as_u64);
    let output = value.get("output_tokens").and_then(Value::as_u64);
    (input.is_some() || output.is_some()).then_some(Usage {
        input_tokens: input,
        output_tokens: output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, path::PathBuf};
    use uuid::Uuid;

    struct FakeCli {
        root: PathBuf,
        binary: PathBuf,
    }

    impl FakeCli {
        fn new(script: &str) -> Self {
            let root = env::temp_dir().join(format!("weft-provider-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let binary = root.join("fake-cli");
            fs::write(&binary, format!("#!/bin/sh\n{script}\n")).unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
            Self { root, binary }
        }
    }

    impl Drop for FakeCli {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn workdir() -> PathBuf {
        let path = env::temp_dir().join(format!("weft-provider-job-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn claude_structured_output_preserves_unknown_usage() {
        let fake = FakeCli::new("cat >/dev/null; printf '%s' '{\"result\":\"draft\"}'");
        let dir = workdir();
        let result = execute_cli(
            Provider::ClaudeCode,
            &fake.binary,
            "job prompt",
            None,
            &dir,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "draft");
        assert!(result.usage.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn codex_structured_output_reads_reported_usage() {
        let fake = FakeCli::new("cat >/dev/null; printf '%s\\n' '{\"type\":\"turn.completed\",\"result\":\"ready\",\"usage\":{\"input_tokens\":12,\"output_tokens\":4}}'");
        let dir = workdir();
        let result = execute_cli(
            Provider::Codex,
            &fake.binary,
            "job prompt",
            Some("model-x"),
            &dir,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "ready");
        assert_eq!(result.usage.unwrap().input_tokens, Some(12));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn cli_receives_fixed_restricted_arguments_and_an_empty_working_directory() {
        let root = env::temp_dir().join(format!("weft-provider-argv-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let capture = root.join("argv.txt");
        let fake = FakeCli::new(&format!(
            "printf '%s\\n' \"$@\" > '{}'; test -z \"$(ls -A)\" || exit 12; cat >/dev/null; printf '%s' '{{\"result\":\"ok\"}}'",
            capture.display()
        ));
        let dir = workdir();
        let result = execute_cli(
            Provider::ClaudeCode,
            &fake.binary,
            "prompt",
            Some("model-a"),
            &dir,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        let args = fs::read_to_string(capture).unwrap();
        assert!(args.lines().any(|arg| arg == "-p"));
        assert!(args.lines().any(|arg| arg == "--output-format"));
        assert!(args.lines().any(|arg| arg == "json"));
        assert!(args.lines().any(|arg| arg == "--tools"));
        assert!(args.lines().any(|arg| arg == "--strict-mcp-config"));
        assert!(args.lines().any(|arg| arg == "model-a"));
        assert_eq!(result.text, "ok");
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cli_errors_map_rate_limit_login_malformed_and_timeout() {
        let dir = workdir();
        let limited = FakeCli::new("cat >/dev/null; printf '%s' '{\"retry_after_seconds\":9999,\"error\":\"rate_limit\"}' >&2; exit 1");
        assert_eq!(
            execute_cli(
                Provider::ClaudeCode,
                &limited.binary,
                "p",
                None,
                &dir,
                Duration::from_secs(2)
            )
            .await,
            Err(AdapterError::RateLimited {
                retry_after_seconds: 900
            })
        );
        let expired = FakeCli::new("cat >/dev/null; echo 'sign-in expired' >&2; exit 1");
        assert_eq!(
            execute_cli(
                Provider::Codex,
                &expired.binary,
                "p",
                None,
                &dir,
                Duration::from_secs(2)
            )
            .await,
            Err(AdapterError::NeedsLogin)
        );
        let malformed = FakeCli::new("cat >/dev/null; echo not-json");
        assert_eq!(
            execute_cli(
                Provider::ClaudeCode,
                &malformed.binary,
                "p",
                None,
                &dir,
                Duration::from_secs(2)
            )
            .await,
            Err(AdapterError::MalformedOutput)
        );
        let timeout_cli = FakeCli::new("cat >/dev/null; sleep 2; echo done");
        assert_eq!(
            execute_cli(
                Provider::ClaudeCode,
                &timeout_cli.binary,
                "p",
                None,
                &dir,
                Duration::from_millis(20)
            )
            .await,
            Err(AdapterError::TimedOut)
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn production_modes_are_disabled_until_runtime_smoke_checks_pass() {
        let dir = workdir();
        let result = run(
            Provider::Codex,
            BillingMode::Subscription,
            "p",
            None,
            &dir,
            Duration::from_secs(1),
        )
        .await;
        assert!(matches!(result, Err(AdapterError::Unsupported(_))));
        assert_eq!(BillingMode::Subscription.label(), "subscription sign-in");
        assert_eq!(BillingMode::ApiKey.label(), "API key billing");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn retry_delay_has_a_safe_default() {
        assert_eq!(
            map_cli_error(b"", b"HTTP 429 rate limit"),
            AdapterError::RateLimited {
                retry_after_seconds: 30
            }
        );
    }
}
