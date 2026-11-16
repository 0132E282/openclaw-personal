use async_trait::async_trait;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::chat::{ChatPage, PageError, PageLauncher};
use super::cookies::{CookieStore, StoredCookie};
use super::e2ee::*;
use super::login::{LaunchError, Phase};
use crate::secrets::{SecretError, SecretStore};

#[derive(Default)]
struct MemorySecretStore(Mutex<std::collections::HashMap<String, String>>);
#[async_trait]
impl SecretStore for MemorySecretStore {
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

#[derive(Default)]
struct St {
    gotos: Vec<String>,
    closed: usize,
    window_open: bool,
}

struct Page(Arc<Mutex<St>>);

#[async_trait]
impl ChatPage for Page {
    async fn goto(&mut self, url: &str) -> Result<(), PageError> {
        self.0.lock().unwrap().gotos.push(url.into());
        Ok(())
    }
    async fn url(&mut self) -> Result<String, PageError> {
        if self.0.lock().unwrap().window_open {
            Ok(MESSAGES_URL.into())
        } else {
            Err(PageError::Failed)
        }
    }
    async fn eval(&mut self, _: &str) -> Result<String, PageError> {
        Ok("{}".into())
    }
    async fn type_and_enter(&mut self, _: &str, _: &str) -> Result<(), PageError> {
        Ok(())
    }
    async fn close(&mut self) {
        self.0.lock().unwrap().closed += 1;
    }
}

struct Launcher {
    st: Arc<Mutex<St>>,
    available: bool,
}

#[async_trait]
impl PageLauncher for Launcher {
    fn available(&self) -> bool {
        self.available
    }
    async fn open(&self, cookies: &[StoredCookie]) -> Result<Box<dyn ChatPage>, LaunchError> {
        assert!(!cookies.is_empty());
        Ok(Box::new(Page(self.st.clone())))
    }
}

async fn store() -> CookieStore {
    let s = CookieStore::new(Arc::new(MemorySecretStore::default()));
    s.save("default", &json!([{"name": "c_user", "value": "u"}, {"name": "xs", "value": "x"}])).await.unwrap();
    s
}

fn cfg() -> E2eeConfig {
    E2eeConfig { timeout: Duration::from_millis(400), poll: Duration::from_millis(10) }
}

fn counter() -> (Arc<AtomicUsize>, After) {
    let n = Arc::new(AtomicUsize::new(0));
    let n2 = n.clone();
    (n, Box::new(move || Box::pin(async move { n2.fetch_add(1, Ordering::SeqCst); })))
}

async fn wait_phase(c: &E2eeController, p: Phase) {
    for _ in 0..200 {
        if c.status().phase == p {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("phase {:?}", c.status().phase);
}

#[tokio::test]
async fn mo_cua_so_roi_thanh_cong_khi_nguoi_dung_dong() {
    let st = Arc::new(Mutex::new(St { window_open: true, ..Default::default() }));
    let c = E2eeController::new();
    let (n, after) = counter();
    let s = c.start(Arc::new(Launcher { st: st.clone(), available: true }), store().await, cfg(), after);
    assert_eq!(s.phase, Phase::Running);
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(c.status().phase, Phase::Running);
    assert_eq!(st.lock().unwrap().gotos, [MESSAGES_URL]);
    st.lock().unwrap().window_open = false;
    wait_phase(&c, Phase::Succeeded).await;
    assert_eq!((n.load(Ordering::SeqCst), st.lock().unwrap().closed), (1, 1));
}

#[tokio::test]
async fn het_gio_va_huy() {
    let st = Arc::new(Mutex::new(St { window_open: true, ..Default::default() }));
    let c = E2eeController::new();
    let (n, after) = counter();
    c.start(Arc::new(Launcher { st: st.clone(), available: true }), store().await, cfg(), after);
    wait_phase(&c, Phase::Failed).await;
    assert_eq!(c.status().reason, Some("timeout"));
    assert_eq!(n.load(Ordering::SeqCst), 1);

    let (n, after) = counter();
    c.start(Arc::new(Launcher { st: st.clone(), available: true }), store().await, E2eeConfig { timeout: Duration::from_secs(30), poll: Duration::from_millis(10) }, after);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(c.cancel().await.phase, Phase::Cancelled);
    assert_eq!((n.load(Ordering::SeqCst), st.lock().unwrap().closed), (1, 2));
}

#[tokio::test]
async fn thieu_trinh_duyet_hoac_cookie() {
    let st = Arc::new(Mutex::new(St::default()));
    let c = E2eeController::new();
    let (_, after) = counter();
    let s = c.start(Arc::new(Launcher { st: st.clone(), available: false }), store().await, cfg(), after);
    assert_eq!((s.phase, s.reason), (Phase::Failed, Some("browser-missing")));
    let c = E2eeController::new();
    let (_, after) = counter();
    c.start(Arc::new(Launcher { st, available: true }), CookieStore::new(Arc::new(MemorySecretStore::default())), cfg(), after);
    wait_phase(&c, Phase::Failed).await;
    assert_eq!(c.status().reason, Some("launch-failed"));
}
