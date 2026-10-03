use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command as StdCommand;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const OAUTH_ISSUER: &str = "https://auth.openai.com";
const OAUTH_AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const OAUTH_DISCOVERY_URL: &str = "https://auth.openai.com/.well-known/openid-configuration";
const OAUTH_RESOURCE: &str = "https://api.openai.com/v1";
const OAUTH_DYNAMIC_CLIENT_ID: &str = "dynamic_agent_client";
const OAUTH_AGENT_NAME: &str = "Sparky";
const OAUTH_SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const OAUTH_CALLBACK_PORT: u16 = 1455;
const OAUTH_CALLBACK_PATH: &str = "/auth/callback";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexCredentials {
    #[serde(rename = "access_token")]
    pub access: String,
    #[serde(rename = "refresh_token")]
    pub refresh: String,
    pub expires: i64,
    pub subject: String,
    pub client_id: String,
    pub scope: String,
    pub resource: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    pub authenticated: bool,
    pub subject: Option<String>,
    pub expires: Option<i64>,
    pub plan_usage_authorized: bool,
}

#[derive(Debug, Deserialize)]
struct ManagedCodexAuth {
    auth_mode: Option<String>,
    tokens: Option<ManagedCodexTokens>,
}

#[derive(Debug, Deserialize)]
struct ManagedCodexTokens {
    access_token: String,
    refresh_token: Option<String>,
    subject: Option<String>,
    client_id: Option<String>,
    scope: Option<String>,
    resource: Option<String>,
    expires: Option<i64>,
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
    Ok(home_dir()?.join(".sparky").join("codex-auth"))
}

pub fn codex_auth_path() -> anyhow::Result<PathBuf> {
    Ok(codex_home()?.join("auth.json"))
}

fn has_chatgpt_plan_scope(scope: &str) -> bool {
    let scopes: std::collections::HashSet<_> = scope.split_whitespace().collect();
    ["offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]
        .iter()
        .all(|required| scopes.contains(required))
}

fn read_managed_credentials(path: &Path) -> anyhow::Result<CodexCredentials> {
    let data = std::fs::read(path)?;
    let auth: ManagedCodexAuth = serde_json::from_slice(&data)?;
    anyhow::ensure!(auth.auth_mode.as_deref() == Some("siwc"), "No Sign in with ChatGPT session found");
    let tokens = auth.tokens.ok_or_else(|| anyhow::anyhow!("Saved ChatGPT credentials are incomplete"))?;
    let scope = tokens.scope.unwrap_or_default();
    anyhow::ensure!(
        scope.split_whitespace().any(|granted| ["openid", "profile", "email"].contains(&granted)),
        "The saved ChatGPT sign-in did not include identity permission"
    );
    let client_id = tokens.client_id.filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("The saved ChatGPT client registration is missing"))?;
    let resource = tokens.resource.unwrap_or_else(|| OAUTH_RESOURCE.to_owned());
    anyhow::ensure!(resource == OAUTH_RESOURCE, "The saved ChatGPT credential has an unexpected resource");
    let expires = tokens.expires.ok_or_else(|| anyhow::anyhow!("The saved ChatGPT token expiry is missing"))?;
    let subject = tokens.subject.filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("The saved ChatGPT identity subject is missing"))?;
    anyhow::ensure!(!tokens.access_token.trim().is_empty(), "Saved ChatGPT credentials are incomplete");
    Ok(CodexCredentials {
        access: tokens.access_token,
        refresh: tokens.refresh_token.unwrap_or_default(),
        expires,
        subject,
        client_id,
        scope,
        resource,
    })
}

fn save_credentials(credentials: &CodexCredentials) -> anyhow::Result<()> {
    let path = codex_auth_path()?;
    let directory = path.parent().ok_or_else(|| anyhow::anyhow!("Invalid ChatGPT credentials path"))?;
    std::fs::create_dir_all(directory)?;
    let temporary_path = directory.join(format!(".siwc-{}.tmp", uuid::Uuid::new_v4()));
    let value = json!({
        "auth_mode": "siwc",
        "tokens": {
            "access_token": credentials.access,
            "refresh_token": credentials.refresh,
            "subject": credentials.subject,
            "client_id": credentials.client_id,
            "scope": credentials.scope,
            "resource": credentials.resource,
            "expires": credentials.expires,
        }
    });
    std::fs::write(&temporary_path, serde_json::to_vec_pretty(&value)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary_path, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temporary_path, &path)?;
    Ok(())
}

async fn refresh_managed_auth() -> anyhow::Result<()> {
    let mut credentials = read_managed_credentials(&codex_auth_path()?)?;
    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: u64,
        scope: Option<String>,
    }
    let response = Client::new()
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", credentials.client_id.as_str()),
            ("refresh_token", credentials.refresh.as_str()),
            ("resource", credentials.resource.as_str()),
        ])
        .send()
        .await?
        .error_for_status()
        .map_err(|error| anyhow::anyhow!("ChatGPT token refresh failed: {error}"))?;
    let refreshed: TokenResponse = response.json().await?;
    let granted_scope = refreshed
        .scope
        .filter(|scope| !scope.trim().is_empty())
        .unwrap_or_else(|| credentials.scope.clone());
    credentials.access = refreshed.access_token;
    if let Some(refresh_token) = refreshed.refresh_token {
        credentials.refresh = refresh_token;
    }
    credentials.expires = chrono::Utc::now()
        .timestamp_millis()
        .saturating_add((refreshed.expires_in.min(i64::MAX as u64) as i64).saturating_mul(1000));
    credentials.scope = granted_scope;
    save_credentials(&credentials)?;
    Ok(())
}

fn build_oauth_authorize_url(
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    challenge: &str,
    client_id: &str,
    is_new_registration: bool,
) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("response_type", "code");
    query.append_pair("client_id", client_id);
    query.append_pair("redirect_uri", redirect_uri);
    query.append_pair("scope", OAUTH_SCOPE);
    query.append_pair("resource", OAUTH_RESOURCE);
    query.append_pair("code_challenge", challenge);
    query.append_pair("code_challenge_method", "S256");
    query.append_pair("state", state);
    query.append_pair("nonce", nonce);
    if is_new_registration {
        query.append_pair("agent_name_hint", OAUTH_AGENT_NAME);
    }
    format!("{OAUTH_AUTHORIZE_URL}?{}", query.finish())
}

#[derive(Debug, Deserialize)]
struct IdTokenClaims {
    sub: String,
    nonce: String,
}

async fn validate_id_token(
    id_token: &str,
    client_id: &str,
    expected_nonce: &str,
) -> anyhow::Result<String> {
    use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};

    #[derive(Deserialize)]
    struct OpenIdConfiguration {
        issuer: String,
        jwks_uri: String,
    }
    let configuration: OpenIdConfiguration = Client::new()
        .get(OAUTH_DISCOVERY_URL)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    anyhow::ensure!(configuration.issuer == OAUTH_ISSUER, "OpenAI OIDC discovery returned an unexpected issuer");

    let header = decode_header(id_token)?;
    anyhow::ensure!(
        matches!(header.alg, Algorithm::RS256 | Algorithm::ES256),
        "OpenAI returned an unsupported ID-token signing algorithm"
    );
    let key_id = header.kid.ok_or_else(|| anyhow::anyhow!("OpenAI ID token has no signing key id"))?;
    let jwks: JwkSet = Client::new()
        .get(configuration.jwks_uri)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let jwk = jwks
        .keys
        .iter()
        .find(|key| key.common.key_id.as_deref() == Some(key_id.as_str()))
        .ok_or_else(|| anyhow::anyhow!("Could not find the OpenAI ID-token signing key"))?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[OAUTH_ISSUER]);
    validation.set_audience(&[client_id]);
    let claims = decode::<IdTokenClaims>(id_token, &DecodingKey::from_jwk(jwk)?, &validation)?.claims;
    anyhow::ensure!(claims.nonce == expected_nonce, "OpenAI ID-token nonce did not match the sign-in request");
    anyhow::ensure!(!claims.sub.trim().is_empty(), "OpenAI ID token did not identify an account");
    Ok(claims.sub)
}

async fn oauth_login() -> anyhow::Result<()> {
    let existing = codex_auth_path()
        .ok()
        .and_then(|path| read_managed_credentials(&path).ok());
    let callback_port = if existing.is_some() { 0 } else { OAUTH_CALLBACK_PORT };
    let listener = TcpListener::bind(("127.0.0.1", callback_port)).await
        .map_err(|error| anyhow::anyhow!("Could not open the Sign in with ChatGPT loopback callback: {error}"))?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}{OAUTH_CALLBACK_PATH}");
    let client_id = existing.as_ref().map(|credentials| credentials.client_id.clone())
        .unwrap_or_else(|| OAUTH_DYNAMIC_CLIENT_ID.to_owned());
    let is_new_registration = client_id == OAUTH_DYNAMIC_CLIENT_ID;

    let mut random = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random);
    let state = URL_SAFE_NO_PAD.encode(random);
    rand::thread_rng().fill_bytes(&mut random);
    let nonce = URL_SAFE_NO_PAD.encode(random);
    rand::thread_rng().fill_bytes(&mut random);
    let verifier = URL_SAFE_NO_PAD.encode(random);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let auth_url = build_oauth_authorize_url(&redirect_uri, &state, &nonce, &challenge, &client_id, is_new_registration);
    open_oauth_browser(&auth_url);

    let (code, issued_client_id, callback_scope) = loop {
        let (mut stream, _) = listener.accept().await?;
        let mut request = vec![0u8; 8192];
        let size = stream.read(&mut request).await?;
        let request = String::from_utf8_lossy(&request[..size]);
        let target = request.lines().next()
            .and_then(|line| line.strip_prefix("GET "))
            .and_then(|line| line.split_whitespace().next())
            .ok_or_else(|| anyhow::anyhow!("Invalid OAuth callback request"))?;
        let parsed = url::Url::parse(&format!("http://127.0.0.1{target}"))?;
        if parsed.path() != OAUTH_CALLBACK_PATH {
            write_oauth_response(&mut stream, "Not Found", "404 Not Found").await?;
            continue;
        }
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        if params.get("state").map(String::as_str) != Some(state.as_str()) {
            write_oauth_response(&mut stream, "Sign-in state did not match", "400 Bad Request").await?;
            continue;
        }
        if let Some(error) = params.get("error") {
            let description = params.get("error_description").map(String::as_str).unwrap_or(error);
            write_oauth_response(&mut stream, "Sign-in was cancelled", "400 Bad Request").await?;
            anyhow::bail!("ChatGPT sign-in failed: {description}");
        }
        let code = params.get("code").filter(|value| !value.is_empty()).cloned()
            .ok_or_else(|| anyhow::anyhow!("ChatGPT sign-in did not return an authorization code"))?;
        let returned_client_id = params.get("client_id").cloned().unwrap_or_else(|| client_id.clone());
        let scope = params.get("scope").cloned().unwrap_or_default();
        write_oauth_response(&mut stream, "Sign-in complete. You can return to Sparky.", "200 OK").await?;
        break (code, returned_client_id, scope);
    };

    anyhow::ensure!(!issued_client_id.trim().is_empty() && issued_client_id != OAUTH_DYNAMIC_CLIENT_ID,
        "OpenAI did not return the registered ChatGPT client id");
    #[derive(Deserialize)]
    struct TokenResponse {
        id_token: String,
        access_token: String,
        refresh_token: Option<String>,
        expires_in: u64,
        scope: Option<String>,
    }
    let response = Client::new().post(OAUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", issued_client_id.as_str()),
            ("code_verifier", verifier.as_str()),
            ("resource", OAUTH_RESOURCE),
        ])
        .send().await?.error_for_status()
        .map_err(|error| anyhow::anyhow!("ChatGPT token exchange failed: {error}"))?;
    let tokens: TokenResponse = response.json().await?;
    let subject = validate_id_token(&tokens.id_token, &issued_client_id, &nonce).await?;
    let granted_scope = tokens
        .scope
        .filter(|scope| !scope.trim().is_empty())
        .unwrap_or(callback_scope);
    anyhow::ensure!(
        granted_scope.split_whitespace().any(|granted| ["openid", "profile", "email"].contains(&granted)),
        "OpenAI sign-in did not grant an identity scope"
    );
    let credentials = CodexCredentials {
        access: tokens.access_token,
        refresh: tokens.refresh_token.unwrap_or_default(),
        expires: chrono::Utc::now().timestamp_millis()
            .saturating_add((tokens.expires_in.min(i64::MAX as u64) as i64).saturating_mul(1000)),
        subject,
        client_id: issued_client_id,
        scope: granted_scope,
        resource: OAUTH_RESOURCE.to_owned(),
    };
    save_credentials(&credentials)?;
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
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;

        #[link(name = "shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(
                window: *mut std::ffi::c_void,
                operation: *const u16,
                file: *const u16,
                parameters: *const u16,
                directory: *const u16,
                show_command: i32,
            ) -> *mut std::ffi::c_void;
        }

        let operation: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let url: Vec<u16> = OsStr::new(url).encode_wide().chain(Some(0)).collect();
        // Ask Windows to open this URL with its registered web browser directly,
        // without routing it through Explorer or a command shell that can parse `&`.
        let result = unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                operation.as_ptr(),
                url.as_ptr(),
                ptr::null(),
                ptr::null(),
                1,
            )
        };
        if (result as isize) <= 32 {
            eprintln!("Failed to open ChatGPT login in the default browser: {result:p}");
        }
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
        subject: credentials.as_ref().map(|value| value.subject.clone()),
        expires: credentials.as_ref().map(|value| value.expires),
        plan_usage_authorized: credentials.as_ref().is_some_and(|value| {
            has_chatgpt_plan_scope(&value.scope) && !value.refresh.trim().is_empty()
        }),
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
    anyhow::ensure!(
        has_chatgpt_plan_scope(&credentials.scope),
        "This ChatGPT account has signed in, but did not authorize ChatGPT plan usage. Enable plan usage from Models settings."
    );
    anyhow::ensure!(
        !credentials.refresh.trim().is_empty(),
        "The ChatGPT plan grant is missing offline access. Reauthorize ChatGPT plan usage from Models settings."
    );
    let now = chrono::Utc::now().timestamp_millis();
    let refresh_at = credentials.expires.saturating_sub(5 * 60 * 1000);
    if now >= refresh_at || credentials.expires <= now + 30_000 {
        refresh_managed_auth().await.map_err(|error| {
            anyhow::anyhow!(
                "Your ChatGPT session could not be refreshed. Sign in again from Models settings ({error})"
            )
        })?;
        credentials = read_managed_credentials(&path)?;
        anyhow::ensure!(
            has_chatgpt_plan_scope(&credentials.scope),
            "The refreshed ChatGPT session no longer permits plan usage. Reauthorize ChatGPT plan usage from Models settings."
        );
    }
    Ok(credentials)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_explicit_chatgpt_plan_usage_scopes() {
        assert!(has_chatgpt_plan_scope(
            "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
        ));
        assert!(!has_chatgpt_plan_scope("openid profile email"));
        assert!(!has_chatgpt_plan_scope("openid offline_access resource.invoke"));
    }

    #[test]
    fn builds_official_plan_usage_authorization_request() {
        let url = build_oauth_authorize_url(
            "http://127.0.0.1:1455/auth/callback",
            "state",
            "nonce",
            "challenge",
            OAUTH_DYNAMIC_CLIENT_ID,
            true,
        );
        let parsed = url::Url::parse(&url).unwrap();
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();

        assert_eq!(parsed.path(), "/api/accounts/authorize");
        assert_eq!(params.get("client_id").map(String::as_str), Some(OAUTH_DYNAMIC_CLIENT_ID));
        assert_eq!(params.get("redirect_uri").map(String::as_str), Some("http://127.0.0.1:1455/auth/callback"));
        assert_eq!(params.get("scope").map(String::as_str), Some(OAUTH_SCOPE));
        assert_eq!(params.get("resource").map(String::as_str), Some(OAUTH_RESOURCE));
        assert_eq!(params.get("code_challenge_method").map(String::as_str), Some("S256"));
        assert_eq!(params.get("state").map(String::as_str), Some("state"));
        assert_eq!(params.get("nonce").map(String::as_str), Some("nonce"));
        assert_eq!(params.get("agent_name_hint").map(String::as_str), Some(OAUTH_AGENT_NAME));
    }
}
