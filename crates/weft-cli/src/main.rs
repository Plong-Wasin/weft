use std::{env, net::SocketAddr, path::PathBuf};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use weft_server::{
    bootstrap_admin, connect, migrate, reset_password, serve, set_maintenance_mode, ServerConfig,
};

mod ops;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let mut args = env::args().skip(1);
    match args.next().as_deref().unwrap_or("serve") {
        "migrate" => migrate(&database_url()?).await?,
        "maintenance" => {
            let state = args.next().ok_or("usage: weft maintenance <on|off>")?;
            let enabled = match state.as_str() {
                "on" => true,
                "off" => false,
                _ => return Err("usage: weft maintenance <on|off>".into()),
            };
            let url = database_url()?;
            set_maintenance_mode(&url, enabled).await?;
        }
        "backup" => {
            let path = args.next().ok_or("usage: weft backup <archive.tar.gz>")?;
            ops::backup(&PathBuf::from(path)).await?;
        }
        "restore" => {
            let path = args.next().ok_or("usage: weft restore <archive.tar.gz>")?;
            ops::restore(&PathBuf::from(path)).await?;
        }
        "drill" => {
            let path = args.next().ok_or("usage: weft drill <archive.tar.gz>")?;
            ops::drill(&PathBuf::from(path)).await?;
        }
        "bootstrap-admin" => {
            let email = args
                .next()
                .ok_or("usage: weft bootstrap-admin <email> <password> [workspace-name]")?;
            let password = args
                .next()
                .ok_or("usage: weft bootstrap-admin <email> <password> [workspace-name]")?;
            let workspace = args.next().unwrap_or_else(|| "My Workspace".to_owned());
            let url = database_url()?;
            migrate(&url).await?;
            let pool = connect(&url).await?;
            bootstrap_admin(&pool, &email, &password, &workspace).await?;
        }
        "reset-password" => {
            let email = args
                .next()
                .ok_or("usage: weft reset-password <email> <password>")?;
            let password = args
                .next()
                .ok_or("usage: weft reset-password <email> <password>")?;
            let url = database_url()?;
            migrate(&url).await?;
            let pool = connect(&url).await?;
            reset_password(&pool, &email, &password).await?;
        }
        "serve" => {
            let address: SocketAddr = env::var("WEFT_LISTEN")
                .unwrap_or_else(|_| "0.0.0.0:8080".to_owned())
                .parse()?;
            let database_url = database_url()?;
            let web_root =
                PathBuf::from(env::var("WEFT_WEB_ROOT").unwrap_or_else(|_| "/app/web".to_owned()));
            let listener = TcpListener::bind(address).await?;
            serve(listener, ServerConfig::new(database_url, web_root)).await?;
        }
        command => {
            return Err(format!(
            "unknown command {command}; expected serve, migrate, bootstrap-admin, reset-password, maintenance, backup, restore or drill"
        )
            .into())
        }
    }
    Ok(())
}

fn database_url() -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be configured".into())
}
