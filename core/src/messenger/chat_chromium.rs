//! Bộ mở trình duyệt thật cho đọc/gửi Messenger: Chrome headless với thư mục dữ liệu riêng của plugin
//! (tách khỏi Chrome chính), cookie nạp qua CDP. Không thể test tự động nếu không gọi Facebook thật.

use async_trait::async_trait;
use chromiumoxide::cdp::browser_protocol::input::InsertTextParams;
use chromiumoxide::cdp::browser_protocol::network::{CookieParam, SetCookiesParams};
use std::path::PathBuf;
use std::time::Duration;
use tokio::task::JoinHandle;

use super::chat::{ChatPage, PageError, PageLauncher};
use super::cookies::StoredCookie;
use super::login::{find_browser, LaunchError};

const OP_TIMEOUT: Duration = Duration::from_secs(20);

pub struct ChromiumPageLauncher {
    /// Thư mục dữ liệu trình duyệt riêng (ví dụ `<state_dir>/messenger-browser`).
    pub profile_dir: PathBuf,
    /// `true`: mở cửa sổ HIỆN để người dùng tự thao tác (nhập PIN khôi phục chat mã hóa).
    pub visible: bool,
}

struct ChromiumChatPage {
    browser: chromiumoxide::Browser,
    pump: JoinHandle<()>,
    page: chromiumoxide::Page,
}

fn cookie_param(c: &StoredCookie) -> CookieParam {
    let mut p = CookieParam::new(c.name.clone(), c.value.clone());
    p.domain = Some(c.domain.clone().unwrap_or_else(|| ".facebook.com".to_string()));
    p.path = Some(c.path.clone().unwrap_or_else(|| "/".to_string()));
    p.secure = Some(true);
    p.http_only = c.http_only;
    p
}

async fn bounded<T>(f: impl std::future::Future<Output = Result<T, chromiumoxide::error::CdpError>>) -> Result<T, PageError> {
    match tokio::time::timeout(OP_TIMEOUT, f).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) => Err(PageError::Failed),
        Err(_) => Err(PageError::Timeout),
    }
}

#[async_trait]
impl ChatPage for ChromiumChatPage {
    async fn goto(&mut self, url: &str) -> Result<(), PageError> {
        bounded(self.page.goto(url)).await.map(|_| ())
    }
    async fn url(&mut self) -> Result<String, PageError> {
        // Handler CDP kết thúc khi Chrome đã thoát (người dùng đóng cửa sổ).
        if self.pump.is_finished() {
            return Err(PageError::Failed);
        }
        // `page.url()` đọc thông tin target đã cache nên không lỗi khi Chrome đã đóng; evaluate thì có.
        let r = bounded(self.page.evaluate("location.href")).await?;
        Ok(r.into_value::<String>().unwrap_or_default())
    }
    async fn eval(&mut self, js: &str) -> Result<String, PageError> {
        let r = bounded(self.page.evaluate(js)).await?;
        r.into_value::<String>().map_err(|_| PageError::Failed)
    }
    async fn type_and_enter(&mut self, selector: &str, text: &str) -> Result<(), PageError> {
        let el = bounded(self.page.find_element(selector)).await?;
        bounded(el.click()).await?;
        bounded(self.page.execute(InsertTextParams::new(text))).await?;
        bounded(el.press_key("Enter")).await?;
        Ok(())
    }
    async fn close(&mut self) {
        let _ = self.browser.close().await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.browser.wait()).await;
        let _ = self.browser.kill().await;
        self.pump.abort();
    }
}

#[async_trait]
impl PageLauncher for ChromiumPageLauncher {
    fn available(&self) -> bool {
        find_browser().is_some()
    }
    async fn open(&self, cookies: &[StoredCookie]) -> Result<Box<dyn ChatPage>, LaunchError> {
        use futures::StreamExt;
        let exe = find_browser().ok_or(LaunchError::Missing)?;
        std::fs::create_dir_all(&self.profile_dir).map_err(|_| LaunchError::Failed)?;
        // Chrome mồ côi từ lần chạy trước (ví dụ sau khi Gateway restart) vẫn giữ thư mục dữ liệu này và làm trang kẹt:
        // đóng các tiến trình dùng đúng thư mục của plugin trước khi mở phiên mới.
        // `--` bắt buộc: mẫu bắt đầu bằng `--` sẽ bị pkill (macOS) hiểu là tùy chọn và không làm gì cả.
        let killed = std::process::Command::new("pkill").args(["-f", "--"]).arg(format!("--user-data-dir={}", self.profile_dir.display())).status().is_ok_and(|s| s.success());
        if killed {
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
        // Khóa mồ côi sau khi tiến trình trước chết đột ngột (chỉ phiên của plugin dùng thư mục này).
        for f in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
            let _ = std::fs::remove_file(self.profile_dir.join(f));
        }
        let mut builder = chromiumoxide::BrowserConfig::builder().chrome_executable(exe);
        if self.visible {
            builder = builder.with_head();
        }
        let config = builder
            .user_data_dir(&self.profile_dir)
            .window_size(1280, 900)
            .viewport(None)
            .launch_timeout(Duration::from_secs(15))
            .request_timeout(OP_TIMEOUT)
            .args(["--mute-audio", "--disable-notifications", "--lang=vi"])
            .build()
            .map_err(|_| LaunchError::Failed)?;
        let (mut browser, mut handler) = chromiumoxide::Browser::launch(config).await.map_err(|_| LaunchError::Failed)?;
        let pump = tokio::spawn(async move { while handler.next().await.is_some() {} });
        let opened = async {
            let page = browser.new_page("about:blank").await.ok()?;
            let params: Vec<CookieParam> = cookies.iter().map(cookie_param).collect();
            page.execute(SetCookiesParams::new(params)).await.ok()?;
            if self.visible {
                let _ = page.bring_to_front().await;
            }
            Some(page)
        }
        .await;
        match opened {
            Some(page) => Ok(Box::new(ChromiumChatPage { browser, pump, page })),
            None => {
                let _ = browser.kill().await;
                pump.abort();
                Err(LaunchError::Failed)
            }
        }
    }
}
