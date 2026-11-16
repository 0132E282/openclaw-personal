//! Mở khóa chat mã hóa đầu-cuối: mở Chrome HIỆN với đúng thư mục trình duyệt của các lần đọc ẩn,
//! để người dùng tự bấm "Khôi phục ngay" và nhập mã PIN Facebook. Module không đọc/lưu PIN.
//! Cửa sổ tồn tại tới khi người dùng đóng (hoặc hết giờ/hủy); xong thì gọi `after` (bỏ cache, đọc ẩn chạy lại).

use async_trait::async_trait;
use futures::future::BoxFuture;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::chat::{ChatPage, PageLauncher};
use super::cookies::{CookieStore, StoredCookie};
use super::login::{LaunchError, LoginStatus, Phase};
use super::DEFAULT_ACCOUNT;

pub const MESSAGES_URL: &str = "https://www.facebook.com/messages/";
pub const UNLOCK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const UNLOCK_POLL: Duration = Duration::from_secs(1);

/// Việc chạy sau khi cửa sổ đóng (ví dụ xóa cache hội thoại).
pub type After = Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send>;

#[derive(Clone, Copy)]
pub struct E2eeConfig {
    pub timeout: Duration,
    pub poll: Duration,
}

impl Default for E2eeConfig {
    fn default() -> Self {
        Self { timeout: UNLOCK_TIMEOUT, poll: UNLOCK_POLL }
    }
}

/// Bộ mở "bận": dùng cho đọc/gửi khi cửa sổ nhập PIN đang mở, không đụng vào thư mục trình duyệt.
pub struct BusyLauncher;

#[async_trait]
impl PageLauncher for BusyLauncher {
    fn available(&self) -> bool {
        true
    }
    async fn open(&self, _cookies: &[StoredCookie]) -> Result<Box<dyn ChatPage>, LaunchError> {
        Err(LaunchError::Failed)
    }
}

struct Inner {
    status: LoginStatus,
    generation: u64,
    cancel: Option<watch::Sender<bool>>,
    task: Option<JoinHandle<()>>,
}

/// Một cửa sổ nhập PIN tại một thời điểm.
#[derive(Clone)]
pub struct E2eeController {
    inner: Arc<Mutex<Inner>>,
}

impl Default for E2eeController {
    fn default() -> Self {
        Self::new()
    }
}

impl E2eeController {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(Inner { status: LoginStatus { phase: Phase::Idle, reason: None }, generation: 0, cancel: None, task: None })) }
    }

    pub fn status(&self) -> LoginStatus {
        self.inner.lock().unwrap().status
    }

    /// Mở cửa sổ và trả ngay. Đang chạy thì trả status hiện tại.
    pub fn start(&self, launcher: Arc<dyn PageLauncher>, store: CookieStore, cfg: E2eeConfig, after: After) -> LoginStatus {
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
            let result = run(launcher.as_ref(), &store, cfg, &mut rx).await;
            after().await;
            let mut g = inner.lock().unwrap();
            if g.generation == generation && g.status.phase == Phase::Running {
                g.status = result;
            }
        }));
        g.status
    }

    /// Đóng cửa sổ đang mở và chờ trình duyệt thoát.
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

async fn run(launcher: &dyn PageLauncher, store: &CookieStore, cfg: E2eeConfig, rx: &mut watch::Receiver<bool>) -> LoginStatus {
    let failed = |reason| LoginStatus { phase: Phase::Failed, reason: Some(reason) };
    let Some(cookies) = store.load(DEFAULT_ACCOUNT).await else { return failed("launch-failed") };
    let mut page = match launcher.open(&cookies).await {
        Ok(p) => p,
        Err(LaunchError::Missing) => return failed("browser-missing"),
        Err(LaunchError::Failed) => return failed("launch-failed"),
    };
    if page.goto(MESSAGES_URL).await.is_err() {
        page.close().await;
        return failed("launch-failed");
    }
    let deadline = tokio::time::Instant::now() + cfg.timeout;
    let result = loop {
        if *rx.borrow() {
            break LoginStatus { phase: Phase::Cancelled, reason: None };
        }
        if tokio::time::Instant::now() >= deadline {
            break failed("timeout");
        }
        // Người dùng đóng cửa sổ -> không còn trang để hỏi URL.
        if page.url().await.is_err() {
            break LoginStatus { phase: Phase::Succeeded, reason: None };
        }
        tokio::select! {
            _ = tokio::time::sleep(cfg.poll) => {}
            _ = rx.changed() => {}
        }
    };
    page.close().await;
    result
}
