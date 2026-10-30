//! Minimal SMTP submission client: EHLO, optional STARTTLS or implicit TLS, AUTH PLAIN and one
//! message. Errors carry the server's reply and never the configured credentials.

use std::{sync::Arc, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine};
use rustls::pki_types::ServerName;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::TlsConnector;

const STEP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Security {
    None,
    StartTls,
    Tls,
}

impl Security {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "starttls" => Some(Self::StartTls),
            "tls" => Some(Self::Tls),
            _ => None,
        }
    }
}

pub(crate) struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: String,
    pub password: Option<String>,
    pub from: String,
}

pub(crate) struct Message<'a> {
    pub to: &'a str,
    pub subject: &'a str,
    pub body: &'a str,
    pub date: &'a str,
    pub message_id: &'a str,
}

trait Wire: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Wire for T {}

type Conn = BufReader<Box<dyn Wire>>;

pub(crate) async fn send(config: &SmtpConfig, message: &Message<'_>) -> Result<(), String> {
    run(config, message).await.map_err(|error| {
        let mut error = error.replace(['\r', '\n'], " ");
        if let Some(password) = config.password.as_deref().filter(|p| !p.is_empty()) {
            error = error.replace(password, "***");
        }
        error.chars().take(300).collect()
    })
}

async fn run(config: &SmtpConfig, message: &Message<'_>) -> Result<(), String> {
    let tcp = step(
        "connect",
        TcpStream::connect((config.host.as_str(), config.port)),
    )
    .await?
    .map_err(|e| format!("connection failed: {e}"))?;
    let mut conn: Conn = if config.security == Security::Tls {
        BufReader::new(upgrade(tcp, &config.host).await?)
    } else {
        BufReader::new(Box::new(tcp))
    };
    expect(&mut conn, "220").await?;
    command(&mut conn, "EHLO weft", "250").await?;
    if config.security == Security::StartTls {
        command(&mut conn, "STARTTLS", "220").await?;
        let tcp = conn.into_inner();
        conn = BufReader::new(upgrade(tcp, &config.host).await?);
        command(&mut conn, "EHLO weft", "250").await?;
    }
    if let Some(password) = config
        .password
        .as_deref()
        .filter(|_| !config.username.is_empty())
    {
        let token = STANDARD.encode(format!("\0{}\0{}", config.username, password));
        command(&mut conn, &format!("AUTH PLAIN {token}"), "235").await?;
    }
    command(&mut conn, &format!("MAIL FROM:<{}>", config.from), "250").await?;
    command(&mut conn, &format!("RCPT TO:<{}>", message.to), "250").await?;
    command(&mut conn, "DATA", "354").await?;
    let data = render(config, message);
    step("data", conn.write_all(data.as_bytes()))
        .await?
        .map_err(|e| e.to_string())?;
    expect(&mut conn, "250").await?;
    let _ = conn.write_all(b"QUIT\r\n").await;
    Ok(())
}

async fn upgrade(
    stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    host: &str,
) -> Result<Box<dyn Wire>, String> {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let name =
        ServerName::try_from(host.to_owned()).map_err(|_| "invalid TLS server name".to_owned())?;
    let stream = step(
        "tls",
        TlsConnector::from(Arc::new(tls)).connect(name, stream),
    )
    .await?
    .map_err(|e| format!("TLS handshake failed: {e}"))?;
    Ok(Box::new(stream))
}

async fn step<T>(what: &str, future: impl std::future::Future<Output = T>) -> Result<T, String> {
    timeout(STEP_TIMEOUT, future)
        .await
        .map_err(|_| format!("timed out during {what}"))
}

async fn command(conn: &mut Conn, line: &str, expected: &str) -> Result<(), String> {
    step("write", conn.write_all(format!("{line}\r\n").as_bytes()))
        .await?
        .map_err(|e| e.to_string())?;
    expect(conn, expected).await
}

/// Reads one (possibly multi-line) reply and checks its code.
async fn expect(conn: &mut Conn, code: &str) -> Result<(), String> {
    loop {
        let mut line = String::new();
        let read = step("read", conn.read_line(&mut line))
            .await?
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("connection closed by server".into());
        }
        let line = line.trim_end();
        if line.len() > 3 && line.as_bytes()[3] == b'-' {
            continue;
        }
        return if line.starts_with(code) {
            Ok(())
        } else {
            Err(format!("server replied: {line}"))
        };
    }
}

fn header_text(value: &str) -> String {
    let clean: String = value
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n'))
        .collect();
    if clean.is_ascii() {
        clean
    } else {
        format!("=?UTF-8?B?{}?=", STANDARD.encode(clean))
    }
}

fn render(config: &SmtpConfig, message: &Message<'_>) -> String {
    let mut out = format!(
        "From: <{}>\r\nTo: <{}>\r\nSubject: {}\r\nDate: {}\r\nMessage-ID: <{}>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
        config.from,
        message.to,
        header_text(message.subject),
        message.date,
        message.message_id,
    );
    let encoded = STANDARD.encode(message.body);
    for chunk in encoded.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push_str("\r\n");
    }
    out.push_str(".\r\n");
    out
}
