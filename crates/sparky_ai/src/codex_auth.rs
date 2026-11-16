use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command as StdCommand;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// Legacy OpenAI Codex subscription OAuth, following Pi's openai-codex provider.
// This is deliberately NOT the dynamic-client Sign in with ChatGPT API flow.
const OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const OAUTH_SCOPE: &str = "openid profile email offline_access";
const OAUTH_CALLBACK_PORT: u16 = 1455;
const OAUTH_CALLBACK_PATH: &str = "/auth/callback";
const OAUTH_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const OAUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const OAUTH_CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(10);
const OAUTH_CONNECT_TIMEOUT: Duration = Duration::from_secs(90);
const OAUTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(240);
const OAUTH_TOKEN_MAX_ATTEMPTS: usize = 3;
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn oauth_http_client() -> anyhow::Result<Client> {
    Ok(Client::builder()
        .connect_timeout(OAUTH_CONNECT_TIMEOUT)
        .timeout(OAUTH_REQUEST_TIMEOUT)
        .build()?)
}

/// OAuth codes are one-use credentials. Retry transient transport/server
/// failures and rate limits, but never retry an explicit grant rejection.
async fn send_oauth_token_request(
    client: &Client,
    token_url: &str,
    form: &[(&str, &str)],
    operation: &str,
) -> anyhow::Result<reqwest::Response> {
    for attempt in 0..OAUTH_TOKEN_MAX_ATTEMPTS {
        match client.post(token_url).form(form).send().await {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let status = response.status();
                let transient = status == reqwest::StatusCode::REQUEST_TIMEOUT
                    || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || status.is_server_error();
                if transient && attempt + 1 < OAUTH_TOKEN_MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                    continue;
                }
                if status == reqwest::StatusCode::BAD_REQUEST {
                    let problem = response.json::<serde_json::Value>().await.unwrap_or_default();
                    if problem.get("error").and_then(serde_json::Value::as_str) == Some("invalid_grant") {
                        anyhow::bail!(
                            "{operation} failed: OpenAI rejected an expired, invalid, or already used OAuth grant (HTTP 400). Start ChatGPT sign-in again."
                        );
                    }
                }
                anyhow::bail!("{operation} failed: OpenAI returned HTTP {status}.");
            }
            Err(error) if (error.is_connect() || error.is_timeout())
                && attempt + 1 < OAUTH_TOKEN_MAX_ATTEMPTS =>
            {
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
            }
            Err(error) => anyhow::bail!("{operation} failed: {error}"),
        }
    }
    unreachable!("the final OAuth attempt always returns or errors")
}


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
    pub subject: Option<String>,
    pub expires: Option<i64>,
    // Retained as a wire-compatible field for the desktop settings UI.
    pub plan_usage_authorized: bool,
}

#[derive(Deserialize)]
struct StoredAuth {
    auth_mode: Option<String>,
    tokens: Option<StoredTokens>,
}

#[derive(Deserialize)]
struct StoredTokens {
    access_token: String,
    refresh_token: String,
    expires: i64,
    account_id: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
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

// The access token was obtained from the OpenAI token endpoint with PKCE.
// Its account claim is needed by the ChatGPT Codex backend request header.
// We do not use an unverified JWT to grant local privileges.
fn account_id_from_access_token(access_token: &str) -> anyhow::Result<String> {
    let parts: Vec<_> = access_token.split('.').collect();
    anyhow::ensure!(parts.len() == 3, "OpenAI Codex access token is not a JWT");
    let payload = URL_SAFE_NO_PAD.decode(parts[1])
        .map_err(|_| anyhow::anyhow!("OpenAI Codex access token has an invalid payload"))?;
    let claims: serde_json::Value = serde_json::from_slice(&payload)?;
    let account_id = claims["https://api.openai.com/auth"]["chatgpt_account_id"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("OpenAI Codex token has no ChatGPT account ID"))?;
    Ok(account_id.to_owned())
}

fn credentials_from_token(response: TokenResponse) -> anyhow::Result<CodexCredentials> {
    anyhow::ensure!(!response.access_token.trim().is_empty(), "OpenAI Codex token response has no access token");
    anyhow::ensure!(!response.refresh_token.trim().is_empty(), "OpenAI Codex token response has no refresh token");
    anyhow::ensure!(response.expires_in > 0, "OpenAI Codex token response has an invalid expiry");
    let account_id = account_id_from_access_token(&response.access_token)?;
    Ok(CodexCredentials {
        access: response.access_token,
        refresh: response.refresh_token,
        expires: chrono::Utc::now().timestamp_millis()
            .saturating_add((response.expires_in.min(i64::MAX as u64 / 1000) as i64).saturating_mul(1000)),
        account_id,
    })
}

fn read_managed_credentials(path: &Path) -> anyhow::Result<CodexCredentials> {
    let auth: StoredAuth = serde_json::from_slice(&std::fs::read(path)?)?;
    anyhow::ensure!(
        auth.auth_mode.as_deref() == Some("codex_legacy"),
        "The previous ChatGPT sign-in uses a different provider. Reconnect using OpenAI Codex."
    );
    let tokens = auth.tokens.ok_or_else(|| anyhow::anyhow!("Saved OpenAI Codex credentials are incomplete"))?;
    anyhow::ensure!(
        !tokens.refresh_token.trim().is_empty() && !tokens.access_token.trim().is_empty(),
        "Saved OpenAI Codex credentials are incomplete"
    );
    let account_id = account_id_from_access_token(&tokens.access_token)?;
    anyhow::ensure!(account_id == tokens.account_id, "Saved OpenAI Codex account ID does not match its token");
    Ok(CodexCredentials {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: tokens.expires,
        account_id,
    })
}

fn save_credentials(credentials: &CodexCredentials) -> anyhow::Result<()> {
    let path = codex_auth_path()?;
    let directory = path.parent().ok_or_else(|| anyhow::anyhow!("Invalid OpenAI Codex credential path"))?;
    std::fs::create_dir_all(directory)?;
    let temporary_path = directory.join(format!(".codex-{}.tmp", uuid::Uuid::new_v4()));
    let value = json!({
        "auth_mode": "codex_legacy",
        "tokens": {
            "access_token": credentials.access,
            "refresh_token": credentials.refresh,
            "account_id": credentials.account_id,
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

async fn exchange_or_refresh(form: &[(&str, &str)], operation: &str) -> anyhow::Result<CodexCredentials> {
    let client = oauth_http_client()?;
    let response = send_oauth_token_request(&client, OAUTH_TOKEN_URL, form, operation).await?;
    let token: TokenResponse = response.json().await?;
    credentials_from_token(token)
}

async fn refresh_managed_auth(credentials: &CodexCredentials) -> anyhow::Result<CodexCredentials> {
    let refreshed = exchange_or_refresh(
        &[
            ("grant_type", "refresh_token"),
            ("client_id", OAUTH_CLIENT_ID),
            ("refresh_token", credentials.refresh.as_str()),
        ],
        "OpenAI Codex token refresh",
    ).await?;
    anyhow::ensure!(
        refreshed.account_id == credentials.account_id,
        "OpenAI Codex refreshed an unexpected ChatGPT account; reconnect your account"
    );
    save_credentials(&refreshed)?;
    Ok(refreshed)
}

fn build_oauth_authorize_url(state: &str, challenge: &str) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("response_type", "code");
    query.append_pair("client_id", OAUTH_CLIENT_ID);
    query.append_pair("redirect_uri", OAUTH_REDIRECT_URI);
    query.append_pair("scope", OAUTH_SCOPE);
    query.append_pair("code_challenge", challenge);
    query.append_pair("code_challenge_method", "S256");
    query.append_pair("state", state);
    query.append_pair("id_token_add_organizations", "true");
    query.append_pair("codex_cli_simplified_flow", "true");
    query.append_pair("originator", "sparky");
    format!("{OAUTH_AUTHORIZE_URL}?{}", query.finish())
}

// Browsers may resolve "localhost" to either loopback family. Listening only
// on 127.0.0.1 can strand the OAuth redirect on ::1 after account selection.
async fn bind_oauth_callback_listeners(
    port: u16,
) -> anyhow::Result<(Option<TcpListener>, Option<TcpListener>)> {
    let (ipv4, ipv6) = tokio::join!(
        TcpListener::bind(("127.0.0.1", port)),
        TcpListener::bind(("::1", port)),
    );
    if ipv4.is_err() && ipv6.is_err() {
        anyhow::bail!(
            "Could not start ChatGPT sign-in on localhost port {port} (IPv4: {}; IPv6: {}). Close any other Codex login and retry.",
            ipv4.unwrap_err(),
            ipv6.unwrap_err(),
        );
    }
    Ok((ipv4.ok(), ipv6.ok()))
}

async fn accept_oauth_connection(
    ipv4: Option<&TcpListener>,
    ipv6: Option<&TcpListener>,
) -> std::io::Result<(TcpStream, std::net::SocketAddr)> {
    match (ipv4, ipv6) {
        (Some(ipv4), Some(ipv6)) => {
            tokio::select! {
                connection = ipv4.accept() => connection,
                connection = ipv6.accept() => connection,
            }
        }
        (Some(ipv4), None) => ipv4.accept().await,
        (None, Some(ipv6)) => ipv6.accept().await,
        (None, None) => unreachable!("OAuth callback requires at least one listener"),
    }
}

// Read a complete HTTP request line, not the first arbitrary TCP packet.
// A split request could otherwise be discarded after the browser redirects.
async fn read_oauth_request_line(stream: &mut TcpStream) -> anyhow::Result<String> {
    let mut request = [0u8; 8192];
    let mut size = 0;
    loop {
        let read = tokio::time::timeout(
            OAUTH_CALLBACK_READ_TIMEOUT,
            stream.read(&mut request[size..]),
        )
        .await
        .map_err(|_| anyhow::anyhow!("ChatGPT callback request timed out"))??;
        if read == 0 {
            anyhow::bail!("ChatGPT callback connection closed before the request line");
        }
        size += read;
        if let Some(newline) = request[..size].iter().position(|byte| *byte == b'\n') {
            return Ok(String::from_utf8_lossy(&request[..newline])
                .trim_end_matches('\r')
                .to_string());
        }
        if size == request.len() {
            anyhow::bail!("ChatGPT callback request line is too long");
        }
    }
}

async fn wait_for_oauth_callback(
    ipv4: Option<&TcpListener>,
    ipv6: Option<&TcpListener>,
    expected_state: &str,
    deadline: Duration,
) -> anyhow::Result<(String, TcpStream)> {
    let started = tokio::time::Instant::now();
    loop {
        let remaining = deadline.checked_sub(started.elapsed())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| anyhow::anyhow!("ChatGPT sign-in timed out. Start sign-in again."))?;
        let (mut stream, _) = tokio::time::timeout(
            remaining,
            accept_oauth_connection(ipv4, ipv6),
        )
        .await
        .map_err(|_| anyhow::anyhow!("ChatGPT sign-in timed out. Start sign-in again."))??;

        // An unrelated connection (including a browser preconnect) should not
        // terminate the sign-in, but neither may it block the listener forever.
        let Ok(request_line) = read_oauth_request_line(&mut stream).await else {
            continue;
        };
        let Some(target) = request_line.strip_prefix("GET ")
            .and_then(|line| line.split_whitespace().next()) else {
            let _ = write_oauth_response(&mut stream, "Invalid callback request", "400 Bad Request").await;
            continue;
        };
        let Ok(parsed) = url::Url::parse(&format!("http://localhost{target}")) else {
            let _ = write_oauth_response(&mut stream, "Invalid callback URL", "400 Bad Request").await;
            continue;
        };
        if parsed.path() != OAUTH_CALLBACK_PATH {
            let _ = write_oauth_response(&mut stream, "Not Found", "404 Not Found").await;
            continue;
        }
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        if params.get("state").map(String::as_str) != Some(expected_state) {
            let _ = write_oauth_response(&mut stream, "ChatGPT sign-in state did not match; retry sign-in.", "400 Bad Request").await;
            anyhow::bail!("ChatGPT sign-in state did not match. Start sign-in again.");
        }
        if let Some(error) = params.get("error") {
            let _ = write_oauth_response(&mut stream, "ChatGPT sign-in was not completed.", "400 Bad Request").await;
            anyhow::bail!("ChatGPT sign-in failed: {error}");
        }
        let Some(code) = params.get("code").filter(|value| !value.is_empty()) else {
            let _ = write_oauth_response(&mut stream, "No authorization code returned", "400 Bad Request").await;
            anyhow::bail!("ChatGPT did not return an authorization code. Start sign-in again.");
        };
        return Ok((code.to_owned(), stream));
    }
}

async fn oauth_login() -> anyhow::Result<()> {
    // The registered OAuth redirect is localhost:1455; accept IPv4 and IPv6.
    let (ipv4, ipv6) = bind_oauth_callback_listeners(OAUTH_CALLBACK_PORT).await?;
    let mut random = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random);
    let state = URL_SAFE_NO_PAD.encode(&random[..16]);
    rand::thread_rng().fill_bytes(&mut random);
    let verifier = URL_SAFE_NO_PAD.encode(random);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    open_oauth_browser(&build_oauth_authorize_url(&state, &challenge));

    let (code, mut callback) = wait_for_oauth_callback(
        ipv4.as_ref(),
        ipv6.as_ref(),
        &state,
        OAUTH_CALLBACK_TIMEOUT,
    ).await?;
    drop((ipv4, ipv6));

    // Confirm success only after the token exchange and credential write have
    // succeeded. Previously the browser was told "authorized" prematurely.
    let result = async {
        let credentials = exchange_or_refresh(
            &[
                ("grant_type", "authorization_code"),
                ("client_id", OAUTH_CLIENT_ID),
                ("code", code.as_str()),
                ("code_verifier", verifier.as_str()),
                ("redirect_uri", OAUTH_REDIRECT_URI),
            ],
            "OpenAI Codex token exchange",
        ).await?;
        save_credentials(&credentials)
    }.await;
    match result {
        Ok(()) => {
            let _ = write_oauth_response(
                &mut callback,
                "ChatGPT login complete. You can return to Sparky.",
                "200 OK",
            ).await;
            Ok(())
        }
        Err(error) => {
            let _ = write_oauth_response(
                &mut callback,
                "ChatGPT login could not finish. Return to Sparky and retry.",
                "502 Bad Gateway",
            ).await;
            Err(error)
        }
    }
}

async fn write_oauth_response(
    stream: &mut tokio::net::TcpStream,
    body: &str,
    status: &str,
) -> anyhow::Result<()> {
    let body = body.as_bytes();
    stream.write_all(
        format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()
    ).await?;
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
    anyhow::ensure!(status.authenticated, "OpenAI Codex login finished without a usable session");
    Ok(status)
}

pub fn codex_auth_status() -> CodexAuthStatus {
    let credentials = codex_auth_path().ok()
        .and_then(|path| read_managed_credentials(&path).ok());
    CodexAuthStatus {
        authenticated: credentials.is_some(),
        subject: credentials.as_ref().map(|value| value.account_id.clone()),
        expires: credentials.as_ref().map(|value| value.expires),
        plan_usage_authorized: credentials.is_some(),
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

fn needs_refresh(credentials: &CodexCredentials) -> bool {
    chrono::Utc::now().timestamp_millis() >= credentials.expires.saturating_sub(5 * 60 * 1000)
}

pub async fn valid_codex_credentials() -> anyhow::Result<CodexCredentials> {
    let path = codex_auth_path()?;
    let credentials = read_managed_credentials(&path).map_err(|error| {
        anyhow::anyhow!("Connect OpenAI Codex from Sparky Models settings first ({error})")
    })?;
    if !needs_refresh(&credentials) {
        return Ok(credentials);
    }
    // Refresh tokens rotate; simultaneous threads must not refresh the same token.
    let _lock = REFRESH_LOCK.lock().await;
    let latest = read_managed_credentials(&path)?;
    if !needs_refresh(&latest) {
        return Ok(latest);
    }
    refresh_managed_auth(&latest).await.map_err(|error| {
        anyhow::anyhow!("OpenAI Codex session refresh failed. Reconnect from Models settings ({error})")
    })
}

pub async fn refresh_codex_after_unauthorized(observed_access: &str) -> anyhow::Result<CodexCredentials> {
    let _lock = REFRESH_LOCK.lock().await;
    let credentials = read_managed_credentials(&codex_auth_path()?)?;
    // A sibling thread may already have rotated the token.
    if credentials.access != observed_access {
        return Ok(credentials);
    }
    refresh_managed_auth(&credentials).await
}

pub async fn codex_usage() -> anyhow::Result<serde_json::Value> {
    let credentials = valid_codex_credentials().await?;
    let response = oauth_http_client()?
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(&credentials.access)
        .header("chatgpt-account-id", &credentials.account_id)
        .header(reqwest::header::ACCEPT, "application/json")
        .send().await?
        .error_for_status()
        .map_err(|error| anyhow::anyhow!("ChatGPT Codex subscription usage request failed: {error}"))?;
    let usage: serde_json::Value = response.json().await?;
    anyhow::ensure!(usage.is_object(), "ChatGPT returned an invalid subscription usage response");
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn token_test_server(replies: Vec<(&'static str, &'static str, Duration)>)
        -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            for (status, body, delay) in replies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 4096];
                assert!(stream.read(&mut request).await.unwrap() > 0);
                tokio::time::sleep(delay).await;
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (url, task)
    }

    fn mock_access_token(account_id: &str) -> String {
        let claims = json!({"https://api.openai.com/auth": {"chatgpt_account_id": account_id}});
        format!("e30.{}.signature", URL_SAFE_NO_PAD.encode(claims.to_string()))
    }

    #[test]
    fn builds_pi_legacy_codex_authorization_request() {
        let url = url::Url::parse(&build_oauth_authorize_url("state123", "challenge123")).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(query.get("client_id").map(String::as_str), Some(OAUTH_CLIENT_ID));
        assert_eq!(query.get("redirect_uri").map(String::as_str), Some(OAUTH_REDIRECT_URI));
        assert_eq!(query.get("scope").map(String::as_str), Some("openid profile email offline_access"));
        assert_eq!(query.get("codex_cli_simplified_flow").map(String::as_str), Some("true"));
        assert_eq!(query.get("id_token_add_organizations").map(String::as_str), Some("true"));
        assert_eq!(query.get("code_challenge_method").map(String::as_str), Some("S256"));
        assert_eq!(query.get("state").map(String::as_str), Some("state123"));
        assert!(query.get("resource").is_none());
        assert!(query.get("nonce").is_none());
    }

    #[test]
    fn extracts_account_id_and_rejects_missing_or_invalid_claims() {
        assert_eq!(account_id_from_access_token(&mock_access_token("acct_42")).unwrap(), "acct_42");
        assert!(account_id_from_access_token("not-a-jwt").is_err());
        assert!(account_id_from_access_token(&mock_access_token("")).is_err());
    }

    #[test]
    fn rejects_incomplete_token_exchange() {
        assert!(credentials_from_token(TokenResponse {
            access_token: mock_access_token("acct_1"),
            refresh_token: String::new(),
            expires_in: 3600,
        }).is_err());
        let credential = credentials_from_token(TokenResponse {
            access_token: mock_access_token("acct_1"),
            refresh_token: "refresh".into(),
            expires_in: 3600,
        }).unwrap();
        assert_eq!(credential.account_id, "acct_1");
        assert!(credential.expires > chrono::Utc::now().timestamp_millis());
    }

    #[tokio::test]
    async fn callback_delivers_code_over_ipv4_and_handles_split_request_line() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (code, mut stream) = wait_for_oauth_callback(
                Some(&listener), None, "state-123", Duration::from_secs(3),
            ).await.unwrap();
            write_oauth_response(&mut stream, "signed in", "200 OK").await.unwrap();
            code
        });
        let mut browser = TcpStream::connect(address).await.unwrap();
        browser.write_all(b"GET /auth/call").await.unwrap();
        browser.write_all(b"back?code=oauth-code&state=state-123 HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await.unwrap();
        let mut response = String::new();
        browser.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(task.await.unwrap(), "oauth-code");
    }

    #[tokio::test]
    async fn callback_delivers_code_over_ipv6_when_available() {
        let Ok(listener) = TcpListener::bind(("::1", 0)).await else {
            // Some CI hosts disable IPv6 entirely; IPv4 remains supported.
            return;
        };
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (code, mut stream) = wait_for_oauth_callback(
                None, Some(&listener), "ipv6-state", Duration::from_secs(3),
            ).await.unwrap();
            write_oauth_response(&mut stream, "signed in", "200 OK").await.unwrap();
            code
        });
        let mut browser = TcpStream::connect(address).await.unwrap();
        browser.write_all(b"GET /auth/callback?code=ipv6-code&state=ipv6-state HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await.unwrap();
        let mut response = String::new();
        browser.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(task.await.unwrap(), "ipv6-code");
    }

    #[tokio::test]
    async fn callback_rejects_wrong_state_and_ends_login_instead_of_hanging() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            wait_for_oauth_callback(
                Some(&listener), None, "expected", Duration::from_secs(3),
            ).await.unwrap_err().to_string()
        });
        let mut browser = TcpStream::connect(address).await.unwrap();
        browser.write_all(b"GET /auth/callback?code=code&state=other HTTP/1.1\r\n\r\n")
            .await.unwrap();
        let mut response = String::new();
        browser.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
        assert!(task.await.unwrap().contains("state did not match"));
    }

    #[tokio::test]
    async fn callback_reports_account_denial_without_waiting_for_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            wait_for_oauth_callback(
                Some(&listener), None, "expected", Duration::from_secs(3),
            ).await.unwrap_err().to_string()
        });
        let mut browser = TcpStream::connect(address).await.unwrap();
        browser.write_all(b"GET /auth/callback?error=access_denied&state=expected HTTP/1.1\r\n\r\n")
            .await.unwrap();
        let mut response = String::new();
        browser.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
        assert!(task.await.unwrap().contains("access_denied"));
    }

    #[tokio::test]
    async fn retries_transient_token_exchange_failure() {
        let (url, server) = token_test_server(vec![
            ("503 Service Unavailable", r#"{"error":"temporarily_unavailable"}"#, Duration::ZERO),
            ("200 OK", r#"{"access_token":"ok"}"#, Duration::from_millis(100)),
        ]).await;
        let response = send_oauth_token_request(
            &oauth_http_client().unwrap(), &url, &[("grant_type", "authorization_code")], "Codex login"
        ).await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn does_not_retry_invalid_grant() {
        let (url, server) = token_test_server(vec![(
            "400 Bad Request", r#"{"error":"invalid_grant"}"#, Duration::ZERO
        )]).await;
        let error = send_oauth_token_request(
            &oauth_http_client().unwrap(), &url, &[("grant_type", "authorization_code")], "Codex login"
        ).await.unwrap_err();
        assert!(error.to_string().contains("expired, invalid, or already used"));
        server.await.unwrap();
    }
}
