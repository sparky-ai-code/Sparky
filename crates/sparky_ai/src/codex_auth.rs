use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";
const OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_ISSUER: &str = "https://auth.openai.com";
const OAUTH_PORTS: [u16; 2] = [1455, 1457];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexCredentials {
    pub access: String,
    pub refresh: String,
    pub expires: i64,
    pub account_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    pub authenticated: bool,
    pub account_id: Option<String>,
    pub expires: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ManagedCodexAuth {
    auth_mode: Option<String>,
    tokens: Option<ManagedCodexTokens>,
}

#[derive(Debug, Deserialize)]
struct ManagedCodexTokens {
    access_token: String,
    refresh_token: String,
    account_id: Option<String>,
}

fn home_dir() -> anyhow::Result<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Unable to resolve the user home directory"))
}

fn codex_home() -> anyhow::Result<PathBuf> {
    if let Some(path) = std::env::var_os("SPARKY_CODEX_HOME") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(path));
    }
    Ok(home_dir()?.join(".codex"))
}

pub fn codex_auth_path() -> anyhow::Result<PathBuf> {
    Ok(codex_home()?.join("auth.json"))
}

fn decode_jwt_payload(access: &str) -> anyhow::Result<Value> {
    let payload = access
        .split('.')
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("Invalid ChatGPT access token"))?;
    let decoded = URL_SAFE_NO_PAD.decode(payload)?;
    Ok(serde_json::from_slice(&decoded)?)
}

fn account_id(access: &str) -> anyhow::Result<String> {
    let value = decode_jwt_payload(access)?;
    value[JWT_CLAIM_PATH]["chatgpt_account_id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("ChatGPT account id is missing from the access token"))
}

fn expires_at(access: &str) -> anyhow::Result<i64> {
    let value = decode_jwt_payload(access)?;
    value["exp"]
        .as_i64()
        .map(|seconds| seconds.saturating_mul(1000))
        .ok_or_else(|| anyhow::anyhow!("ChatGPT access token expiry is missing"))
}

fn read_managed_credentials(path: &Path) -> anyhow::Result<CodexCredentials> {
    let data = std::fs::read(path)?;
    let auth: ManagedCodexAuth = serde_json::from_slice(&data)?;
    anyhow::ensure!(
        auth.auth_mode.as_deref() == Some("chatgpt"),
        "Codex is not signed in with ChatGPT"
    );
    let tokens = auth
        .tokens
        .ok_or_else(|| anyhow::anyhow!("Codex auth.json does not contain ChatGPT tokens"))?;
    anyhow::ensure!(
        !tokens.access_token.trim().is_empty() && !tokens.refresh_token.trim().is_empty(),
        "Codex auth.json contains incomplete ChatGPT credentials"
    );
    let account_id = tokens
        .account_id
        .filter(|value| !value.trim().is_empty())
        .or_else(|| account_id(&tokens.access_token).ok())
        .ok_or_else(|| anyhow::anyhow!("ChatGPT account id is missing"))?;
    Ok(CodexCredentials {
        expires: expires_at(&tokens.access_token)?,
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        account_id,
    })
}

async fn refresh_managed_auth() -> anyhow::Result<()> {
    let refresh_token = read_managed_credentials(&codex_auth_path()?)?.refresh;
    let response = Client::new()
        .post(format!("{OAUTH_ISSUER}/oauth/token"))
        .json(&json!({
            "client_id": OAUTH_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }))
        .send()
        .await?
        .error_for_status()
        .map_err(|error| anyhow::anyhow!("ChatGPT token refresh failed: {error}"))?;
    #[derive(Deserialize)]
    struct RefreshResponse {
        id_token: Option<String>,
        access_token: String,
        refresh_token: Option<String>,
    }
    let refreshed: RefreshResponse = response.json().await?;
    let RefreshResponse {
        id_token,
        access_token,
        refresh_token,
    } = refreshed;
    let path = codex_auth_path()?;
    let existing: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    let mut tokens = existing.get("tokens").cloned().unwrap_or_else(|| json!({}));
    tokens["access_token"] = Value::String(access_token);
    tokens["id_token"] = id_token
        .map(Value::String)
        .unwrap_or_else(|| tokens["access_token"].clone());
    if let Some(refresh_token) = refresh_token {
        tokens["refresh_token"] = Value::String(refresh_token);
    }
    let updated = json!({ "auth_mode": "chatgpt", "tokens": tokens });
    std::fs::write(path, serde_json::to_vec_pretty(&updated)?)?;
    Ok(())
}

fn build_oauth_authorize_url(redirect_uri: &str, state: &str, challenge: &str) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("response_type", "code");
    query.append_pair("client_id", OAUTH_CLIENT_ID);
    query.append_pair("redirect_uri", redirect_uri);
    query.append_pair(
        "scope",
        "openid profile email offline_access api.connectors.read api.connectors.invoke",
    );
    query.append_pair("code_challenge", challenge);
    query.append_pair("code_challenge_method", "S256");
    query.append_pair("id_token_add_organizations", "true");
    query.append_pair("codex_cli_simplified_flow", "true");
    query.append_pair("state", state);
    query.append_pair("originator", "sparky");
    format!("{OAUTH_ISSUER}/oauth/authorize?{}", query.finish())
}

async fn oauth_login() -> anyhow::Result<()> {
    let mut listener = None;
    for port in OAUTH_PORTS {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(value) => {
                listener = Some(value);
                break;
            }
            Err(_) => continue,
        }
    }
    let listener = listener
        .ok_or_else(|| anyhow::anyhow!("Unable to start the ChatGPT login callback server"))?;
    let port = listener.local_addr()?.port();

    let mut random = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random);
    let state = URL_SAFE_NO_PAD.encode(random);
    rand::thread_rng().fill_bytes(&mut random);
    let verifier = URL_SAFE_NO_PAD.encode(random);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let redirect_uri = format!("http://localhost:{port}/auth/callback");
    let auth_url = build_oauth_authorize_url(&redirect_uri, &state, &challenge);
    open_oauth_browser(&auth_url);

    let code = loop {
        let (mut stream, _) = listener.accept().await?;
        let mut request = vec![0u8; 8192];
        let size = stream.read(&mut request).await?;
        let request = String::from_utf8_lossy(&request[..size]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("GET "))
            .and_then(|line| line.split_whitespace().next())
            .ok_or_else(|| anyhow::anyhow!("Invalid OAuth callback request"))?;
        let parsed = url::Url::parse(&format!("http://localhost{target}"))?;
        if parsed.path() != "/auth/callback" {
            write_oauth_response(&mut stream, "Not Found", "404 Not Found").await?;
            continue;
        }
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        if params.get("state").map(String::as_str) != Some(state.as_str()) {
            write_oauth_response(&mut stream, "State mismatch", "400 Bad Request").await?;
            continue;
        }
        if let Some(error) = params.get("error") {
            let description = params
                .get("error_description")
                .map(String::as_str)
                .unwrap_or(error);
            write_oauth_response(&mut stream, "Sign-in was cancelled", "400 Bad Request").await?;
            anyhow::bail!("ChatGPT sign-in failed: {description}");
        }
        let code = params
            .get("code")
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!("ChatGPT sign-in did not return an authorization code")
            })?;
        write_oauth_response(
            &mut stream,
            "Sign-in complete. You can return to Sparky.",
            "200 OK",
        )
        .await?;
        break code;
    };

    #[derive(Deserialize)]
    struct TokenResponse {
        id_token: String,
        access_token: String,
        refresh_token: String,
    }
    let response = Client::new()
        .post(format!("{OAUTH_ISSUER}/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", OAUTH_CLIENT_ID),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await?
        .error_for_status()
        .map_err(|error| anyhow::anyhow!("ChatGPT token exchange failed: {error}"))?;
    let tokens: TokenResponse = response.json().await?;
    let account_id = account_id(&tokens.access_token)?;
    let path = codex_auth_path()?;
    let directory = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Invalid ChatGPT credentials path"))?;
    std::fs::create_dir_all(directory)?;
    let data = json!({
        "auth_mode": "chatgpt",
        "tokens": {
            "id_token": tokens.id_token,
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "account_id": account_id,
        }
    });
    std::fs::write(path, serde_json::to_vec_pretty(&data)?)?;
    Ok(())
}

async fn write_oauth_response(
    stream: &mut tokio::net::TcpStream,
    body: &str,
    status: &str,
) -> anyhow::Result<()> {
    let body = body.as_bytes();
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(body).await?;
    Ok(())
}

fn open_oauth_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = StdCommand::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = StdCommand::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = StdCommand::new("xdg-open").arg(url).spawn();
    }
}

pub async fn login_codex() -> anyhow::Result<CodexAuthStatus> {
    oauth_login().await?;
    let status = codex_auth_status();
    anyhow::ensure!(
        status.authenticated,
        "ChatGPT login finished without a usable session"
    );
    Ok(status)
}

pub fn codex_auth_status() -> CodexAuthStatus {
    let credentials = codex_auth_path()
        .ok()
        .and_then(|path| read_managed_credentials(&path).ok());
    CodexAuthStatus {
        authenticated: credentials.is_some(),
        account_id: credentials.as_ref().map(|value| value.account_id.clone()),
        expires: credentials.map(|value| value.expires),
    }
}

pub async fn logout_codex() -> anyhow::Result<CodexAuthStatus> {
    let path = codex_auth_path()?;
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(codex_auth_status())
}

pub async fn valid_codex_credentials() -> anyhow::Result<CodexCredentials> {
    let path = codex_auth_path()?;
    let mut credentials = read_managed_credentials(&path).map_err(|error| {
        anyhow::anyhow!("Sign in with ChatGPT from Sparky Models settings first ({error})")
    })?;
    if credentials.expires <= chrono::Utc::now().timestamp_millis() + 5 * 60 * 1000 {
        refresh_managed_auth().await.map_err(|error| {
            anyhow::anyhow!(
                "Your ChatGPT session could not be refreshed. Sign in again from Models settings ({error})"
            )
        })?;
        credentials = read_managed_credentials(&path)?;
    }
    Ok(credentials)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_managed_codex_auth_without_rewriting_it() {
        let access = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(
                json!({
                    "exp": 2_000_000_000,
                    JWT_CLAIM_PATH: { "chatgpt_account_id": "account-1" }
                })
                .to_string()
            )
        );
        let directory =
            std::env::temp_dir().join(format!("sparky-codex-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("auth.json");
        std::fs::write(
            &path,
            json!({
                "auth_mode": "chatgpt",
                "tokens": {
                    "access_token": access,
                    "refresh_token": "refresh",
                    "account_id": "account-1"
                }
            })
            .to_string(),
        )
        .unwrap();
        let credentials = read_managed_credentials(&path).unwrap();
        assert_eq!(credentials.account_id, "account-1");
        assert_eq!(credentials.expires, 2_000_000_000_000);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
