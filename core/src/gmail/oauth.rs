//! OAuth 2.0 cho Google "Desktop app" client: PKCE S256 + loopback 127.0.0.1:<cổng ngẫu nhiên>.
//! Token/mã/body phản hồi KHÔNG BAO GIỜ đi vào lỗi hay log: `OAuthError` chỉ mang mã cố định.
//! Lưu ý: app ở chế độ Testing trên Google Cloud thì refresh token hết hạn sau 7 ngày -> invalid_grant
//! -> `reauth-required`; người dùng phải đăng nhập lại (hoặc chuyển app sang In production).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Notify};

pub const GMAIL_SCOPES: [&str; 3] = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
];
pub const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
pub const DEFAULT_AUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const LOOPBACK_HOST: &str = "127.0.0.1";
pub const CALLBACK_PATH: &str = "/callback";

/// Lỗi OAuth chỉ mang mã cố định (cùng tập mã với contract `authReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OAuthError(pub &'static str);

impl std::fmt::Display for OAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// epoch ms
    pub expires_at: u64,
    pub scope: String,
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    rand::fill(&mut b[..]);
    b
}

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// challenge = base64url(SHA-256(verifier)).
pub fn challenge_of(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// verifier 43 ký tự (32 byte ngẫu nhiên).
pub fn create_pkce(random: &dyn Fn(usize) -> Vec<u8>) -> (String, String) {
    let verifier = b64url(&random(32));
    let challenge = challenge_of(&verifier);
    (verifier, challenge)
}

pub fn build_auth_url(auth_endpoint: &str, client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> String {
    let q = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &GMAIL_SCOPES.join(" "))
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .finish();
    format!("{auth_endpoint}?{q}")
}

/* ---------- loopback listener ---------- */

fn page(msg: &str) -> String {
    format!("<!doctype html><meta charset=\"utf-8\"><title>OpenClaw</title><p>{msg}</p>")
}

async fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Đọc đầu request (tối đa 8 KiB, 5 giây). Trả (request-target, host).
async fn read_request(stream: &mut TcpStream) -> Option<(String, Option<String>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    let read = async {
        while buf.len() < 8192 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return false,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        true
    };
    if !matches!(tokio::time::timeout(Duration::from_secs(5), read).await, Ok(true)) {
        return None;
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    if first.next()? != "GET" {
        return None;
    }
    let target = first.next()?.to_string();
    let host = lines
        .take_while(|l| !l.is_empty())
        .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("host")).map(|(_, v)| v.trim().to_string()));
    Some((target, host))
}

/// Xử lý một kết nối. Trả `Some(kết quả)` nếu là callback hợp lệ về mặt đường dẫn/host.
async fn handle_conn(mut stream: TcpStream, port: u16, expected_state: &str) -> Option<Result<String, OAuthError>> {
    let Some((target, host)) = read_request(&mut stream).await else {
        respond(&mut stream, 400, &page("Bad request")).await;
        return None;
    };
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    // Chặn DNS rebinding: Host phải đúng 127.0.0.1:<port>.
    if path != CALLBACK_PATH || host.as_deref().is_some_and(|h| h != format!("{LOOPBACK_HOST}:{port}")) {
        respond(&mut stream, 404, &page("Not found")).await;
        return None;
    }
    let get = |k: &str| url::form_urlencoded::parse(query.as_bytes()).find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    let (status, msg, result) = if get("state").as_deref() != Some(expected_state) {
        (400, "Invalid state. You can close this tab.", Err(OAuthError("state-mismatch")))
    } else if get("error").is_some() {
        (400, "Authorization was not granted. You can close this tab.", Err(OAuthError("access-denied")))
    } else {
        match get("code").filter(|c| !c.is_empty()) {
            None => (400, "Missing code. You can close this tab.", Err(OAuthError("invalid-response"))),
            Some(c) => (200, "Signed in. You can close this tab.", Ok(c)),
        }
    };
    respond(&mut stream, status, &page(msg)).await;
    Some(result)
}

pub struct Loopback {
    pub redirect_uri: String,
    pub addr: std::net::SocketAddr,
    /// Kết quả: mã xác thực hoặc OAuthError (state-mismatch, access-denied, timeout, cancelled...).
    pub code: oneshot::Receiver<Result<String, OAuthError>>,
}

/// Chỉ bind 127.0.0.1, cổng ngẫu nhiên (0); đóng listener ngay khi xong/hết hạn/hủy.
pub async fn start_loopback(expected_state: String, timeout: Duration, cancel: Arc<Notify>) -> Result<Loopback, OAuthError> {
    let listener = TcpListener::bind((LOOPBACK_HOST, 0)).await.map_err(|_| OAuthError("bind-failed"))?;
    let addr = listener.local_addr().map_err(|_| OAuthError("bind-failed"))?;
    let port = addr.port();
    let (tx, code) = oneshot::channel();
    tokio::spawn(async move {
        let (mtx, mut mrx) = mpsc::channel::<Result<String, OAuthError>>(4);
        let deadline = tokio::time::Instant::now() + timeout;
        let outcome = loop {
            tokio::select! {
                _ = cancel.notified() => break Err(OAuthError("cancelled")),
                _ = tokio::time::sleep_until(deadline) => break Err(OAuthError("timeout")),
                Some(r) = mrx.recv() => break r,
                acc = listener.accept() => {
                    if let Ok((stream, _)) = acc {
                        let (mtx, state) = (mtx.clone(), expected_state.clone());
                        tokio::spawn(async move {
                            if let Some(r) = handle_conn(stream, port, &state).await {
                                let _ = mtx.send(r).await;
                            }
                        });
                    }
                }
            }
        };
        drop(listener);
        let _ = tx.send(outcome);
    });
    Ok(Loopback { redirect_uri: format!("http://{LOOPBACK_HOST}:{port}{CALLBACK_PATH}"), addr, code })
}

/* ---------- token endpoint ---------- */

async fn token_request(http: &reqwest::Client, endpoint: &str, params: &[(&str, &str)]) -> Result<serde_json::Map<String, Value>, OAuthError> {
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params).finish();
    let res = http
        .post(endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|_| OAuthError("network"))?;
    let status = res.status();
    let json: Option<Value> = res.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok());
    if !status.is_success() {
        if json.as_ref().and_then(|v| v.get("error")).and_then(Value::as_str) == Some("invalid_grant") {
            return Err(OAuthError("reauth-required"));
        }
        return Err(OAuthError(if status.as_u16() >= 500 { "network" } else { "exchange-failed" }));
    }
    match json {
        Some(Value::Object(m)) if m.get("access_token").is_some_and(Value::is_string) && m.get("expires_in").is_some_and(Value::is_number) => Ok(m),
        _ => Err(OAuthError("invalid-response")),
    }
}

fn str_of(m: &serde_json::Map<String, Value>, k: &str) -> Option<String> {
    m.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn expiry(now: u64, m: &serde_json::Map<String, Value>) -> u64 {
    let secs = m.get("expires_in").and_then(Value::as_f64).unwrap_or(0.0).max(0.0);
    now + (secs * 1000.0) as u64
}

pub struct ClientCreds<'a> {
    pub client_id: &'a str,
    pub client_secret: Option<&'a str>,
}

fn with_secret<'a>(mut p: Vec<(&'a str, &'a str)>, secret: Option<&'a str>) -> Vec<(&'a str, &'a str)> {
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        p.push(("client_secret", s));
    }
    p
}

pub async fn exchange_code(http: &reqwest::Client, endpoint: &str, now: u64, c: &ClientCreds<'_>, code: &str, verifier: &str, redirect_uri: &str) -> Result<OAuthTokens, OAuthError> {
    let params = with_secret(
        vec![("grant_type", "authorization_code"), ("client_id", c.client_id), ("code", code), ("code_verifier", verifier), ("redirect_uri", redirect_uri)],
        c.client_secret,
    );
    let m = token_request(http, endpoint, &params).await?;
    let refresh_token = str_of(&m, "refresh_token").ok_or(OAuthError("no-refresh-token"))?;
    Ok(OAuthTokens { access_token: str_of(&m, "access_token").unwrap_or_default(), refresh_token, expires_at: expiry(now, &m), scope: str_of(&m, "scope").unwrap_or_default() })
}

/// Google thường không trả refresh_token mới: giữ cái cũ.
pub async fn refresh_access_token(http: &reqwest::Client, endpoint: &str, now: u64, c: &ClientCreds<'_>, refresh_token: &str) -> Result<OAuthTokens, OAuthError> {
    let params = with_secret(vec![("grant_type", "refresh_token"), ("client_id", c.client_id), ("refresh_token", refresh_token)], c.client_secret);
    let m = token_request(http, endpoint, &params).await?;
    Ok(OAuthTokens {
        access_token: str_of(&m, "access_token").unwrap_or_default(),
        refresh_token: str_of(&m, "refresh_token").unwrap_or_else(|| refresh_token.to_string()),
        expires_at: expiry(now, &m),
        scope: str_of(&m, "scope").unwrap_or_default(),
    })
}

/* ---------- controller: start / status / cancel ---------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub state: &'static str,
    pub reason: Option<&'static str>,
    pub account_id: Option<String>,
    pub address: Option<String>,
}

impl AuthStatus {
    fn new(state: &'static str, reason: Option<&'static str>) -> Self {
        Self { state, reason, account_id: None, address: None }
    }
}

/// Kết quả lưu token do wiring cung cấp (lấy địa chỉ qua getProfile rồi lưu).
pub type OnTokens = Arc<dyn Fn(OAuthTokens, String, Option<String>) -> futures_util::future::BoxFuture<'static, Result<(String, String), OAuthError>> + Send + Sync>;
pub type OpenBrowser = Arc<dyn Fn(&str) -> Result<(), ()> + Send + Sync>;

#[derive(Clone)]
pub struct AuthConfig {
    pub http: reqwest::Client,
    pub auth_endpoint: String,
    pub token_endpoint: String,
    pub timeout: Duration,
    pub open_browser: OpenBrowser,
    pub on_tokens: OnTokens,
    pub now: fn() -> u64,
    pub random: fn(usize) -> Vec<u8>,
}

struct Run {
    id: u64,
    cancel: Arc<Notify>,
}
struct Inner {
    status: AuthStatus,
    run: Option<Run>,
    next_id: u64,
}

#[derive(Clone)]
pub struct AuthController {
    cfg: Arc<AuthConfig>,
    inner: Arc<Mutex<Inner>>,
}

impl AuthController {
    pub fn new(cfg: AuthConfig) -> Self {
        Self { cfg: Arc::new(cfg), inner: Arc::new(Mutex::new(Inner { status: AuthStatus::new("idle", None), run: None, next_id: 1 })) }
    }

    pub fn status(&self) -> AuthStatus {
        self.inner.lock().unwrap().status.clone()
    }

    /// Trả ngay `waiting`/`failed`; luồng chạy nền trong task tokio.
    pub fn start(&self, client_id: &str, client_secret: Option<String>) -> &'static str {
        let mut g = self.inner.lock().unwrap();
        if g.status.state == "waiting" {
            return "waiting";
        }
        let n = client_id.chars().count();
        if !(8..=256).contains(&n) {
            g.status = AuthStatus::new("failed", Some("invalid-input"));
            return "failed";
        }
        let id = g.next_id;
        g.next_id += 1;
        let cancel = Arc::new(Notify::new());
        g.run = Some(Run { id, cancel: cancel.clone() });
        g.status = AuthStatus::new("waiting", None);
        drop(g);
        let me = self.clone();
        let (cid, secret) = (client_id.to_string(), client_secret.filter(|s| !s.is_empty()));
        tokio::spawn(async move {
            let result = me.flow(cancel, &cid, secret).await;
            let mut g = me.inner.lock().unwrap();
            if g.run.as_ref().map(|r| r.id) != Some(id) {
                return; // đã bị hủy/thay bởi phiên khác
            }
            g.run = None;
            g.status = match result {
                Ok((account_id, address)) => AuthStatus { state: "succeeded", reason: None, account_id: Some(account_id), address: Some(address) },
                Err(OAuthError("cancelled")) => AuthStatus::new("cancelled", None),
                Err(e) => AuthStatus::new("failed", Some(e.0)),
            };
        });
        "waiting"
    }

    pub fn cancel(&self) -> AuthStatus {
        let mut g = self.inner.lock().unwrap();
        if g.status.state == "waiting" {
            if let Some(run) = g.run.take() {
                run.cancel.notify_one();
            }
            g.status = AuthStatus::new("cancelled", None);
        }
        g.status.clone()
    }

    async fn flow(&self, cancel: Arc<Notify>, client_id: &str, client_secret: Option<String>) -> Result<(String, String), OAuthError> {
        let c = &*self.cfg;
        let (verifier, challenge) = create_pkce(&c.random);
        let state = b64url(&(c.random)(16));
        let lb = start_loopback(state.clone(), c.timeout, cancel.clone()).await?;
        let url = build_auth_url(&c.auth_endpoint, client_id, &lb.redirect_uri, &state, &challenge);
        let open = c.open_browser.clone();
        let opened = tokio::task::spawn_blocking(move || open(&url)).await.unwrap_or(Err(()));
        if opened.is_err() {
            cancel.notify_one(); // đóng listener
            return Err(OAuthError("browser-failed"));
        }
        let code = lb.code.await.map_err(|_| OAuthError("cancelled"))??;
        let creds = ClientCreds { client_id, client_secret: client_secret.as_deref() };
        let tokens = exchange_code(&c.http, &c.token_endpoint, (c.now)(), &creds, &code, &verifier, &lb.redirect_uri).await?;
        (c.on_tokens)(tokens, client_id.to_string(), client_secret).await
    }
}

/// Mở trình duyệt hệ thống bằng mảng đối số (không qua shell).
pub fn open_system_browser(url: &str) -> Result<(), ()> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    } else if cfg!(target_os = "windows") {
        // `cmd /c start` diễn giải `&` trong URL; rundll32 nhận URL như một đối số duy nhất.
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    match cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status() {
        Ok(s) if s.success() => Ok(()),
        _ => Err(()),
    }
}
