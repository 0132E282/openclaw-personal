//! Đăng nhập Messenger bằng trình duyệt thật (chromiumoxide), port từ `messengerLogin.ts`.
//! Người dùng tự gõ mật khẩu trong cửa sổ trình duyệt; module chỉ chờ cookie `c_user` + `xs`
//! và không bao giờ đọc thông tin đăng nhập. Cookie đi thẳng vào kho bí mật, không nằm trong status.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::cookies::CookieStore;

pub const FACEBOOK_URL: &str = "https://www.facebook.com/";
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const LOGIN_POLL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchError {
    /// Không tìm thấy Chrome/Chromium.
    Missing,
    Failed,
}

/// Một phiên trình duyệt đang mở.
#[async_trait]
pub trait BrowserSession: Send {
    /// Toàn bộ cookie hiện có, dạng `{name,value,domain,path,expires,httpOnly,secure}`.
    async fn cookies(&mut self) -> Result<Vec<Value>, ()>;
    async fn close(&mut self);
}

/// Bộ mở trình duyệt; test dùng bản giả.
#[async_trait]
pub trait BrowserLauncher: Send + Sync {
    /// Có trình duyệt dùng được không (kiểm tra nhanh, không mở).
    fn available(&self) -> bool;
    /// Mở cửa sổ HIỆN (không headless) tại `url`.
    async fn launch(&self, url: &str) -> Result<Box<dyn BrowserSession>, LaunchError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoginStatus {
    pub phase: Phase,
    /// `browser-missing` | `launch-failed` | `timeout` | `save-failed`
    pub reason: Option<&'static str>,
}

impl LoginStatus {
    const IDLE: Self = Self { phase: Phase::Idle, reason: None };
    pub fn to_json(self) -> Value {
        let phase = match self.phase {
            Phase::Idle => "idle",
            Phase::Running => "running",
            Phase::Succeeded => "succeeded",
            Phase::Failed => "failed",
            Phase::Cancelled => "cancelled",
        };
        json!({"phase": phase, "reason": self.reason})
    }
}

#[derive(Clone, Copy)]
pub struct LoginConfig {
    pub timeout: Duration,
    pub poll: Duration,
}

impl Default for LoginConfig {
    fn default() -> Self {
        Self { timeout: LOGIN_TIMEOUT, poll: LOGIN_POLL }
    }
}

struct Inner {
    status: LoginStatus,
    generation: u64,
    cancel: Option<watch::Sender<bool>>,
    task: Option<JoinHandle<()>>,
}

/// Một phiên đăng nhập tại một thời điểm.
#[derive(Clone)]
pub struct LoginController {
    inner: Arc<Mutex<Inner>>,
}

impl Default for LoginController {
    fn default() -> Self {
        Self::new()
    }
}

/// Chọn cookie phiên Facebook; `Some` khi có đủ `c_user` và `xs` không rỗng.
fn pick_session_cookies(all: Vec<Value>) -> Option<Vec<Value>> {
    let fb: Vec<Value> = all
        .into_iter()
        .filter(|c| {
            c.get("name").and_then(Value::as_str).is_some()
                && c.get("value").and_then(Value::as_str).is_some()
                && c.get("domain").and_then(Value::as_str).is_some_and(|d| {
                    let d = d.to_ascii_lowercase();
                    d == "facebook.com" || d.ends_with(".facebook.com")
                })
        })
        .collect();
    let has = |n: &str| fb.iter().any(|c| c["name"] == n && c["value"].as_str().is_some_and(|v| !v.is_empty()));
    if has("c_user") && has("xs") {
        Some(fb)
    } else {
        None
    }
}

enum Outcome {
    Cookies(Vec<Value>),
    Timeout,
    Cancelled,
    Error,
}

async fn wait_for_cookies(session: &mut dyn BrowserSession, cfg: LoginConfig, rx: &mut watch::Receiver<bool>) -> Outcome {
    let deadline = tokio::time::Instant::now() + cfg.timeout;
    loop {
        if *rx.borrow() {
            return Outcome::Cancelled;
        }
        if tokio::time::Instant::now() >= deadline {
            return Outcome::Timeout;
        }
        match session.cookies().await {
            Ok(all) => {
                if let Some(c) = pick_session_cookies(all) {
                    return Outcome::Cookies(c);
                }
            }
            Err(()) => return Outcome::Error,
        }
        tokio::select! {
            _ = tokio::time::sleep(cfg.poll) => {}
            _ = rx.changed() => {}
        }
    }
}

impl LoginController {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(Inner { status: LoginStatus::IDLE, generation: 0, cancel: None, task: None })) }
    }

    pub fn status(&self) -> LoginStatus {
        self.inner.lock().unwrap().status
    }

    /// Bắt đầu phiên đăng nhập. Đang chạy thì trả status hiện tại. Thiếu trình duyệt -> failed/browser-missing.
    pub fn start(&self, launcher: Arc<dyn BrowserLauncher>, store: CookieStore, account: String, cfg: LoginConfig) -> LoginStatus {
        let mut g = self.inner.lock().unwrap();
        if g.status.phase == Phase::Running {
            return g.status;
        }
        g.generation += 1;
        let generation = g.generation;
        if !launcher.available() {
            g.status = LoginStatus { phase: Phase::Failed, reason: Some("browser-missing") };
            return g.status;
        }
        let (tx, mut rx) = watch::channel(false);
        g.cancel = Some(tx);
        g.status = LoginStatus { phase: Phase::Running, reason: None };
        let inner = self.inner.clone();
        g.task = Some(tokio::spawn(async move {
            let result = run(launcher.as_ref(), &store, &account, cfg, &mut rx).await;
            let mut g = inner.lock().unwrap();
            // Bị hủy/thay phiên khác thì không ghi đè status.
            if g.generation == generation && g.status.phase == Phase::Running {
                g.status = result;
            }
        }));
        g.status
    }

    /// Hủy phiên đang chạy và chờ trình duyệt đóng.
    pub async fn cancel(&self) -> LoginStatus {
        let task = {
            let mut g = self.inner.lock().unwrap();
            if g.status.phase != Phase::Running {
                return g.status;
            }
            g.status = LoginStatus { phase: Phase::Cancelled, reason: None };
            if let Some(tx) = g.cancel.take() {
                let _ = tx.send(true);
            }
            g.task.take()
        };
        if let Some(t) = task {
            let _ = tokio::time::timeout(Duration::from_secs(10), t).await;
        }
        self.status()
    }
}

async fn run(launcher: &dyn BrowserLauncher, store: &CookieStore, account: &str, cfg: LoginConfig, rx: &mut watch::Receiver<bool>) -> LoginStatus {
    let failed = |reason| LoginStatus { phase: Phase::Failed, reason: Some(reason) };
    let mut session = match launcher.launch(FACEBOOK_URL).await {
        Ok(s) => s,
        Err(LaunchError::Missing) => return failed("browser-missing"),
        Err(LaunchError::Failed) => return failed("launch-failed"),
    };
    let outcome = wait_for_cookies(session.as_mut(), cfg, rx).await;
    session.close().await;
    match outcome {
        Outcome::Cookies(c) => match store.save(account, &Value::Array(c)).await {
            Ok(()) => LoginStatus { phase: Phase::Succeeded, reason: None },
            Err(_) => failed("save-failed"),
        },
        Outcome::Timeout => failed("timeout"),
        Outcome::Cancelled => LoginStatus { phase: Phase::Cancelled, reason: None },
        Outcome::Error => failed("launch-failed"),
    }
}

// ---- Bộ mở trình duyệt thật (chromiumoxide) ----

/// Tìm Chrome/Chromium: đường dẫn macOS cố định rồi PATH.
pub fn find_browser() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let fixed = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for p in fixed {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"] {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

pub struct ChromiumLauncher;

struct ChromiumSession {
    browser: chromiumoxide::Browser,
    pump: JoinHandle<()>,
    _page: chromiumoxide::Page,
}

#[async_trait]
impl BrowserSession for ChromiumSession {
    async fn cookies(&mut self) -> Result<Vec<Value>, ()> {
        let all = self.browser.get_cookies().await.map_err(|_| ())?;
        Ok(all
            .into_iter()
            .map(|c| json!({"name": c.name, "value": c.value, "domain": c.domain, "path": c.path, "expires": c.expires, "httpOnly": c.http_only, "secure": c.secure}))
            .collect())
    }
    async fn close(&mut self) {
        let _ = self.browser.close().await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.browser.wait()).await;
        let _ = self.browser.kill().await;
        self.pump.abort();
    }
}

#[async_trait]
impl BrowserLauncher for ChromiumLauncher {
    fn available(&self) -> bool {
        find_browser().is_some()
    }
    async fn launch(&self, url: &str) -> Result<Box<dyn BrowserSession>, LaunchError> {
        use futures::StreamExt;
        let exe = find_browser().ok_or(LaunchError::Missing)?;
        let config = chromiumoxide::BrowserConfig::builder().chrome_executable(exe).with_head().viewport(None).build().map_err(|_| LaunchError::Failed)?;
        let (mut browser, mut handler) = chromiumoxide::Browser::launch(config).await.map_err(|_| LaunchError::Failed)?;
        let pump = tokio::spawn(async move { while handler.next().await.is_some() {} });
        match browser.new_page(url).await {
            Ok(page) => {
                // Chạy từ dịch vụ nền nên cửa sổ dễ nằm sau các app khác: đưa lên trước.
                let _ = page.bring_to_front().await;
                Ok(Box::new(ChromiumSession { browser, pump, _page: page }))
            }
            Err(_) => {
                let _ = browser.kill().await;
                pump.abort();
                Err(LaunchError::Failed)
            }
        }
    }
}
