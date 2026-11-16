//! Đọc/gửi tin Messenger qua MỘT phiên trình duyệt headless dùng lại (lazy start, tự đóng khi rảnh).
//! Trình duyệt nằm sau trait (`ChatPage`/`PageLauncher`) để test bằng bản giả, không gọi Facebook thật.
//! Giới hạn: tuần tự (mutex), tối thiểu 1 thao tác/giây, cache vài chục giây, timeout rõ ràng, trần số tin gửi.
//! Không bao giờ đưa cookie vào kết quả, lỗi hay log.

use async_trait::async_trait;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Instant};

use super::cookies::{CookieStore, StoredCookie};
use super::login::LaunchError;
use super::selectors::{self, Conversation, Message, Probe};
use super::DEFAULT_ACCOUNT;

/// Lý do cố định, an toàn để hiện cho người dùng.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    NotLoggedIn,
    Checkpoint,
    E2eeLocked,
    SelectorBroken,
    BrowserMissing,
    Timeout,
    LaunchFailed,
    RateLimited,
    InvalidInput,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotLoggedIn => "not-logged-in",
            Self::Checkpoint => "checkpoint",
            Self::E2eeLocked => "e2ee-locked",
            Self::SelectorBroken => "selector-broken",
            Self::BrowserMissing => "browser-missing",
            Self::Timeout => "timeout",
            Self::LaunchFailed => "launch-failed",
            Self::RateLimited => "rate-limited",
            Self::InvalidInput => "invalid-input",
        }
    }
    /// Cookie không còn dùng được: phải đăng nhập lại.
    fn is_auth(self) -> bool {
        matches!(self, Self::NotLoggedIn | Self::Checkpoint)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageError {
    Failed,
    Timeout,
}

fn reason_of(e: PageError) -> Reason {
    match e {
        PageError::Timeout => Reason::Timeout,
        PageError::Failed => Reason::LaunchFailed,
    }
}

/// Một tab trình duyệt đã nạp cookie.
#[async_trait]
pub trait ChatPage: Send {
    async fn goto(&mut self, url: &str) -> Result<(), PageError>;
    async fn url(&mut self) -> Result<String, PageError>;
    /// Chạy JS, trả chuỗi (các đoạn trong `selectors` luôn trả `JSON.stringify(...)`).
    async fn eval(&mut self, js: &str) -> Result<String, PageError>;
    /// Chọn ô `selector`, gõ `text` và nhấn Enter như người dùng.
    async fn type_and_enter(&mut self, selector: &str, text: &str) -> Result<(), PageError>;
    async fn close(&mut self);
}

#[async_trait]
pub trait PageLauncher: Send + Sync {
    fn available(&self) -> bool;
    /// Mở trình duyệt ẩn, nạp `cookies`; test dùng bản giả.
    async fn open(&self, cookies: &[StoredCookie]) -> Result<Box<dyn ChatPage>, LaunchError>;
}

#[derive(Clone, Copy)]
pub struct ChatConfig {
    pub cache_ttl: Duration,
    pub min_interval: Duration,
    pub idle_timeout: Duration,
    pub op_timeout: Duration,
    pub ready_timeout: Duration,
    pub ready_poll: Duration,
    pub send_confirm: Duration,
    /// Tối đa `.0` tin gửi trong cửa sổ `.1` (không phải công cụ gửi hàng loạt).
    pub send_cap: (usize, Duration),
}

impl Default for ChatConfig {
    fn default() -> Self {
        Self {
            cache_ttl: Duration::from_secs(25),
            min_interval: Duration::from_secs(1),
            idle_timeout: Duration::from_secs(5 * 60),
            op_timeout: Duration::from_secs(25),
            ready_timeout: Duration::from_secs(14),
            ready_poll: Duration::from_millis(500),
            send_confirm: Duration::from_secs(3),
            send_cap: (30, Duration::from_secs(10 * 60)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatStatus {
    /// `connected` | `expired` | `no-cookies`
    pub state: &'static str,
    pub reason: Option<&'static str>,
}

pub struct ConversationList {
    pub conversations: Vec<Conversation>,
    pub e2ee_hidden: usize,
}

#[derive(Default)]
struct Inner {
    session: Option<Box<dyn ChatPage>>,
    last_used: Option<Instant>,
    last_op: Option<Instant>,
    convs: Option<(Instant, Vec<Conversation>, usize)>,
    msgs: HashMap<String, (Instant, Vec<Message>)>,
    sends: VecDeque<Instant>,
    reaper: bool,
}

impl Inner {
    async fn close(&mut self) {
        if let Some(mut s) = self.session.take() {
            s.close().await;
        }
        self.convs = None;
        self.msgs.clear();
    }
}

const MAX_CACHED_THREADS: usize = 8;

#[derive(Clone)]
pub struct MessengerChat {
    inner: Arc<Mutex<Inner>>,
    /// Ngoài mutex chính để `status` không bị chặn bởi thao tác trình duyệt đang chạy.
    expired: Arc<StdMutex<Option<Reason>>>,
    cfg: ChatConfig,
}

impl MessengerChat {
    pub fn new(cfg: ChatConfig) -> Self {
        Self { inner: Arc::new(Mutex::new(Inner::default())), expired: Arc::new(StdMutex::new(None)), cfg }
    }

    fn expired(&self) -> Option<Reason> {
        *self.expired.lock().unwrap()
    }

    /// Trạng thái không mở trình duyệt: có cookie và chưa bị ghi nhận hết hạn thì coi là `connected`
    /// (lần đọc đầu tiên mới xác minh thật; hết hạn thì trạng thái chuyển `expired`).
    pub async fn status(&self, store: &CookieStore) -> ChatStatus {
        if !store.status(DEFAULT_ACCOUNT).await.present {
            return ChatStatus { state: "no-cookies", reason: None };
        }
        match self.expired() {
            Some(r) => ChatStatus { state: "expired", reason: Some(r.as_str()) },
            None => ChatStatus { state: "connected", reason: None },
        }
    }

    /// Cookie đổi (nhập mới/đăng xuất): bỏ cờ hết hạn, đóng phiên và xóa cache.
    pub async fn reset(&self) {
        *self.expired.lock().unwrap() = None;
        self.inner.lock().await.close().await;
    }

    pub async fn conversations(&self, launcher: &dyn PageLauncher, store: &CookieStore, folder: &str) -> Result<ConversationList, Reason> {
        let mut g = self.inner.lock().await;
        if let Some((at, list, hidden)) = &g.convs {
            if at.elapsed() < self.cfg.cache_ttl {
                return Ok(filter_folder(list, folder, *hidden));
            }
        }
        let r = match timeout(self.cfg.op_timeout, self.fetch_conversations(&mut g, launcher, store)).await {
            Ok(r) => r,
            Err(_) => Err(Reason::Timeout),
        };
        let r = self.settle(&mut g, r).await?;
        g.convs = Some((Instant::now(), r.conversations.clone(), r.e2ee_hidden));
        Ok(filter_folder(&r.conversations, folder, r.e2ee_hidden))
    }

    pub async fn messages(&self, launcher: &dyn PageLauncher, store: &CookieStore, conversation_id: &str) -> Result<Vec<Message>, Reason> {
        if !selectors::valid_conversation_id(conversation_id) {
            return Err(Reason::InvalidInput);
        }
        let mut g = self.inner.lock().await;
        if let Some((at, list)) = g.msgs.get(conversation_id) {
            if at.elapsed() < self.cfg.cache_ttl {
                return Ok(list.clone());
            }
        }
        let r = match timeout(self.cfg.op_timeout, self.fetch_messages(&mut g, launcher, store, conversation_id)).await {
            Ok(r) => r,
            Err(_) => Err(Reason::Timeout),
        };
        let list = self.settle(&mut g, r).await?;
        if g.msgs.len() >= MAX_CACHED_THREADS {
            g.msgs.clear();
        }
        g.msgs.insert(conversation_id.to_string(), (Instant::now(), list.clone()));
        Ok(list)
    }

    pub async fn send(&self, launcher: &dyn PageLauncher, store: &CookieStore, conversation_id: &str, text: &str) -> Result<(), Reason> {
        let text = text.trim();
        if !selectors::valid_conversation_id(conversation_id) || text.is_empty() || text.chars().count() > selectors::MAX_TEXT || text.chars().any(|c| c.is_control() && c != '\n') {
            return Err(Reason::InvalidInput);
        }
        let mut g = self.inner.lock().await;
        let now = Instant::now();
        let (cap, window) = self.cfg.send_cap;
        while g.sends.front().is_some_and(|t| now.duration_since(*t) >= window) {
            g.sends.pop_front();
        }
        if g.sends.len() >= cap {
            return Err(Reason::RateLimited);
        }
        let r = match timeout(self.cfg.op_timeout, self.do_send(&mut g, launcher, store, conversation_id, text)).await {
            Ok(r) => r,
            Err(_) => Err(Reason::Timeout),
        };
        self.settle(&mut g, r).await?;
        g.sends.push_back(Instant::now());
        g.msgs.remove(conversation_id);
        g.convs = None;
        Ok(())
    }

    /// Chuẩn bị phiên: bỏ qua nếu đã biết hết hạn, giãn cách thao tác, mở trình duyệt khi cần.
    async fn prepare(&self, g: &mut Inner, launcher: &dyn PageLauncher, store: &CookieStore) -> Result<(), Reason> {
        if let Some(r) = self.expired() {
            return Err(r);
        }
        if let Some(t) = g.last_op {
            let since = t.elapsed();
            if since < self.cfg.min_interval {
                sleep(self.cfg.min_interval - since).await;
            }
        }
        if g.session.is_none() {
            if !launcher.available() {
                return Err(Reason::BrowserMissing);
            }
            let cookies = store.load(DEFAULT_ACCOUNT).await.ok_or(Reason::NotLoggedIn)?;
            g.session = Some(launcher.open(&cookies).await.map_err(|e| if e == LaunchError::Missing { Reason::BrowserMissing } else { Reason::LaunchFailed })?);
            self.spawn_reaper(g);
        }
        Ok(())
    }

    /// Ghi nhận kết quả: hết hạn thì nhớ lại và đóng phiên; timeout/trình duyệt hỏng thì đóng phiên để lần sau mở lại.
    async fn settle<T>(&self, g: &mut Inner, r: Result<T, Reason>) -> Result<T, Reason> {
        let now = Instant::now();
        g.last_op = Some(now);
        g.last_used = Some(now);
        if let Err(e) = r {
            if e.is_auth() {
                *self.expired.lock().unwrap() = Some(e);
            }
            if e.is_auth() || matches!(e, Reason::Timeout | Reason::LaunchFailed) {
                g.close().await;
            }
            return Err(e);
        }
        r
    }

    async fn fetch_conversations(&self, g: &mut Inner, launcher: &dyn PageLauncher, store: &CookieStore) -> Result<ConversationList, Reason> {
        self.prepare(g, launcher, store).await?;
        let page = g.session.as_mut().expect("prepare đã mở phiên").as_mut();
        if !page.url().await.map_err(reason_of)?.starts_with(selectors::MESSAGES_URL.trim_end_matches('/')) {
            page.goto(selectors::MESSAGES_URL).await.map_err(reason_of)?;
        }
        self.wait_ready(page, false, |p| p.list).await?;
        let raw = page.eval(selectors::LIST_JS).await.map_err(reason_of)?;
        let parsed = selectors::parse_conversations(&raw)?;
        Ok(ConversationList { conversations: parsed.conversations, e2ee_hidden: parsed.e2ee_hidden })
    }

    /// Đưa tab tới đúng hội thoại và chờ ô soạn xuất hiện.
    async fn open_thread(&self, page: &mut dyn ChatPage, id: &str) -> Result<(), Reason> {
        let url = selectors::thread_url(id).ok_or(Reason::InvalidInput)?;
        let cur = page.url().await.map_err(reason_of)?;
        if !cur.contains(&format!("/messages/t/{id}")) {
            page.goto(&url).await.map_err(reason_of)?;
        }
        self.wait_ready(page, true, |p| p.composer).await?;
        Ok(())
    }

    async fn fetch_messages(&self, g: &mut Inner, launcher: &dyn PageLauncher, store: &CookieStore, id: &str) -> Result<Vec<Message>, Reason> {
        self.prepare(g, launcher, store).await?;
        let page = g.session.as_mut().expect("prepare đã mở phiên").as_mut();
        self.open_thread(page, id).await?;
        let raw = page.eval(selectors::MESSAGES_JS).await.map_err(reason_of)?;
        selectors::parse_messages(&raw)
    }

    async fn do_send(&self, g: &mut Inner, launcher: &dyn PageLauncher, store: &CookieStore, id: &str, text: &str) -> Result<(), Reason> {
        self.prepare(g, launcher, store).await?;
        let page = g.session.as_mut().expect("prepare đã mở phiên").as_mut();
        self.open_thread(page, id).await?;
        page.type_and_enter(selectors::COMPOSER_SELECTOR, text).await.map_err(|e| if e == PageError::Failed { Reason::SelectorBroken } else { Reason::Timeout })?;
        // Xác nhận: ô soạn đã rỗng (tin đã đi). Không xác nhận được thì báo timeout thay vì giả vờ thành công.
        let deadline = Instant::now() + self.cfg.send_confirm;
        loop {
            let raw = page.eval(selectors::COMPOSER_EMPTY_JS).await.map_err(reason_of)?;
            let v: serde_json::Value = serde_json::from_str(&raw).map_err(|_| Reason::SelectorBroken)?;
            if v["found"] != true {
                return Err(Reason::SelectorBroken);
            }
            if v["empty"] == true {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(Reason::Timeout);
            }
            sleep(self.cfg.ready_poll.min(Duration::from_millis(250))).await;
        }
    }

    /// Chờ trang tải xong và thỏa `need`; trả lý do nếu đăng nhập hết hạn/checkpoint/PIN. Hết giờ: chưa tải xong
    /// -> `Timeout`; tải xong mà thiếu phần tử cần đọc -> `SelectorBroken`.
    async fn wait_ready(&self, page: &mut dyn ChatPage, thread: bool, need: fn(&Probe) -> bool) -> Result<Probe, Reason> {
        let deadline = Instant::now() + self.cfg.ready_timeout;
        let mut loaded = false;
        loop {
            // Lỗi eval giữa lúc đang chuyển trang là bình thường: thử lại tới hạn chót.
            if let Ok(raw) = page.eval(selectors::PROBE_JS).await {
                let p = selectors::parse_probe(&raw)?;
                selectors::classify(&p, thread)?;
                loaded = p.complete;
                if p.complete && need(&p) {
                    return Ok(p);
                }
            }
            if Instant::now() >= deadline {
                return Err(if loaded { Reason::SelectorBroken } else { Reason::Timeout });
            }
            sleep(self.cfg.ready_poll).await;
        }
    }

    /// Tự đóng phiên khi rảnh quá `idle_timeout`; tác vụ nền thoát khi không còn phiên.
    fn spawn_reaper(&self, g: &mut Inner) {
        if g.reaper {
            return;
        }
        g.reaper = true;
        let weak = Arc::downgrade(&self.inner);
        let idle = self.cfg.idle_timeout;
        let tick = (idle / 4).max(Duration::from_millis(10));
        tokio::spawn(async move {
            loop {
                sleep(tick).await;
                let Some(a) = weak.upgrade() else { return };
                let mut g = a.lock().await;
                if g.session.is_none() {
                    g.reaper = false;
                    return;
                }
                if g.last_used.is_some_and(|t| t.elapsed() >= idle) {
                    g.close().await;
                    g.reaper = false;
                    return;
                }
            }
        });
    }
}

fn filter_folder(all: &[Conversation], folder: &str, e2ee_hidden: usize) -> ConversationList {
    let conversations = match folder {
        "unread" => all.iter().filter(|c| c.unread).cloned().collect(),
        "group" => all.iter().filter(|c| c.is_group).cloned().collect(),
        "all" => all.to_vec(),
        // Tin chờ/đã chặn/spam chưa hỗ trợ: trả rỗng thay vì đoán.
        _ => Vec::new(),
    };
    ConversationList { conversations, e2ee_hidden }
}
