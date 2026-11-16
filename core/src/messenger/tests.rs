use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::cookies::{sanitize_cookies, CookieError, CookieStore};
use super::login::*;
use crate::secrets::{SecretError, SecretStore};

const SECRET_A: &str = "SECRETCUSER123";
const SECRET_B: &str = "SECRETXS456";

#[derive(Default)]
struct MemStore {
    map: Mutex<HashMap<String, String>>,
    fail: bool,
}
#[async_trait]
impl SecretStore for MemStore {
    async fn get(&self, k: &str) -> Result<Option<String>, SecretError> {
        Ok(self.map.lock().unwrap().get(k).cloned())
    }
    async fn set(&self, k: &str, v: &str) -> Result<(), SecretError> {
        if self.fail {
            return Err(SecretError::Io);
        }
        self.map.lock().unwrap().insert(k.into(), v.into());
        Ok(())
    }
    async fn delete(&self, k: &str) -> Result<(), SecretError> {
        self.map.lock().unwrap().remove(k);
        Ok(())
    }
    async fn list(&self, p: &str) -> Result<Vec<String>, SecretError> {
        Ok(self.map.lock().unwrap().keys().filter(|k| k.starts_with(p)).cloned().collect())
    }
}

fn store(mem: &Arc<MemStore>) -> CookieStore {
    CookieStore::with_clock(mem.clone(), || 42)
}

fn good() -> Value {
    json!([
        {"name": "c_user", "value": SECRET_A, "domain": ".facebook.com"},
        {"name": "xs", "value": SECRET_B, "domain": ".facebook.com", "httpOnly": true},
        {"name": "junk", "value": "zzz"}
    ])
}

#[tokio::test]
async fn messenger_cookies_round_trip_overwrite_and_filter() {
    let mem = Arc::new(MemStore::default());
    let s = store(&mem);
    assert_eq!(s.save("default", &good()).await, Ok(()));
    assert_eq!(s.save("default", &good()).await, Ok(()));
    let st = s.status("default").await;
    assert!(st.present);
    assert_eq!(st.saved_at, Some(42));
    let mut names: Vec<_> = s.load("default").await.unwrap().into_iter().map(|c| c.name).collect();
    names.sort();
    assert_eq!(names, ["c_user", "xs"]);
    assert!(mem.map.lock().unwrap().contains_key("messenger-default"));
    assert_eq!(s.clear("default").await, Ok(()));
    assert!(!s.status("default").await.present);
}

#[tokio::test]
async fn messenger_cookies_reject_and_never_leak() {
    let mem = Arc::new(MemStore::default());
    let s = store(&mem);
    assert_eq!(s.save("../x", &good()).await, Err(CookieError::InvalidAccount));
    assert_eq!(s.save("a", &json!([{"name": "c_user", "value": SECRET_A}])).await, Err(CookieError::MissingRequired));
    assert_eq!(s.save("a", &json!("x")).await, Err(CookieError::InvalidCookies));
    assert_eq!(s.save("a", &json!([{"name": "xs", "value": "a b"}])).await, Err(CookieError::InvalidCookies));
    let too_long = "x".repeat(2049);
    assert_eq!(s.save("a", &json!([{"name": "xs", "value": too_long}])).await, Err(CookieError::InvalidCookies));
    assert!(mem.map.lock().unwrap().is_empty());
    // io lỗi -> mã cố định, status không lộ giá trị
    let bad = Arc::new(MemStore { fail: true, ..Default::default() });
    let e = store(&bad).save("a", &good()).await.unwrap_err();
    assert_eq!(e, CookieError::IoError);
    assert!(!format!("{e:?}{}", e.code()).contains("SECRET"));
    // file hỏng -> present:false; status JSON không chứa giá trị
    mem.map.lock().unwrap().insert("messenger-a".into(), "{not json".into());
    assert!(!s.status("a").await.present);
    s.save("b", &good()).await.unwrap();
    assert!(!s.status("b").await.to_json().to_string().contains("SECRET"));
}

#[tokio::test]
async fn messenger_cookies_clear_op_deletes_only_target_account() {
    let mem = Arc::new(MemStore::default());
    let s = store(&mem);
    s.save("default", &good()).await.unwrap();
    s.save("other", &good()).await.unwrap();
    assert_eq!(s.clear("../x").await, Err(CookieError::InvalidAccount));
    assert_eq!(s.clear("default").await, Ok(()));
    assert_eq!(s.clear("default").await, Ok(())); // xóa lần hai vẫn ok
    assert!(!s.status("default").await.present);
    assert!(s.status("other").await.present);
}

#[tokio::test]
async fn messenger_cookies_clear_rpc_op_result_shape() {
    let mem = Arc::new(MemStore::default());
    store(&mem).save("default", &good()).await.unwrap();
    let ctx = crate::rpc::Ctx { state_dir: std::env::temp_dir(), http: reqwest::Client::new(), secrets: mem.clone() };
    let bad = super::handle("messenger.cookies.clear", json!({"account": "../x"}), &ctx).await.unwrap().unwrap();
    assert_eq!(bad, json!({"ok": false, "reason": "invalid-account"}));
    assert!(mem.map.lock().unwrap().contains_key("messenger-default"));
    let ok = super::handle("messenger.cookies.clear", json!({}), &ctx).await.unwrap().unwrap();
    assert_eq!(ok, json!({"ok": true}));
    assert!(mem.map.lock().unwrap().is_empty());
}

#[test]
fn messenger_sanitize_domain_and_dedup() {
    let out = sanitize_cookies(&json!([{"name": "xs", "value": "v", "domain": "evil.com"}, {"name": "xs", "value": "w", "domain": "m.facebook.com", "path": "/", "expires": 1.5}])).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].value, "w");
    assert_eq!(out[0].domain.as_deref(), Some("m.facebook.com"));
    let bad = sanitize_cookies(&json!([{"name": "xs", "value": "v", "domain": "evil.com"}])).unwrap();
    assert_eq!(bad[0].domain, None);
    assert!(sanitize_cookies(&json!([{"name": "xs", "value": "v", "domain": "notfacebook.com"}])).unwrap()[0].domain.is_none());
    assert!(sanitize_cookies(&Value::Array(vec![json!({"name": "xs", "value": "v"}); 101])).is_none());
}

// ---- Bộ mở trình duyệt giả ----

struct FakeSession {
    polls: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
    after: usize,
}
#[async_trait]
impl BrowserSession for FakeSession {
    async fn cookies(&mut self) -> Result<Vec<Value>, ()> {
        let n = self.polls.fetch_add(1, Ordering::SeqCst);
        if n >= self.after {
            Ok(vec![
                json!({"name": "c_user", "value": SECRET_A, "domain": ".facebook.com"}),
                json!({"name": "xs", "value": SECRET_B, "domain": ".facebook.com"}),
                json!({"name": "c_user", "value": "other", "domain": "evil.com"}),
            ])
        } else {
            Ok(vec![json!({"name": "datr", "value": "d", "domain": ".facebook.com"})])
        }
    }
    async fn close(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

struct FakeLauncher {
    available: bool,
    /// Số lần poll trước khi cookie xuất hiện (usize::MAX = không bao giờ).
    after: usize,
    launched: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
}
impl FakeLauncher {
    fn new(after: usize) -> Arc<Self> {
        Arc::new(Self { available: true, after, launched: Default::default(), closed: Default::default() })
    }
}
#[async_trait]
impl BrowserLauncher for FakeLauncher {
    fn available(&self) -> bool {
        self.available
    }
    async fn launch(&self, url: &str) -> Result<Box<dyn BrowserSession>, LaunchError> {
        assert_eq!(url, FACEBOOK_URL);
        self.launched.store(true, Ordering::SeqCst);
        Ok(Box::new(FakeSession { polls: Default::default(), closed: self.closed.clone(), after: self.after }))
    }
}

fn fast(timeout_ms: u64) -> LoginConfig {
    LoginConfig { timeout: Duration::from_millis(timeout_ms), poll: Duration::from_millis(5) }
}

async fn wait_phase(c: &LoginController, want: Phase) -> LoginStatus {
    for _ in 0..400 {
        let s = c.status();
        if s.phase == want {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("không đạt phase {want:?}, đang {:?}", c.status());
}

#[tokio::test]
async fn messenger_login_succeeds_saves_and_closes() {
    let mem = Arc::new(MemStore::default());
    let l = FakeLauncher::new(2);
    let c = LoginController::new();
    assert_eq!(c.status().phase, Phase::Idle);
    let st = c.start(l.clone(), store(&mem), "default".into(), fast(5000));
    assert_eq!(st.phase, Phase::Running);
    let done = wait_phase(&c, Phase::Succeeded).await;
    assert_eq!(done.reason, None);
    assert!(l.closed.load(Ordering::SeqCst));
    assert!(store(&mem).status("default").await.present);
    // cookie ngoài miền facebook bị loại; status không có giá trị
    let loaded = store(&mem).load("default").await.unwrap();
    assert!(loaded.iter().all(|x| x.value != "other"));
    assert!(!done.to_json().to_string().contains("SECRET"));
}

#[tokio::test]
async fn messenger_login_timeout_fails_and_closes() {
    let mem = Arc::new(MemStore::default());
    let l = FakeLauncher::new(usize::MAX);
    let c = LoginController::new();
    c.start(l.clone(), store(&mem), "default".into(), fast(40));
    let s = wait_phase(&c, Phase::Failed).await;
    assert_eq!(s.reason, Some("timeout"));
    assert!(l.closed.load(Ordering::SeqCst));
    assert!(!store(&mem).status("default").await.present);
}

#[tokio::test]
async fn messenger_login_cancel_closes_browser() {
    let mem = Arc::new(MemStore::default());
    let l = FakeLauncher::new(usize::MAX);
    let c = LoginController::new();
    c.start(l.clone(), store(&mem), "default".into(), fast(60_000));
    // start khi đang chạy không mở phiên thứ hai
    assert_eq!(c.start(l.clone(), store(&mem), "default".into(), fast(60_000)).phase, Phase::Running);
    tokio::time::sleep(Duration::from_millis(30)).await;
    let s = c.cancel().await;
    assert_eq!(s.phase, Phase::Cancelled);
    assert!(l.closed.load(Ordering::SeqCst));
    assert_eq!(c.status().phase, Phase::Cancelled);
    // cancel khi không chạy là no-op
    assert_eq!(c.cancel().await.phase, Phase::Cancelled);
    // có thể bắt đầu lại sau khi hủy
    let l2 = FakeLauncher::new(0);
    c.start(l2, store(&mem), "default".into(), fast(5000));
    wait_phase(&c, Phase::Succeeded).await;
}

#[tokio::test]
async fn messenger_login_browser_missing() {
    let mem = Arc::new(MemStore::default());
    let l = Arc::new(FakeLauncher { available: false, after: 0, launched: Default::default(), closed: Default::default() });
    let c = LoginController::new();
    let s = c.start(l.clone(), store(&mem), "default".into(), fast(100));
    assert_eq!(s.phase, Phase::Failed);
    assert_eq!(s.reason, Some("browser-missing"));
    assert!(!l.launched.load(Ordering::SeqCst));
    assert_eq!(s.to_json(), json!({"phase": "failed", "reason": "browser-missing"}));
}

#[tokio::test]
async fn messenger_login_save_failure_is_failed() {
    let bad = Arc::new(MemStore { fail: true, ..Default::default() });
    let l = FakeLauncher::new(0);
    let c = LoginController::new();
    c.start(l.clone(), store(&bad), "default".into(), fast(5000));
    let s = wait_phase(&c, Phase::Failed).await;
    assert_eq!(s.reason, Some("save-failed"));
    assert!(l.closed.load(Ordering::SeqCst));
}
