//! Kho token Gmail theo tài khoản, lưu qua `SecretStore` (khóa `gmail-<accountId>`) cùng một chỉ mục
//! không chứa bí mật (`gmail-index`). Chỉ `load()` trả token (nội bộ backend); `list()` chỉ trả metadata.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::secrets::SecretStore;

pub const INDEX_KEY: &str = "gmail-index";
const CLIENT_KEY: &str = "gmail-client";

/// Bản ghi token một tài khoản. KHÔNG derive Debug để token không vô tình lọt vào log.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailRecord {
    pub address: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    pub refresh_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    /// epoch ms
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub saved_at: u64,
}

/// Dữ liệu để lưu mới (chưa có `saved_at`).
pub struct NewRecord {
    pub address: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub refresh_token: String,
    pub access_token: Option<String>,
    pub expires_at: Option<u64>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub id: String,
    pub address: String,
    pub saved_at: u64,
    pub needs_reauth: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    InvalidAccount,
    InvalidRecord,
    NotFound,
    Io,
}

impl StoreError {
    pub fn reason(self) -> &'static str {
        match self {
            Self::InvalidAccount => "invalid-account",
            Self::InvalidRecord => "invalid-record",
            Self::NotFound => "not-found",
            Self::Io => "io-error",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    address: String,
    saved_at: u64,
    #[serde(default)]
    needs_reauth: bool,
}
type Index = BTreeMap<String, IndexEntry>;

/// `^g-[0-9a-f]{12}$`
pub fn valid_account_id(id: &str) -> bool {
    id.len() == 14 && id.starts_with("g-") && id[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// id ổn định từ địa chỉ email: `g-` + 12 hex đầu của sha256(địa chỉ thường hóa).
pub fn account_id(address: &str) -> String {
    let d = Sha256::digest(address.trim().to_lowercase().as_bytes());
    let hex: String = d.iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("g-{hex}")
}

fn record_key(id: &str) -> String {
    format!("gmail-{id}")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct TokenStore {
    secrets: Arc<dyn SecretStore>,
    /// Tuần tự hóa các thao tác đọc-sửa-ghi để không chen nhau.
    lock: tokio::sync::Mutex<()>,
    now: fn() -> u64,
}

impl TokenStore {
    pub fn new(secrets: Arc<dyn SecretStore>) -> Self {
        Self { secrets, lock: tokio::sync::Mutex::new(()), now: now_ms }
    }

    /// Lưu Client ID/secret ngay khi bắt đầu đăng nhập để lần sau không phải nhập lại, kể cả khi đăng nhập chưa xong.
    pub async fn save_client(&self, client_id: &str, client_secret: Option<&str>) -> Result<(), StoreError> {
        let text = serde_json::to_string(&serde_json::json!({"clientId": client_id, "clientSecret": client_secret})).map_err(|_| StoreError::Io)?;
        self.secrets.set(CLIENT_KEY, &text).await.map_err(|_| StoreError::Io)
    }

    pub async fn load_client(&self) -> Option<(String, Option<String>)> {
        let v: serde_json::Value = serde_json::from_str(&self.secrets.get(CLIENT_KEY).await.ok()??).ok()?;
        let id = v.get("clientId")?.as_str().filter(|s| !s.is_empty())?.to_string();
        Some((id, v.get("clientSecret").and_then(|s| s.as_str()).filter(|s| !s.is_empty()).map(str::to_string)))
    }

    /// Nhập tài khoản từ kho file cũ của bản TypeScript (`gmail-<id>.json`). Không xóa file cũ, bỏ qua tài khoản đã có. Trả số tài khoản đã nhập.
    pub async fn import_legacy(&self, dir: &std::path::Path) -> usize {
        let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
        let mut n = 0;
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_prefix("gmail-").and_then(|r| r.strip_suffix(".json")).filter(|i| valid_account_id(i)) else { continue };
            if self.load(id).await.is_some() {
                continue;
            }
            let Some(v) = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { continue };
            let str_of = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
            let (Some(address), Some(client_id), Some(refresh_token)) = (str_of("address"), str_of("clientId"), str_of("refreshToken")) else { continue };
            let rec = NewRecord { address, client_id, client_secret: str_of("clientSecret"), refresh_token, access_token: str_of("accessToken"), expires_at: v.get("expiresAt").and_then(|x| x.as_u64()), scope: str_of("scope") };
            if self.save(rec).await.is_ok() {
                n += 1;
            }
        }
        n
    }

    async fn read_index(&self) -> Result<Index, StoreError> {
        match self.secrets.get(INDEX_KEY).await {
            Ok(None) => Ok(Index::new()),
            Ok(Some(text)) => {
                let idx: Index = serde_json::from_str(&text).unwrap_or_default();
                Ok(idx.into_iter().filter(|(id, _)| valid_account_id(id)).collect())
            }
            Err(_) => Err(StoreError::Io),
        }
    }

    async fn write_index(&self, idx: &Index) -> Result<(), StoreError> {
        let text = serde_json::to_string(idx).map_err(|_| StoreError::Io)?;
        self.secrets.set(INDEX_KEY, &text).await.map_err(|_| StoreError::Io)
    }

    /// Lưu mới/ghi đè (đăng nhập lại) và xóa cờ needsReauth. Trả id, không trả token.
    pub async fn save(&self, input: NewRecord) -> Result<String, StoreError> {
        let _g = self.lock.lock().await;
        if input.address.is_empty() || input.client_id.is_empty() || input.refresh_token.is_empty() {
            return Err(StoreError::InvalidRecord);
        }
        let id = account_id(&input.address);
        let rec = GmailRecord {
            address: input.address.clone(),
            client_id: input.client_id,
            client_secret: input.client_secret,
            refresh_token: input.refresh_token,
            access_token: input.access_token,
            expires_at: input.expires_at,
            scope: input.scope,
            saved_at: (self.now)(),
        };
        let text = serde_json::to_string(&rec).map_err(|_| StoreError::Io)?;
        self.secrets.set(&record_key(&id), &text).await.map_err(|_| StoreError::Io)?;
        let mut idx = self.read_index().await.unwrap_or_default();
        idx.insert(id.clone(), IndexEntry { address: input.address, saved_at: rec.saved_at, needs_reauth: false });
        self.write_index(&idx).await?;
        Ok(id)
    }

    async fn load_unlocked(&self, id: &str) -> Option<GmailRecord> {
        if !valid_account_id(id) {
            return None;
        }
        let text = self.secrets.get(&record_key(id)).await.ok().flatten()?;
        serde_json::from_str(&text).ok()
    }

    /// CHỈ dùng phía backend; không đưa vào output của operation.
    pub async fn load(&self, id: &str) -> Option<GmailRecord> {
        self.load_unlocked(id).await
    }

    pub async fn update_access(&self, id: &str, access_token: &str, expires_at: u64, refresh_token: Option<&str>, scope: Option<&str>) -> Result<(), StoreError> {
        let _g = self.lock.lock().await;
        if !valid_account_id(id) {
            return Err(StoreError::InvalidAccount);
        }
        let mut rec = self.load_unlocked(id).await.ok_or(StoreError::NotFound)?;
        rec.access_token = Some(access_token.to_string());
        rec.expires_at = Some(expires_at);
        if let Some(r) = refresh_token.filter(|r| !r.is_empty()) {
            rec.refresh_token = r.to_string();
        }
        if let Some(s) = scope.filter(|s| !s.is_empty()) {
            rec.scope = Some(s.to_string());
        }
        let text = serde_json::to_string(&rec).map_err(|_| StoreError::Io)?;
        self.secrets.set(&record_key(id), &text).await.map_err(|_| StoreError::Io)
    }

    pub async fn mark_reauth(&self, id: &str) -> Result<(), StoreError> {
        let _g = self.lock.lock().await;
        if !valid_account_id(id) {
            return Err(StoreError::InvalidAccount);
        }
        let mut idx = self.read_index().await?;
        idx.get_mut(id).ok_or(StoreError::NotFound)?.needs_reauth = true;
        self.write_index(&idx).await
    }

    /// Chỉ metadata, an toàn trả ra UI.
    pub async fn list(&self) -> Vec<AccountStatus> {
        let _g = self.lock.lock().await;
        match self.read_index().await {
            Ok(idx) => idx.into_iter().map(|(id, e)| AccountStatus { id, address: e.address, saved_at: e.saved_at, needs_reauth: e.needs_reauth }).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub async fn remove(&self, id: &str) -> Result<(), StoreError> {
        let _g = self.lock.lock().await;
        if !valid_account_id(id) {
            return Err(StoreError::InvalidAccount);
        }
        self.secrets.delete(&record_key(id)).await.map_err(|_| StoreError::Io)?;
        let mut idx = self.read_index().await.unwrap_or_default();
        idx.remove(id);
        self.write_index(&idx).await
    }
}
