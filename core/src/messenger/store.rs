//! Kho SQLite cho Messenger (`<state_dir>/messenger.sqlite3`): hội thoại, tin nhắn và trạng thái phiên.
//! Dùng để trả dữ liệu ngay khi còn mới và làm phương án dự phòng khi trình duyệt headless chậm/treo.
//! KHÔNG lưu cookie hay bí mật (cookie vẫn nằm trong kho bí mật). Mọi SQL đều có tham số.
//! Gọi từ async qua `spawn_blocking`; mỗi thao tác giữ khóa kết nối rất ngắn.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use super::selectors::{AccountInfo, Conversation, Message};

pub const MAX_CONVERSATIONS: usize = 500;
pub const MAX_MESSAGES: usize = 200;
const SCHEMA_VERSION: i64 = 1;

/// Hàng `sessions`: một dòng mỗi tài khoản; thời điểm là giây Unix.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionRow {
    /// `ok` | `error`
    pub state: String,
    pub last_ok_at: i64,
    pub last_error: String,
    pub account_name: String,
    pub account_avatar: String,
    pub account_at: i64,
    pub convs_at: i64,
    pub e2ee_hidden: usize,
}

#[derive(Clone)]
pub struct MessengerStore {
    conn: Arc<Mutex<Connection>>,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl MessengerStore {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;")?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if v < SCHEMA_VERSION {
            // Chỉ là bộ nhớ đệm: đổi schema thì tạo lại, không cần migrate.
            conn.execute_batch(
                "DROP TABLE IF EXISTS conversations; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS sessions;
                 CREATE TABLE conversations (
                   id TEXT PRIMARY KEY, ord INTEGER NOT NULL, title TEXT NOT NULL, snippet TEXT NOT NULL,
                   time TEXT NOT NULL, unread INTEGER NOT NULL, is_group INTEGER NOT NULL, avatar TEXT NOT NULL,
                   updated_at INTEGER NOT NULL) WITHOUT ROWID;
                 CREATE TABLE messages (
                   conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, ord INTEGER NOT NULL,
                   from_me INTEGER NOT NULL, sender_name TEXT NOT NULL, text TEXT NOT NULL, time TEXT NOT NULL,
                   seen_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, message_id)) WITHOUT ROWID;
                 CREATE INDEX messages_by_conv ON messages (conversation_id, ord);
                 CREATE TABLE sessions (
                   account TEXT PRIMARY KEY, state TEXT NOT NULL, last_ok_at INTEGER NOT NULL, last_error TEXT NOT NULL,
                   account_name TEXT NOT NULL, account_avatar TEXT NOT NULL, account_at INTEGER NOT NULL,
                   convs_at INTEGER NOT NULL, e2ee_hidden INTEGER NOT NULL) WITHOUT ROWID;",
            )?;
            conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
        }
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    async fn run<T: Send + 'static>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static) -> Option<T> {
        let conn = self.conn.clone();
        let r = tokio::task::spawn_blocking(move || {
            let mut c = conn.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut c)
        })
        .await;
        match r {
            Ok(Ok(v)) => Some(v),
            Ok(Err(e)) => {
                eprintln!("[messenger] store: {e}");
                None
            }
            Err(_) => None,
        }
    }

    /// Thay toàn bộ danh sách hội thoại bằng kết quả đọc mới (tối đa `MAX_CONVERSATIONS`) và ghi mốc đọc.
    pub async fn put_conversations(&self, account: &str, list: Vec<Conversation>, e2ee_hidden: usize) {
        let account = account.to_string();
        self.run(move |c| {
            let t = now();
            let tx = c.transaction()?;
            tx.execute("DELETE FROM conversations", [])?;
            {
                let mut ins = tx.prepare("INSERT OR REPLACE INTO conversations (id, ord, title, snippet, time, unread, is_group, avatar, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)")?;
                for (i, v) in list.iter().take(MAX_CONVERSATIONS).enumerate() {
                    ins.execute(params![v.id, i as i64, v.title, v.snippet, v.time, v.unread, v.is_group, v.avatar, t])?;
                }
            }
            upsert_session(&tx, &account)?;
            tx.execute("UPDATE sessions SET convs_at = ?2, e2ee_hidden = ?3, state = 'ok', last_ok_at = ?2, last_error = '' WHERE account = ?1", params![account, t, e2ee_hidden as i64])?;
            tx.commit()
        })
        .await;
    }

    /// Danh sách đã lưu, thứ tự như lần đọc gần nhất; kèm số giây từ lần đọc (None nếu chưa từng đọc).
    pub async fn conversations(&self, account: &str) -> Option<(Vec<Conversation>, usize, i64)> {
        let account = account.to_string();
        self.run(move |c| {
            let Some((at, hidden)) = c
                .query_row("SELECT convs_at, e2ee_hidden FROM sessions WHERE account = ?1", [&account], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
                .optional()?
            else {
                return Ok(None);
            };
            if at == 0 {
                return Ok(None);
            }
            let mut st = c.prepare("SELECT id, title, snippet, time, unread, is_group, avatar FROM conversations ORDER BY ord LIMIT ?1")?;
            let rows = st
                .query_map([MAX_CONVERSATIONS as i64], |r| {
                    Ok(Conversation { id: r.get(0)?, title: r.get(1)?, snippet: r.get(2)?, time: r.get(3)?, unread: r.get(4)?, is_group: r.get(5)?, avatar: r.get(6)? })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Some((rows, hidden as usize, (now() - at).max(0))))
        })
        .await
        .flatten()
    }

    /// Thay tin của một hội thoại bằng kết quả đọc mới, giữ tối đa `MAX_MESSAGES` tin mới nhất.
    pub async fn put_messages(&self, conversation_id: &str, list: Vec<Message>) {
        let id = conversation_id.to_string();
        self.run(move |c| {
            let t = now();
            let tx = c.transaction()?;
            tx.execute("DELETE FROM messages WHERE conversation_id = ?1", [&id])?;
            {
                let mut ins = tx.prepare("INSERT OR REPLACE INTO messages (conversation_id, message_id, ord, from_me, sender_name, text, time, seen_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")?;
                let skip = list.len().saturating_sub(MAX_MESSAGES);
                for (i, m) in list.iter().enumerate().skip(skip) {
                    ins.execute(params![id, m.id, i as i64, m.from_me, m.sender_name, m.text, m.time, t])?;
                }
            }
            tx.commit()
        })
        .await;
    }

    /// Thêm một tin (ví dụ tin vừa gửi) vào cuối hội thoại rồi cắt về `MAX_MESSAGES`.
    pub async fn append_message(&self, conversation_id: &str, m: Message) {
        let id = conversation_id.to_string();
        self.run(move |c| {
            let tx = c.transaction()?;
            let next: i64 = tx.query_row("SELECT COALESCE(MAX(ord), -1) + 1 FROM messages WHERE conversation_id = ?1", [&id], |r| r.get(0))?;
            tx.execute(
                "INSERT OR REPLACE INTO messages (conversation_id, message_id, ord, from_me, sender_name, text, time, seen_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![id, m.id, next, m.from_me, m.sender_name, m.text, m.time, now()],
            )?;
            tx.execute(
                "DELETE FROM messages WHERE conversation_id = ?1 AND ord <= (SELECT ord FROM messages WHERE conversation_id = ?1 ORDER BY ord DESC LIMIT 1 OFFSET ?2)",
                params![id, MAX_MESSAGES as i64],
            )?;
            tx.commit()
        })
        .await;
    }

    /// Tin đã lưu theo thứ tự; kèm số giây từ lần ghi gần nhất. `None` nếu hội thoại chưa có tin lưu.
    pub async fn messages(&self, conversation_id: &str) -> Option<(Vec<Message>, i64)> {
        let id = conversation_id.to_string();
        self.run(move |c| {
            let mut st = c.prepare("SELECT message_id, from_me, sender_name, text, time, seen_at FROM messages WHERE conversation_id = ?1 ORDER BY ord LIMIT ?2")?;
            let mut newest = 0i64;
            let rows = st
                .query_map(params![id, MAX_MESSAGES as i64], |r| {
                    newest = newest.max(r.get::<_, i64>(5)?);
                    Ok(Message { id: r.get(0)?, from_me: r.get(1)?, sender_name: r.get(2)?, text: r.get(3)?, time: r.get(4)? })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(if rows.is_empty() { None } else { Some((rows, (now() - newest).max(0))) })
        })
        .await
        .flatten()
    }

    pub async fn put_account(&self, account: &str, info: &AccountInfo) {
        let (account, info) = (account.to_string(), info.clone());
        self.run(move |c| {
            upsert_session(c, &account)?;
            c.execute("UPDATE sessions SET account_name = ?2, account_avatar = ?3, account_at = ?4 WHERE account = ?1", params![account, info.name, info.avatar, now()])
        })
        .await;
    }

    pub async fn account(&self, account: &str) -> Option<(AccountInfo, i64)> {
        let account = account.to_string();
        self.run(move |c| {
            c.query_row("SELECT account_name, account_avatar, account_at FROM sessions WHERE account = ?1", [&account], |r| {
                Ok((AccountInfo { name: r.get(0)?, avatar: r.get(1)? }, r.get::<_, i64>(2)?))
            })
            .optional()
        })
        .await
        .flatten()
        .filter(|(i, at)| *at > 0 && !i.name.is_empty()).map(|(i, at)| (i, (now() - at).max(0)))
    }

    /// Ghi lý do lỗi gần nhất (chuỗi cố định như `Reason::as_str`).
    pub async fn note_error(&self, account: &str, reason: &str) {
        let (account, reason) = (account.to_string(), reason.to_string());
        self.run(move |c| {
            upsert_session(c, &account)?;
            c.execute("UPDATE sessions SET state = 'error', last_error = ?2 WHERE account = ?1", params![account, reason])
        })
        .await;
    }

    pub async fn session(&self, account: &str) -> Option<SessionRow> {
        let account = account.to_string();
        self.run(move |c| {
            c.query_row("SELECT state, last_ok_at, last_error, account_name, account_avatar, account_at, convs_at, e2ee_hidden FROM sessions WHERE account = ?1", [&account], |r| {
                Ok(SessionRow { state: r.get(0)?, last_ok_at: r.get(1)?, last_error: r.get(2)?, account_name: r.get(3)?, account_avatar: r.get(4)?, account_at: r.get(5)?, convs_at: r.get(6)?, e2ee_hidden: r.get::<_, i64>(7)? as usize })
            })
            .optional()
        })
        .await
        .flatten()
    }

    /// Đăng xuất/đổi cookie: xóa sạch dữ liệu đã lưu.
    pub async fn clear(&self) {
        self.run(|c| c.execute_batch("DELETE FROM conversations; DELETE FROM messages; DELETE FROM sessions;")).await;
    }
}

fn upsert_session(c: &Connection, account: &str) -> rusqlite::Result<usize> {
    c.execute("INSERT OR IGNORE INTO sessions (account, state, last_ok_at, last_error, account_name, account_avatar, account_at, convs_at, e2ee_hidden) VALUES (?1,'ok',0,'','','',0,0,0)", [account])
}
