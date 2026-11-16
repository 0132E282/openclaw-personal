//! Kho bí mật bằng SQLite (`<state_dir>/core.db`): một file, đọc/ghi nhanh, giao dịch nguyên tử.
//!
//! Lần mở đầu tiên tự nhập các file cũ trong `<state_dir>/secrets` (kho dạng file) rồi xóa chúng.

use crate::secrets::{valid_key, SecretError, SecretStore};
use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct SqliteSecretStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteSecretStore {
    pub fn open(state_dir: &Path) -> Result<Self, SecretError> {
        std::fs::create_dir_all(state_dir).map_err(|_| SecretError::Io)?;
        let db = state_dir.join("core.db");
        let conn = Connection::open(&db).map_err(|_| SecretError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600));
        }
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;",
        )
        .map_err(|_| SecretError::Io)?;
        let store = Self { conn: Arc::new(Mutex::new(conn)) };
        store.import_legacy(&state_dir.join("secrets"));
        Ok(store)
    }

    /// Nhập file cũ (khóa hợp lệ, không ghi đè khóa đã có), xóa file đã nhập thành công.
    fn import_legacy(&self, dir: &Path) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        for e in rd.flatten() {
            let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
            if !valid_key(&name) {
                continue;
            }
            let Ok(value) = std::fs::read_to_string(e.path()) else { continue };
            let ok = conn
                .execute("INSERT OR IGNORE INTO secrets (key, value) VALUES (?1, ?2)", params![name, value])
                .is_ok();
            if ok {
                let _ = std::fs::remove_file(e.path());
            }
        }
        let _ = std::fs::remove_dir(dir); // chỉ xóa được khi đã rỗng
    }

    async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> Result<T, SecretError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let c = conn.lock().unwrap_or_else(|e| e.into_inner());
            f(&c).map_err(|_| SecretError::Io)
        })
        .await
        .map_err(|_| SecretError::Io)?
    }
}

fn check(key: &str) -> Result<(), SecretError> {
    if valid_key(key) { Ok(()) } else { Err(SecretError::InvalidKey) }
}

#[async_trait]
impl SecretStore for SqliteSecretStore {
    async fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        check(key)?;
        let k = key.to_string();
        self.run(move |c| c.query_row("SELECT value FROM secrets WHERE key = ?1", [k], |r| r.get(0)).optional()).await
    }
    async fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        check(key)?;
        let (k, v) = (key.to_string(), value.to_string());
        self.run(move |c| {
            c.execute("INSERT INTO secrets (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![k, v])
                .map(|_| ())
        })
        .await
    }
    async fn delete(&self, key: &str) -> Result<(), SecretError> {
        check(key)?;
        let k = key.to_string();
        self.run(move |c| c.execute("DELETE FROM secrets WHERE key = ?1", [k]).map(|_| ())).await
    }
    async fn list(&self, prefix: &str) -> Result<Vec<String>, SecretError> {
        // Tiền tố so sánh bằng substr để ký tự `%`/`_` không bị hiểu là ký tự đại diện.
        let p = prefix.to_string();
        self.run(move |c| {
            let mut st = c.prepare("SELECT key FROM secrets WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key")?;
            let rows = st.query_map([p], |r| r.get::<_, String>(0))?;
            rows.collect()
        })
        .await
    }
}
