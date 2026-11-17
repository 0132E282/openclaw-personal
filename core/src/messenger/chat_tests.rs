use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

use super::chat::*;
use super::cookies::{CookieStore, StoredCookie};
use super::login::LaunchError;
use super::selectors::{self, *};
use super::chat_op;
use crate::secrets::{SecretError, SecretStore};

const SECRET_A: &str = "SECRETCUSER123";
const SECRET_B: &str = "SECRETXS456";

#[derive(Default)]
struct MemStore(Mutex<HashMap<String, String>>);
#[async_trait]
impl SecretStore for MemStore {
    async fn get(&self, k: &str) -> Result<Option<String>, SecretError> {
        Ok(self.0.lock().unwrap().get(k).cloned())
    }
    async fn set(&self, k: &str, v: &str) -> Result<(), SecretError> {
        self.0.lock().unwrap().insert(k.into(), v.into());
        Ok(())
    }
    async fn delete(&self, k: &str) -> Result<(), SecretError> {
        self.0.lock().unwrap().remove(k);
        Ok(())
    }
    async fn list(&self, p: &str) -> Result<Vec<String>, SecretError> {
        Ok(self.0.lock().unwrap().keys().filter(|k| k.starts_with(p)).cloned().collect())
    }
}

async fn store_with_cookies() -> CookieStore {
    let s = CookieStore::new(Arc::new(MemStore::default()));
    s.save("default", &json!([{"name": "c_user", "value": SECRET_A}, {"name": "xs", "value": SECRET_B}])).await.unwrap();
    s
}

fn empty_store() -> CookieStore {
    CookieStore::new(Arc::new(MemStore::default()))
}

// ---------- trình duyệt giả ----------

struct FakeState {
    url: String,
    complete: bool,
    login_form: bool,
    list: bool,
    composer: bool,
    pin: bool,
    redirect_thread_to: Option<String>,
    force_url: Option<String>,
    list_json: String,
    messages_json: String,
    account_json: String,
    composer_empties: bool,
    eval_delay: Duration,
    gotos: Vec<String>,
    typed: Vec<String>,
    evals: usize,
    closed: usize,
    inflight: usize,
    max_inflight: usize,
}

type Shared = Arc<Mutex<FakeState>>;

fn list_raw() -> String {
    json!({"ready": true, "rows": [
        {"href": "/messages/t/111/", "lines": ["An", "chào bạn", "·", "5 phút"], "unread": true, "avatars": 1, "avatar": "https://scontent-sin6-1.xx.fbcdn.net/v/t1/a.jpg?stp=1&_nc=2"},
        {"href": "/messages/t/222/", "lines": ["Nhóm A", "Bình: ok", "·", "12:30"], "unread": false, "avatars": 3, "avatar": "http://x.fbcdn.net/a.jpg"},
        {"href": "/messages/e2ee/t/333/", "lines": ["Bí mật", "x"], "unread": false, "avatars": 1}
    ]})
    .to_string()
}

fn fake_state() -> Shared {
    Arc::new(Mutex::new(FakeState {
        url: "about:blank".into(),
        complete: true,
        login_form: false,
        list: true,
        composer: true,
        pin: false,
        redirect_thread_to: None,
        force_url: None,
        list_json: list_raw(),
        messages_json: json!({"ready": true, "rows": [{"text": "hello", "mine": false, "sender": "An"}, {"text": "chào", "mine": true, "sender": ""}]}).to_string(),
        account_json: json!({"name": "Nguyễn Phúc", "avatar": "https://scontent.fsgn5-3.fna.fbcdn.net/v/a.jpg?x=1", "cardAvatar": ""}).to_string(),
        composer_empties: true,
        eval_delay: Duration::ZERO,
        gotos: vec![],
        typed: vec![],
        evals: 0,
        closed: 0,
        inflight: 0,
        max_inflight: 0,
    }))
}

struct FakePage(Shared);

#[async_trait]
impl ChatPage for FakePage {
    async fn goto(&mut self, url: &str) -> Result<(), PageError> {
        let mut s = self.0.lock().unwrap();
        s.gotos.push(url.to_string());
        s.url = if let Some(u) = s.force_url.clone() { u } else if url.contains("/messages/t/") { s.redirect_thread_to.clone().unwrap_or_else(|| url.to_string()) } else { url.to_string() };
        Ok(())
    }
    async fn url(&mut self) -> Result<String, PageError> {
        Ok(self.0.lock().unwrap().url.clone())
    }
    async fn eval(&mut self, js: &str) -> Result<String, PageError> {
        let delay = {
            let mut s = self.0.lock().unwrap();
            s.evals += 1;
            s.inflight += 1;
            s.max_inflight = s.max_inflight.max(s.inflight);
            s.eval_delay
        };
        tokio::time::sleep(delay.max(Duration::from_millis(2))).await;
        let mut s = self.0.lock().unwrap();
        s.inflight -= 1;
        Ok(if js == selectors::PROBE_JS {
            json!({"url": s.url, "complete": s.complete, "loginForm": s.login_form, "list": s.list, "composer": s.composer, "pin": s.pin}).to_string()
        } else if js == selectors::LIST_JS {
            s.list_json.clone()
        } else if js == selectors::MESSAGES_JS {
            s.messages_json.clone()
        } else if js == selectors::ACCOUNT_OPEN_JS {
            json!({"found": true}).to_string()
        } else if js == selectors::ACCOUNT_READ_JS {
            s.account_json.clone()
        } else if js == selectors::ACCOUNT_CLOSE_JS {
            "{}".to_string()
        } else {
            json!({"found": true, "empty": s.composer_empties}).to_string()
        })
    }
    async fn type_and_enter(&mut self, _selector: &str, text: &str) -> Result<(), PageError> {
        self.0.lock().unwrap().typed.push(text.to_string());
        Ok(())
    }
    async fn close(&mut self) {
        self.0.lock().unwrap().closed += 1;
    }
}

struct FakeLauncher {
    state: Shared,
    available: bool,
    opened: AtomicUsize,
    cookies_seen: Mutex<Vec<String>>,
}

impl FakeLauncher {
    fn new(state: &Shared) -> Self {
        Self { state: state.clone(), available: true, opened: AtomicUsize::new(0), cookies_seen: Mutex::new(vec![]) }
    }
    fn opened(&self) -> usize {
        self.opened.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl PageLauncher for FakeLauncher {
    fn available(&self) -> bool {
        self.available
    }
    async fn open(&self, cookies: &[StoredCookie]) -> Result<Box<dyn ChatPage>, LaunchError> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        self.cookies_seen.lock().unwrap().extend(cookies.iter().map(|c| c.name.clone()));
        Ok(Box::new(FakePage(self.state.clone())))
    }
}

fn cfg() -> ChatConfig {
    ChatConfig {
        cache_ttl: Duration::from_millis(250),
        account_ttl: Duration::from_millis(250),
        min_interval: Duration::from_millis(40),
        idle_timeout: Duration::from_millis(120),
        op_timeout: Duration::from_millis(600),
        ready_timeout: Duration::from_millis(150),
        ready_poll: Duration::from_millis(10),
        send_confirm: Duration::from_millis(80),
        send_cap: (3, Duration::from_secs(60)),
    }
}

// ---------- thuần: parse / classify ----------

#[test]
fn parse_conversations_chuan_hoa() {
    let l = parse_conversations(&list_raw()).unwrap();
    assert_eq!(l.e2ee_hidden, 0);
    assert_eq!(l.conversations.len(), 3);
    assert_eq!(l.conversations[2].id, "e2ee-333");
    let a = &l.conversations[0];
    assert_eq!((a.id.as_str(), a.title.as_str(), a.snippet.as_str(), a.time.as_str(), a.unread, a.is_group), ("111", "An", "chào bạn", "5 phút", true, false));
    assert!(l.conversations[1].is_group);
    assert_eq!(l.conversations[1].time, "12:30");
}

#[test]
fn parse_conversations_tach_thoi_gian_cung_dong_va_loai_bo_rac() {
    let raw = json!({"ready": true, "rows": [
        {"href": "/messages/t/9/", "lines": ["B", "xin chào · 2 giờ"]},
        {"href": "/messages/t/9/", "lines": ["trùng"]},
        {"href": "/messages/t/abc/", "lines": ["sai id"]},
        {"href": "/messages/t/10/x?y", "lines": ["  ", "·"]},
        {"href": "/other/12", "lines": ["lạ"]},
        {"href": "/messages/t/11/", "lines": ["T".repeat(500), "S".repeat(500)]}
    ]})
    .to_string();
    let l = parse_conversations(&raw).unwrap().conversations;
    assert_eq!(l.len(), 2);
    assert_eq!((l[0].snippet.as_str(), l[0].time.as_str()), ("xin chào", "2 giờ"));
    assert_eq!((l[1].title.chars().count(), l[1].snippet.chars().count()), (120, 200));
}

#[test]
fn parse_conversations_sai_dang_la_selector_broken() {
    assert_eq!(parse_conversations("không phải json").err(), Some(Reason::SelectorBroken));
    assert_eq!(parse_conversations(r#"{"ready":false,"rows":[]}"#).err(), Some(Reason::SelectorBroken));
    assert_eq!(parse_conversations(r#"{"ready":true}"#).err(), Some(Reason::SelectorBroken));
    assert!(parse_conversations(r#"{"ready":true,"rows":[]}"#).unwrap().conversations.is_empty());
}

#[test]
fn parse_messages_me_them_va_gioi_han() {
    let m = parse_messages(&json!({"ready": true, "rows": [{"text": "a", "mine": false, "sender": " An "}, {"text": "  ", "mine": true}, {"text": "b", "mine": true, "sender": "bị bỏ"}]}).to_string()).unwrap();
    assert_eq!(m.len(), 2);
    assert_eq!((m[0].from_me, m[0].sender_name.as_str()), (false, "An"));
    assert_eq!((m[1].from_me, m[1].sender_name.as_str()), (true, ""));
    assert_ne!(m[0].id, m[1].id);
    assert_eq!(m[0].to_json()["from"], "them");
    assert_eq!(m[1].to_json()["from"], "me");
    let many: Vec<Value> = (0..150).map(|i| json!({"text": format!("t{i}"), "mine": false})).collect();
    let m = parse_messages(&json!({"ready": true, "rows": many}).to_string()).unwrap();
    assert_eq!((m.len(), m[0].text.as_str(), m[99].text.as_str()), (100, "t50", "t149"));
    assert_eq!(parse_messages(r#"{"ready":false,"rows":[]}"#).err(), Some(Reason::SelectorBroken));
}

#[test]
fn parse_messages_page_co_trang_thai_tai_va_thoi_gian() {
    let p = parse_messages_page(&json!({"ready": true, "loading": true, "rows": [{"text": "a", "mine": false, "sender": "An", "time": "Lúc 12:30 5 Tháng 9, 2024"}]}).to_string()).unwrap();
    assert!(p.loading);
    assert_eq!((p.messages[0].time.as_str(), p.messages[0].sender_name.as_str()), ("Lúc 12:30 5 Tháng 9, 2024", "An"));
    assert!(!parse_messages_page(r#"{"ready":true,"rows":[]}"#).unwrap().loading);
}

#[test]
fn classify_anh_xa_ly_do() {
    let base = Probe { url: "https://www.facebook.com/messages/".into(), complete: true, list: true, ..Default::default() };
    assert_eq!(classify(&base, false), Ok(()));
    assert_eq!(classify(&Probe { login_form: true, ..base.clone() }, false), Err(Reason::NotLoggedIn));
    assert_eq!(classify(&Probe { url: "https://www.facebook.com/login/?next=x".into(), ..base.clone() }, false), Err(Reason::NotLoggedIn));
    assert_eq!(classify(&Probe { url: "https://www.facebook.com/index.php?next=https%3A%2F%2Fwww.facebook.com%2Fmessages%2F&deoia=1".into(), list: false, ..base.clone() }, false), Err(Reason::NotLoggedIn));
    assert_eq!(classify(&Probe { url: "https://www.facebook.com/checkpoint/1501/".into(), login_form: true, ..base.clone() }, false), Err(Reason::Checkpoint));
    assert_eq!(classify(&Probe { pin: true, ..base.clone() }, false), Err(Reason::E2eeLocked));
    let e2ee = Probe { url: "https://www.facebook.com/messages/e2ee/t/5/".into(), ..base };
    assert_eq!(classify(&e2ee, true), Ok(()));
    assert_eq!(classify(&e2ee, false), Ok(()));
    let lock = Probe { url: "https://www.facebook.com/messages/e2ee/".into(), ..e2ee.clone() };
    assert_eq!(classify(&lock, true), Err(Reason::E2eeLocked));
    assert_eq!(classify(&lock, false), Ok(()));
}

#[test]
fn id_va_url_hoi_thoai_chat_che() {
    assert_eq!(thread_url("123").as_deref(), Some("https://www.facebook.com/messages/t/123/"));
    for bad in ["", "abc", "1/2", "1?x=2", "../1", "12 3", &"1".repeat(31)] {
        assert!(thread_url(bad).is_none(), "{bad}");
    }
    assert_eq!(conversation_id_of_href("https://www.facebook.com/messages/e2ee/t/77/"), Some(("77".into(), true)));
    assert_eq!(thread_url("e2ee-123").as_deref(), Some("https://www.facebook.com/messages/e2ee/t/123/"));
    for bad in ["e2ee-", "e2ee-abc", "e2ee-e2ee-1", "e2ee/1", "E2EE-1", &format!("e2ee-{}", "1".repeat(31))] {
        assert!(thread_url(bad).is_none(), "{bad}");
    }
    assert_eq!(conversation_id_of_href("/messages/t/88"), Some(("88".into(), false)));
}

#[test]
fn reason_as_str_khop_hop_dong() {
    let all = [Reason::NotLoggedIn, Reason::Checkpoint, Reason::E2eeLocked, Reason::SelectorBroken, Reason::BrowserMissing, Reason::Timeout];
    let s: Vec<&str> = all.iter().map(|r| r.as_str()).collect();
    assert_eq!(s, ["not-logged-in", "checkpoint", "e2ee-locked", "selector-broken", "browser-missing", "timeout"]);
}

// ---------- dịch vụ với trình duyệt giả ----------

#[tokio::test]
async fn status_theo_cookie_va_het_han() {
    let chat = MessengerChat::new(cfg());
    assert_eq!(chat.status(&empty_store()).await, ChatStatus { state: "no-cookies", reason: None });
    let store = store_with_cookies().await;
    assert_eq!(chat.status(&store).await, ChatStatus { state: "connected", reason: None });
    let st = fake_state();
    st.lock().unwrap().login_form = true;
    let l = FakeLauncher::new(&st);
    assert_eq!(chat.conversations(&l, &store, "all").await.err(), Some(Reason::NotLoggedIn));
    assert_eq!(chat.status(&store).await, ChatStatus { state: "expired", reason: Some("not-logged-in") });
    // Đã hết hạn thì không mở lại trình duyệt/không gọi Facebook nữa; phiên cũ đã đóng.
    assert_eq!(chat.conversations(&l, &store, "all").await.err(), Some(Reason::NotLoggedIn));
    assert_eq!((l.opened(), st.lock().unwrap().closed), (1, 1));
    // Nhập cookie mới -> reset -> connected trở lại.
    chat.reset().await;
    assert_eq!(chat.status(&store).await, ChatStatus { state: "connected", reason: None });
}

#[tokio::test]
async fn doc_danh_sach_loc_thu_muc_va_cache() {
    let chat = MessengerChat::new(ChatConfig { idle_timeout: Duration::from_secs(60), ..cfg() });
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    let all = chat.conversations(&l, &store, "all").await.unwrap();
    assert_eq!((all.conversations.len(), all.e2ee_hidden), (3, 0));
    assert_eq!(st.lock().unwrap().gotos, vec!["https://www.facebook.com/messages/"]);
    assert_eq!(*l.cookies_seen.lock().unwrap(), vec!["c_user", "xs"]);
    let evals = st.lock().unwrap().evals;
    // Trong thời gian cache: không đụng tới trình duyệt, lọc theo thư mục từ cache.
    assert_eq!(chat.conversations(&l, &store, "unread").await.unwrap().conversations.len(), 1);
    assert_eq!(chat.conversations(&l, &store, "group").await.unwrap().conversations[0].id, "222");
    assert!(chat.conversations(&l, &store, "spam").await.unwrap().conversations.is_empty());
    assert_eq!(st.lock().unwrap().evals, evals);
    // Hết cache: đọc lại, vẫn dùng một phiên (không goto lại vì đang ở /messages/).
    tokio::time::sleep(Duration::from_millis(270)).await;
    chat.conversations(&l, &store, "all").await.unwrap();
    assert!(st.lock().unwrap().evals > evals);
    assert_eq!((l.opened(), st.lock().unwrap().gotos.len()), (1, 1));
}

#[tokio::test]
async fn thieu_trinh_duyet_hoac_cookie() {
    let st = fake_state();
    let mut l = FakeLauncher::new(&st);
    l.available = false;
    let chat = MessengerChat::new(cfg());
    assert_eq!(chat.conversations(&l, &store_with_cookies().await, "all").await.err(), Some(Reason::BrowserMissing));
    // Không cookie thì coi như chưa đăng nhập, không mở trình duyệt.
    let l2 = FakeLauncher::new(&st);
    assert_eq!(chat.conversations(&l2, &empty_store(), "all").await.err(), Some(Reason::NotLoggedIn));
    assert_eq!(l2.opened(), 0);
}

#[tokio::test]
async fn selector_hong_va_timeout_tai_trang() {
    let store = store_with_cookies().await;
    // Trang đã tải nhưng không có khung danh sách -> selector-broken.
    let st = fake_state();
    st.lock().unwrap().list = false;
    assert_eq!(MessengerChat::new(cfg()).conversations(&FakeLauncher::new(&st), &store, "all").await.err(), Some(Reason::SelectorBroken));
    // Khung có nhưng JS đọc không ra dữ liệu hợp lệ.
    let st = fake_state();
    st.lock().unwrap().list_json = "{}".into();
    assert_eq!(MessengerChat::new(cfg()).conversations(&FakeLauncher::new(&st), &store, "all").await.err(), Some(Reason::SelectorBroken));
    // Trang không bao giờ tải xong -> timeout.
    let st = fake_state();
    st.lock().unwrap().complete = false;
    assert_eq!(MessengerChat::new(cfg()).conversations(&FakeLauncher::new(&st), &store, "all").await.err(), Some(Reason::Timeout));
}

#[tokio::test]
async fn checkpoint_va_pin() {
    let store = store_with_cookies().await;
    let st = fake_state();
    st.lock().unwrap().force_url = Some("https://www.facebook.com/checkpoint/123".into());
    let chat = MessengerChat::new(cfg());
    assert_eq!(chat.conversations(&FakeLauncher::new(&st), &store, "all").await.err(), Some(Reason::Checkpoint));
    assert_eq!(chat.status(&store).await.reason, Some("checkpoint"));
    let st = fake_state();
    st.lock().unwrap().pin = true;
    let chat = MessengerChat::new(cfg());
    assert_eq!(chat.conversations(&FakeLauncher::new(&st), &store, "all").await.err(), Some(Reason::E2eeLocked));
    // PIN không làm đăng nhập hết hạn.
    assert_eq!(chat.status(&store).await.state, "connected");
}

#[tokio::test]
async fn doc_tin_di_dung_hoi_thoai_va_chan_id_xau() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    assert_eq!(chat.messages(&l, &store, "../x").await.err(), Some(Reason::InvalidInput));
    assert_eq!(l.opened(), 0);
    let m = chat.messages(&l, &store, "111").await.unwrap();
    assert_eq!((m.len(), m[0].from_me, m[1].from_me), (2, false, true));
    assert_eq!(st.lock().unwrap().gotos, vec!["https://www.facebook.com/messages/t/111/"]);
    // Chat mã hóa đầu-cuối: Facebook chuyển sang /messages/e2ee/ -> e2ee-locked, vẫn giữ phiên.
    st.lock().unwrap().redirect_thread_to = Some("https://www.facebook.com/messages/e2ee/".into());
    assert_eq!(chat.messages(&l, &store, "333").await.err(), Some(Reason::E2eeLocked));
    // Chat mã hóa đã mở khóa: id `e2ee-<id>` mở đúng URL e2ee và đọc như chat thường.
    st.lock().unwrap().redirect_thread_to = None;
    let m = chat.messages(&l, &store, "e2ee-333").await.unwrap();
    assert_eq!(m.len(), 2);
    assert_eq!(st.lock().unwrap().gotos.last().unwrap(), "https://www.facebook.com/messages/e2ee/t/333/");
    assert_eq!((l.opened(), chat.status(&store).await.state), (1, "connected"));
}

#[tokio::test]
async fn hoi_thoai_rong_that_va_chua_tai_xong() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    // Khung tin có, đã tải xong, rỗng ổn định -> mảng rỗng thật.
    st.lock().unwrap().messages_json = json!({"ready": true, "loading": false, "rows": []}).to_string();
    assert!(chat.messages(&l, &store, "111").await.unwrap().is_empty());
    // Còn đang tải: không được trả rỗng.
    st.lock().unwrap().messages_json = json!({"ready": true, "loading": true, "rows": []}).to_string();
    assert_eq!(chat.messages(&l, &store, "222").await.err(), Some(Reason::Timeout));
    // Không thấy khung tin: selector hỏng.
    st.lock().unwrap().messages_json = json!({"ready": false, "loading": false, "rows": []}).to_string();
    assert_eq!(chat.messages(&l, &store, "444").await.err(), Some(Reason::SelectorBroken));
}

#[tokio::test]
async fn gian_cach_toi_thieu_giua_cac_thao_tac() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    chat.messages(&l, &store, "111").await.unwrap();
    let t = Instant::now();
    chat.messages(&l, &store, "222").await.unwrap();
    assert!(t.elapsed() >= Duration::from_millis(40), "{:?}", t.elapsed());
}

#[tokio::test]
async fn thao_tac_dong_thoi_chay_tuan_tu() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    let (a, b, c) = tokio::join!(chat.messages(&l, &store, "1"), chat.messages(&l, &store, "2"), chat.conversations(&l, &store, "all"));
    assert!(a.is_ok() && b.is_ok() && c.is_ok());
    assert_eq!(st.lock().unwrap().max_inflight, 1);
    assert_eq!(l.opened(), 1);
}

#[tokio::test]
async fn tu_dong_phien_khi_ranh_va_mo_lai() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    chat.messages(&l, &store, "111").await.unwrap();
    assert_eq!(st.lock().unwrap().closed, 0);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(st.lock().unwrap().closed, 1);
    chat.messages(&l, &store, "222").await.unwrap();
    assert_eq!(l.opened(), 2);
}

#[tokio::test]
async fn timeout_thao_tac_dong_phien() {
    let chat = MessengerChat::new(ChatConfig { op_timeout: Duration::from_millis(80), ..cfg() });
    let store = store_with_cookies().await;
    let st = fake_state();
    st.lock().unwrap().eval_delay = Duration::from_millis(500);
    let l = FakeLauncher::new(&st);
    assert_eq!(chat.messages(&l, &store, "111").await.err(), Some(Reason::Timeout));
    assert_eq!(st.lock().unwrap().closed, 1);
    // Timeout không phải hết hạn đăng nhập.
    assert_eq!(chat.status(&store).await.state, "connected");
}

#[tokio::test]
async fn gui_tin_thanh_cong_xac_nhan_va_xoa_cache() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    chat.messages(&l, &store, "111").await.unwrap();
    chat.send(&l, &store, "111", "  xin chào  ").await.unwrap();
    assert_eq!(st.lock().unwrap().typed, vec!["xin chào"]);
    // Cache của hội thoại bị bỏ: đọc lại phải eval lại.
    let evals = st.lock().unwrap().evals;
    chat.messages(&l, &store, "111").await.unwrap();
    assert!(st.lock().unwrap().evals > evals);
}

#[tokio::test]
async fn gui_tin_khong_xac_nhan_thi_bao_timeout() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    st.lock().unwrap().composer_empties = false;
    assert_eq!(chat.send(&FakeLauncher::new(&st), &store, "111", "hi").await.err(), Some(Reason::Timeout));
}

#[tokio::test]
async fn gui_tin_kiem_tra_dau_vao_va_tran_toc_do() {
    let chat = MessengerChat::new(ChatConfig { min_interval: Duration::from_millis(1), ..cfg() });
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    for (id, text) in [("1", ""), ("1", "   "), ("x", "hi"), ("1", "a\u{7}b")] {
        assert_eq!(chat.send(&l, &store, id, text).await.err(), Some(Reason::InvalidInput));
    }
    assert_eq!(chat.send(&l, &store, "1", &"a".repeat(4001)).await.err(), Some(Reason::InvalidInput));
    assert_eq!(l.opened(), 0);
    for _ in 0..3 {
        chat.send(&l, &store, "1", "ok").await.unwrap();
    }
    assert_eq!(chat.send(&l, &store, "1", "ok").await.err(), Some(Reason::RateLimited));
    assert_eq!(st.lock().unwrap().typed.len(), 3);
}

// ---------- ops RPC ----------

#[tokio::test]
async fn ops_rpc_hinh_dang_va_khong_ro_cookie() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    let mut all = String::new();
    let call = |op: &'static str, input: Value| {
        let (chat, store, l) = (&chat, &store, &l);
        async move { chat_op(op, &input, store, chat, l).await.unwrap() }
    };
    let s = call("messenger.status", json!({})).await.unwrap();
    assert_eq!(s, json!({"state": "connected", "reason": null}));
    let c = call("messenger.conversations", json!({"folder": "group"})).await.unwrap();
    assert_eq!(c["ok"], true);
    assert_eq!(c["conversations"].as_array().unwrap().len(), 1);
    assert_eq!(c["conversations"][0], json!({"id": "222", "title": "Nhóm A", "snippet": "Bình: ok", "time": "12:30", "unread": false, "isGroup": true, "avatar": ""}));
    assert!(call("messenger.conversations", json!({"folder": "../x"})).await.is_err());
    let m = call("messenger.messages", json!({"conversationId": "111"})).await.unwrap();
    assert_eq!((m["ok"].clone(), m["messages"][0]["from"].clone(), m["messages"][1]["from"].clone()), (json!(true), json!("them"), json!("me")));
    assert_eq!(call("messenger.messages", json!({"conversationId": "a/b"})).await.unwrap(), json!({"ok": false, "reason": "invalid-input", "messages": []}));
    assert!(call("messenger.messages", json!({})).await.is_err());
    assert_eq!(call("messenger.send", json!({"conversationId": "111", "text": "hi"})).await.unwrap(), json!({"ok": true}));
    assert_eq!(call("messenger.send", json!({"conversationId": "111", "text": ""})).await.unwrap(), json!({"ok": false, "reason": "invalid-input"}));
    assert!(call("messenger.send", json!({"conversationId": 1})).await.is_err());
    for v in [&s, &c, &m] {
        all.push_str(&v.to_string());
    }
    assert!(!all.contains(SECRET_A) && !all.contains(SECRET_B));
    assert!(chat_op("messenger.login.start", &json!({}), &store, &chat, &l).await.is_none());
}

#[tokio::test]
async fn ops_rpc_het_han_tra_ly_do() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    st.lock().unwrap().login_form = true;
    let l = FakeLauncher::new(&st);
    let c = chat_op("messenger.conversations", &json!({}), &store, &chat, &l).await.unwrap().unwrap();
    assert_eq!(c, json!({"ok": false, "reason": "not-logged-in", "conversations": [], "e2eeHidden": 0}));
    let s = chat_op("messenger.status", &json!({}), &store, &chat, &l).await.unwrap().unwrap();
    assert_eq!(s, json!({"state": "expired", "reason": "not-logged-in"}));
    let s = chat_op("messenger.status", &json!({}), &empty_store(), &chat, &l).await.unwrap().unwrap();
    assert_eq!(s["state"], "no-cookies");
}

#[test]
fn avatar_chi_nhan_https_host_facebook() {
    use super::selectors::{avatar_url, parse_conversations};
    for ok in ["https://scontent-sin6-1.xx.fbcdn.net/v/a.jpg?x=1", "https://static.xx.fbcdn.net/a", "https://www.facebook.com/a.png", "https://scontent.example.org/a"] {
        assert_eq!(avatar_url(ok), ok);
    }
    let long = format!("https://scontent.xx.fbcdn.net/{}", "a".repeat(600));
    for bad in ["", "data:image/png;base64,AAAA", "blob:https://www.facebook.com/x", "http://scontent.xx.fbcdn.net/a", "https://evil.com/a.jpg", "https://evil.com/.fbcdn.net", "https://notfbcdn.net/a", "https://x.fbcdn.net@evil.com/a", "https://evil.com\\.facebook.com/a", &long] {
        assert_eq!(avatar_url(bad), "", "{bad}");
    }
    let raw = json!({"ready": true, "rows": [
        {"href": "/messages/t/1/", "lines": ["A", "b"], "avatar": "https://evil.com/a.jpg", "avatars": 1},
        {"href": "/messages/t/2/", "lines": ["B", "b"], "avatars": 1}]})
    .to_string();
    let l = parse_conversations(&raw).unwrap().conversations;
    assert_eq!((l[0].avatar.as_str(), l[1].avatar.as_str()), ("", ""));
}

#[test]
fn parse_account_chuan_hoa() {
    use super::selectors::{parse_account, AccountInfo};
    let ok = parse_account(&json!({"name": "  Nguyễn Phúc ", "avatar": "https://scontent.x.fbcdn.net/a.jpg", "cardAvatar": ""}).to_string()).unwrap();
    assert_eq!(ok, Some(AccountInfo { name: "Nguyễn Phúc".into(), avatar: "https://scontent.x.fbcdn.net/a.jpg".into() }));
    // Ảnh nút bị lọc (host lạ) thì rơi về ảnh trong thẻ /me/.
    let fb = parse_account(&json!({"name": "A", "avatar": "https://evil.com/a.jpg", "cardAvatar": "https://scontent.x.fbcdn.net/b.jpg"}).to_string()).unwrap().unwrap();
    assert_eq!(fb.avatar, "https://scontent.x.fbcdn.net/b.jpg");
    let none = parse_account(&json!({"name": "A", "avatar": "data:x"}).to_string()).unwrap().unwrap();
    assert_eq!(none.avatar, "");
    let long = parse_account(&json!({"name": "ă".repeat(200)}).to_string()).unwrap().unwrap();
    assert_eq!(long.name.chars().count(), 80);
    assert_eq!(parse_account(&json!({"name": ""}).to_string()).unwrap(), None);
    assert_eq!(parse_account(&json!({"name": "a\u{7}b"}).to_string()).unwrap(), None);
    assert!(parse_account("không phải json").is_err());
}

#[tokio::test]
async fn account_lay_ten_anh_cache_va_reset() {
    let chat = MessengerChat::new(ChatConfig { idle_timeout: Duration::from_secs(60), ..cfg() });
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    let a = chat.account(&l, &store).await.unwrap();
    assert_eq!((a.name.as_str(), a.avatar.as_str()), ("Nguyễn Phúc", "https://scontent.fsgn5-3.fna.fbcdn.net/v/a.jpg?x=1"));
    let evals = st.lock().unwrap().evals;
    // Gọi lại trong TTL: không eval thêm, không mở lại trang.
    assert_eq!(chat.account(&l, &store).await.unwrap(), a);
    assert_eq!((st.lock().unwrap().evals, l.opened()), (evals, 1));
    // Hết TTL: đọc lại nhưng tái dùng trang (không goto thêm).
    tokio::time::sleep(Duration::from_millis(300)).await;
    chat.account(&l, &store).await.unwrap();
    assert_eq!((st.lock().unwrap().gotos.len(), l.opened()), (1, 1));
    // reset xóa cache.
    chat.reset().await;
    let before = st.lock().unwrap().evals;
    chat.account(&l, &store).await.unwrap();
    assert!(st.lock().unwrap().evals > before);
    assert_eq!(l.opened(), 2);
}

#[tokio::test]
async fn account_khong_thay_ten_khong_dong_phien() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    st.lock().unwrap().account_json = json!({"name": "", "avatar": ""}).to_string();
    let l = FakeLauncher::new(&st);
    assert_eq!(chat.account(&l, &store).await.unwrap_err(), Reason::SelectorBroken);
    assert_eq!(st.lock().unwrap().closed, 0);
    // Hết hạn đăng nhập thì báo đúng lý do.
    let st2 = fake_state();
    st2.lock().unwrap().login_form = true;
    let l2 = FakeLauncher::new(&st2);
    assert_eq!(MessengerChat::new(cfg()).account(&l2, &store).await.unwrap_err(), Reason::NotLoggedIn);
}

#[tokio::test]
async fn op_messenger_account() {
    let chat = MessengerChat::new(cfg());
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    let r = chat_op("messenger.account", &json!({}), &store, &chat, &l).await.unwrap().unwrap();
    assert_eq!(r, json!({"ok": true, "name": "Nguyễn Phúc", "avatar": "https://scontent.fsgn5-3.fna.fbcdn.net/v/a.jpg?x=1"}));
    assert!(!r.to_string().contains(SECRET_A));
    let bad = chat_op("messenger.account", &json!({}), &empty_store(), &MessengerChat::new(cfg()), &l).await.unwrap().unwrap();
    assert_eq!(bad, json!({"ok": false, "name": "", "avatar": "", "reason": "not-logged-in"}));
}

// ---------- kho SQLite ----------

fn mem_store() -> super::store::MessengerStore {
    super::store::MessengerStore::open_in_memory().unwrap()
}

fn chat_with(db: &super::store::MessengerStore, cfg: ChatConfig) -> MessengerChat {
    let c = MessengerChat::new(cfg);
    c.set_store(db.clone());
    c
}

#[tokio::test]
async fn sqlite_doc_thanh_cong_thi_luu_va_loi_thi_phuc_vu_tu_kho() {
    let db = mem_store();
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    let chat = chat_with(&db, ChatConfig { cache_ttl: Duration::ZERO, ..cfg() });
    assert_eq!(chat.conversations(&l, &store, "all").await.unwrap().conversations.len(), 3);
    assert_eq!(chat.messages(&l, &store, "111").await.unwrap().len(), 2);
    assert_eq!(db.conversations("default").await.unwrap().0.len(), 3);
    assert_eq!(db.messages("111").await.unwrap().0.len(), 2);

    // Trang hỏng: vẫn trả dữ liệu đã lưu (kể cả lọc thư mục), không lỗi.
    {
        let mut s = st.lock().unwrap();
        s.complete = false;
        s.list = false;
    }
    assert_eq!(chat.conversations(&l, &store, "all").await.unwrap().conversations.len(), 3);
    assert_eq!(chat.conversations(&l, &store, "unread").await.unwrap().conversations.len(), 1);
    let m = chat.messages(&l, &store, "111").await.unwrap();
    assert_eq!((m[0].text.as_str(), m[1].text.as_str(), m[1].from_me), ("hello", "chào", true));
    // Hội thoại chưa lưu thì vẫn lỗi như trước.
    assert_eq!(chat.messages(&l, &store, "222").await.err(), Some(Reason::Timeout));
}

#[tokio::test]
async fn sqlite_phuc_vu_du_lieu_con_moi_khong_mo_chrome_va_het_han_van_bao_loi() {
    let db = mem_store();
    let store = store_with_cookies().await;
    let st = fake_state();
    let l1 = FakeLauncher::new(&st);
    let long = ChatConfig { cache_ttl: Duration::from_secs(60), ..cfg() };
    let c1 = chat_with(&db, long);
    c1.conversations(&l1, &store, "all").await.unwrap();
    c1.messages(&l1, &store, "111").await.unwrap();
    // "Khởi động lại": MessengerChat mới, cache bộ nhớ trống.
    let chat2 = chat_with(&db, long);
    let l2 = FakeLauncher::new(&st);
    assert_eq!(chat2.conversations(&l2, &store, "all").await.unwrap().conversations.len(), 3);
    assert_eq!(chat2.messages(&l2, &store, "111").await.unwrap().len(), 2);
    assert_eq!(l2.opened(), 0);

    // Hết hạn đăng nhập vẫn là lỗi dù có dữ liệu lưu.
    let st3 = fake_state();
    st3.lock().unwrap().login_form = true;
    let chat3 = chat_with(&db, ChatConfig { cache_ttl: Duration::ZERO, ..cfg() });
    assert_eq!(chat3.conversations(&FakeLauncher::new(&st3), &store, "all").await.err(), Some(Reason::NotLoggedIn));
    assert_eq!(chat3.messages(&FakeLauncher::new(&st3), &store, "111").await.err(), Some(Reason::NotLoggedIn));
}

#[tokio::test]
async fn sqlite_gui_tin_lam_du_lieu_luu_het_moi_va_logout_xoa_sach() {
    let db = mem_store();
    let store = store_with_cookies().await;
    let st = fake_state();
    let l = FakeLauncher::new(&st);
    let chat = chat_with(&db, ChatConfig { cache_ttl: Duration::from_secs(60), ..cfg() });
    chat.conversations(&l, &store, "all").await.unwrap();
    chat.messages(&l, &store, "111").await.unwrap();
    chat.send(&l, &store, "111", "hi").await.unwrap();
    st.lock().unwrap().messages_json = json!({"ready": true, "rows": [{"text": "mới", "mine": true}]}).to_string();
    assert_eq!(chat.messages(&l, &store, "111").await.unwrap()[0].text, "mới");

    chat.clear_store().await;
    assert!(db.conversations("default").await.is_none());
    assert!(db.messages("111").await.is_none());
}

#[tokio::test]
async fn sqlite_cat_gioi_han_va_khong_trung_id() {
    use super::store::*;
    let db = mem_store();
    let convs: Vec<Conversation> = (0..MAX_CONVERSATIONS + 20)
        .map(|i| Conversation { id: i.to_string(), title: format!("t{i}"), snippet: String::new(), time: String::new(), unread: i % 2 == 0, is_group: false, avatar: String::new() })
        .collect();
    db.put_conversations("default", convs, 2).await;
    let (got, hidden, _) = db.conversations("default").await.unwrap();
    assert_eq!((got.len(), hidden, got[0].id.as_str()), (MAX_CONVERSATIONS, 2, "0"));

    let mk = |i: usize| Message { id: format!("m{i}"), from_me: i % 2 == 0, sender_name: String::new(), text: format!("x{i}"), time: String::new() };
    db.put_messages("1", (0..MAX_MESSAGES + 50).map(mk).collect()).await;
    let (got, _) = db.messages("1").await.unwrap();
    assert_eq!((got.len(), got[0].text.as_str()), (MAX_MESSAGES, "x50"));
    db.put_messages("1", vec![mk(1), mk(1), mk(2)]).await;
    assert_eq!(db.messages("1").await.unwrap().0.len(), 2);
    db.clear().await;
    assert!(db.conversations("default").await.is_none());
}
