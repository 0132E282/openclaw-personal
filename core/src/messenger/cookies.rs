//! Kho cookie Messenger qua `SecretStore` (khóa `messenger-<accountId>`). Port từ `cookieStore.ts`.
//! Giá trị cookie không bao giờ vào lỗi, log hay output RPC; `status` chỉ trả `{present, savedAt}`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use crate::secrets::SecretStore;

pub const REQUIRED_COOKIES: [&str; 2] = ["c_user", "xs"];
/// Chỉ giữ cookie cần cho phiên.
pub const KEPT_COOKIES: [&str; 5] = ["c_user", "xs", "datr", "fr", "sb"];
pub const MAX_COOKIE_VALUE_LENGTH: usize = 2048;
const MAX_COOKIES: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredCookie {
    pub name: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(default, rename = "httpOnly", skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieError {
    InvalidAccount,
    InvalidCookies,
    MissingRequired,
    IoError,
}

impl CookieError {
    /// Mã lỗi cố định, không chứa dữ liệu.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidAccount => "invalid-account",
            Self::InvalidCookies => "invalid-cookies",
            Self::MissingRequired => "missing-required",
            Self::IoError => "io-error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CookieStatus {
    pub present: bool,
    pub saved_at: Option<u64>,
}

impl CookieStatus {
    pub fn to_json(self) -> Value {
        serde_json::json!({"present": self.present, "savedAt": self.saved_at})
    }
}

#[derive(Serialize, Deserialize)]
struct Record {
    #[serde(rename = "savedAt")]
    saved_at: u64,
    cookies: Vec<StoredCookie>,
}

/// `^[a-z0-9_-]{1,40}$`
pub fn valid_account(account: &str) -> bool {
    (1..=40).contains(&account.len()) && account.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// `^\.?([a-z0-9-]+\.)*facebook\.com$` (không phân biệt hoa thường).
fn facebook_domain(d: &str) -> bool {
    let d = d.to_ascii_lowercase();
    let d = d.strip_prefix('.').unwrap_or(&d);
    if d == "facebook.com" {
        return true;
    }
    match d.strip_suffix(".facebook.com") {
        Some(prefix) => prefix.split('.').all(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')),
        None => false,
    }
}

/// Chuẩn hóa danh sách cookie đầu vào; `None` nếu sai dạng. Không lộ giá trị.
pub fn sanitize_cookies(input: &Value) -> Option<Vec<StoredCookie>> {
    let arr = input.as_array().filter(|a| a.len() <= MAX_COOKIES)?;
    let mut out: Vec<StoredCookie> = Vec::new();
    for raw in arr {
        let obj = raw.as_object()?;
        let name = obj.get("name")?.as_str()?;
        let value = obj.get("value")?.as_str()?;
        if !KEPT_COOKIES.contains(&name) {
            continue;
        }
        let len = value.encode_utf16().count();
        if len == 0 || len > MAX_COOKIE_VALUE_LENGTH || value.chars().any(|c| c.is_whitespace() || c == ';' || c == ',') {
            return None;
        }
        let cookie = StoredCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain: obj.get("domain").and_then(Value::as_str).filter(|d| facebook_domain(d)).map(str::to_string),
            path: obj.get("path").and_then(Value::as_str).filter(|p| p.starts_with('/')).map(str::to_string),
            expires: obj.get("expires").and_then(Value::as_f64).filter(|e| e.is_finite()),
            http_only: obj.get("httpOnly").and_then(Value::as_bool),
            secure: obj.get("secure").and_then(Value::as_bool),
        };
        // Trùng tên: giữ vị trí đầu, giá trị sau thắng (như Map.set).
        match out.iter_mut().find(|c| c.name == name) {
            Some(slot) => *slot = cookie,
            None => out.push(cookie),
        }
    }
    Some(out)
}

#[derive(Clone)]
pub struct CookieStore {
    secrets: Arc<dyn SecretStore>,
    now: fn() -> u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn key(account: &str) -> String {
    format!("messenger-{account}")
}

impl CookieStore {
    pub fn new(secrets: Arc<dyn SecretStore>) -> Self {
        Self { secrets, now: now_ms }
    }

    #[cfg(test)]
    pub fn with_clock(secrets: Arc<dyn SecretStore>, now: fn() -> u64) -> Self {
        Self { secrets, now }
    }

    pub async fn save(&self, account: &str, cookies: &Value) -> Result<(), CookieError> {
        if !valid_account(account) {
            return Err(CookieError::InvalidAccount);
        }
        let clean = sanitize_cookies(cookies).ok_or(CookieError::InvalidCookies)?;
        if !REQUIRED_COOKIES.iter().all(|n| clean.iter().any(|c| c.name == *n)) {
            return Err(CookieError::MissingRequired);
        }
        let text = serde_json::to_string(&Record { saved_at: (self.now)(), cookies: clean }).map_err(|_| CookieError::IoError)?;
        self.secrets.set(&key(account), &text).await.map_err(|_| CookieError::IoError)
    }

    async fn read_record(&self, account: &str) -> Option<Record> {
        let text = self.secrets.get(&key(account)).await.ok()??;
        let rec: Record = serde_json::from_str(&text).ok()?;
        // Kiểm tra lại qua sanitize như bản TS.
        let cookies = sanitize_cookies(&serde_json::to_value(&rec.cookies).ok()?)?;
        Some(Record { saved_at: rec.saved_at, cookies })
    }

    /// Chỉ metadata, an toàn để trả ra UI.
    pub async fn status(&self, account: &str) -> CookieStatus {
        if !valid_account(account) {
            return CookieStatus { present: false, saved_at: None };
        }
        match self.read_record(account).await {
            Some(r) => CookieStatus { present: true, saved_at: Some(r.saved_at) },
            None => CookieStatus { present: false, saved_at: None },
        }
    }

    /// Chỉ dùng phía backend (không đưa vào output RPC).
    #[allow(dead_code)]
    pub async fn load(&self, account: &str) -> Option<Vec<StoredCookie>> {
        if !valid_account(account) {
            return None;
        }
        self.read_record(account).await.map(|r| r.cookies)
    }

    /// Xóa cookie đã lưu của tài khoản (đăng xuất cục bộ); không có cookie thì vẫn thành công.
    pub async fn clear(&self, account: &str) -> Result<(), CookieError> {
        if !valid_account(account) {
            return Err(CookieError::InvalidAccount);
        }
        self.secrets.delete(&key(account)).await.map_err(|_| CookieError::IoError)
    }
}
