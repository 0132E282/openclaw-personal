//! MỌI selector/đoạn JS đọc giao diện Facebook nằm ở đây, kèm phần chuẩn hóa dữ liệu thô (thuần, test được).
//! Facebook đổi giao diện thì chỉ sửa file này. LƯU Ý: các selector dưới đây là nỗ lực tốt nhất theo cấu trúc
//! đã biết của https://www.facebook.com/messages/ và CHƯA được kiểm chứng trên trang thật.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::chat::Reason;

pub const MESSAGES_URL: &str = "https://www.facebook.com/messages/";
const THREAD_URL_PREFIX: &str = "https://www.facebook.com/messages/t/";

/// Ô soạn tin.
pub const COMPOSER_SELECTOR: &str = r#"div[role="textbox"][contenteditable="true"]"#;

pub const MAX_CONVERSATIONS: usize = 100;
pub const MAX_MESSAGES: usize = 100;
pub const MAX_TEXT: usize = 4000;
const MAX_TITLE: usize = 120;
const MAX_SNIPPET: usize = 200;
const MAX_TIME: usize = 40;
const MAX_ID: usize = 64;

/// Dò trạng thái trang: đăng nhập, danh sách, ô soạn, hộp thoại mã PIN của chat mã hóa đầu-cuối.
pub const PROBE_JS: &str = r#"(() => {
  const dlg = [...document.querySelectorAll('[role="dialog"]')].map(d => d.innerText || '').join(' ');
  return JSON.stringify({
    url: location.href,
    complete: document.readyState === 'complete',
    loginForm: !!document.querySelector('input[name="pass"], form[action*="login"]'),
    list: !!document.querySelector('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"], div[role="navigation"]'),
    composer: !!document.querySelector('div[role="textbox"][contenteditable="true"]'),
    pin: /\bPIN\b/i.test(dlg) && /(end-to-end|đầu-cuối|đầu cuối)/i.test(dlg),
  });
})()"#;

/// Đọc danh sách hội thoại ở cột trái: mỗi dòng là một liên kết `/messages/t/<id>`.
pub const LIST_JS: &str = r#"(() => {
  const links = [...document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]')];
  const seen = new Set();
  const rows = [];
  for (const a of links) {
    const href = a.getAttribute('href') || '';
    if (seen.has(href)) continue;
    seen.add(href);
    const lines = (a.innerText || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 8);
    const spans = [...a.querySelectorAll('span[dir="auto"]')];
    const bold = spans.length > 1 && spans.slice(1).some(s => parseInt(getComputedStyle(s).fontWeight, 10) >= 600);
    const unread = !!a.querySelector('[aria-label*="nread"], [aria-label*="chưa đọc"]') || bold;
    rows.push({href, lines, unread, avatars: a.querySelectorAll('img, image').length});
    if (rows.length >= 120) break;
  }
  return JSON.stringify({ready: links.length > 0 || !!document.querySelector('div[role="navigation"]'), rows});
})()"#;

/// Đọc tin của hội thoại đang mở: các hàng `role="row"` trong khung chính; tin của mình nằm lệch phải.
pub const MESSAGES_JS: &str = r#"(() => {
  const main = document.querySelector('div[role="main"]');
  if (!main) return JSON.stringify({ready: false, rows: []});
  const box = main.getBoundingClientRect();
  const mid = box.left + box.width / 2;
  const out = [];
  for (const r of [...main.querySelectorAll('div[role="row"]')].slice(-150)) {
    const parts = [...r.querySelectorAll('div[dir="auto"]')];
    const text = parts.map(p => (p.innerText || '').trim()).filter(Boolean).join('\n');
    if (!text) continue;
    const rc = (parts[0] || r).getBoundingClientRect();
    const head = r.querySelector('h4, h5');
    out.push({text, mine: rc.left + rc.width / 2 > mid + box.width * 0.1, sender: head ? (head.innerText || '').trim() : ''});
  }
  return JSON.stringify({ready: true, rows: out});
})()"#;

/// Ô soạn đã rỗng chưa (xác nhận tin đã gửi đi).
pub const COMPOSER_EMPTY_JS: &str = r#"(() => {
  const c = document.querySelector('div[role="textbox"][contenteditable="true"]');
  return JSON.stringify({found: !!c, empty: !!c && (c.innerText || '').trim() === ''});
})()"#;

/// Địa chỉ trang của một hội thoại; chỉ nhận id số.
pub fn thread_url(id: &str) -> Option<String> {
    valid_conversation_id(id).then(|| format!("{THREAD_URL_PREFIX}{id}/"))
}

/// `^[0-9]{1,30}$`: id số của Facebook; chặn mọi chuỗi có thể chèn vào URL.
pub fn valid_conversation_id(id: &str) -> bool {
    (1..=30).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub snippet: String,
    /// Nhãn thời gian đúng như Facebook hiển thị (ví dụ "5 phút", "12:30"); không chuẩn hóa được thành ISO.
    pub time: String,
    pub unread: bool,
    pub is_group: bool,
}

impl Conversation {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "title": self.title, "snippet": self.snippet, "time": self.time, "unread": self.unread, "isGroup": self.is_group})
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub id: String,
    pub from_me: bool,
    pub sender_name: String,
    pub text: String,
    pub time: String,
}

impl Message {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "from": if self.from_me { "me" } else { "them" }, "senderName": self.sender_name, "text": self.text, "time": self.time})
    }
}

/// Cắt theo ký tự (không cắt giữa ký tự UTF-8).
pub fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn hash8(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0u8]);
    }
    h.finalize().iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// `(id, là chat mã hóa đầu-cuối)` từ href dạng `/messages/t/123/` hoặc `/messages/e2ee/t/123/`.
pub fn conversation_id_of_href(href: &str) -> Option<(String, bool)> {
    let (rest, e2ee) = if let Some(i) = href.find("/messages/e2ee/t/") {
        (&href[i + "/messages/e2ee/t/".len()..], true)
    } else if let Some(i) = href.find("/messages/t/") {
        (&href[i + "/messages/t/".len()..], false)
    } else {
        return None;
    };
    let id: String = rest.chars().take_while(char::is_ascii_digit).collect();
    valid_conversation_id(&id).then_some((id, e2ee))
}

/// Tách `(đoạn xem trước, nhãn thời gian)` từ các dòng chữ của một hàng hội thoại (sau tiêu đề).
/// Facebook ngăn xem trước và thời gian bằng dòng "·" hoặc bằng " · " trong cùng dòng.
fn snippet_and_time(rest: &[String]) -> (String, String) {
    if let Some(i) = rest.iter().position(|l| l == "·") {
        return (rest[..i].join(" "), rest.get(i + 1).cloned().unwrap_or_default());
    }
    let joined = rest.join(" ");
    match joined.rsplit_once(" · ") {
        Some((s, t)) if t.chars().count() <= 14 => (s.to_string(), t.to_string()),
        _ => (joined, String::new()),
    }
}

pub struct ParsedList {
    pub conversations: Vec<Conversation>,
    /// Số hội thoại mã hóa đầu-cuối bị ẩn (không đọc được nếu chưa nhập mã PIN trên trình duyệt).
    pub e2ee_hidden: usize,
}

/// Chuẩn hóa kết quả `LIST_JS`. `Err(SelectorBroken)` khi dữ liệu sai dạng hoặc trang chưa có khung danh sách.
pub fn parse_conversations(raw: &str) -> Result<ParsedList, Reason> {
    let v: Value = serde_json::from_str(raw).map_err(|_| Reason::SelectorBroken)?;
    if v.get("ready").and_then(Value::as_bool) != Some(true) {
        return Err(Reason::SelectorBroken);
    }
    let rows = v.get("rows").and_then(Value::as_array).ok_or(Reason::SelectorBroken)?;
    let mut out: Vec<Conversation> = Vec::new();
    let mut hidden = 0;
    for row in rows {
        let Some((id, e2ee)) = row.get("href").and_then(Value::as_str).and_then(conversation_id_of_href) else { continue };
        if e2ee {
            hidden += 1;
            continue;
        }
        if out.iter().any(|c| c.id == id) {
            continue;
        }
        let lines: Vec<String> = row
            .get("lines")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        let Some(title) = lines.first().filter(|t| t.as_str() != "·") else { continue };
        let (snippet, time) = snippet_and_time(&lines[1..]);
        out.push(Conversation {
            id,
            title: clip(title, MAX_TITLE),
            snippet: clip(&snippet, MAX_SNIPPET),
            time: clip(&time, MAX_TIME),
            unread: row.get("unread").and_then(Value::as_bool).unwrap_or(false),
            is_group: row.get("avatars").and_then(Value::as_u64).unwrap_or(0) > 1,
        });
        if out.len() >= MAX_CONVERSATIONS {
            break;
        }
    }
    Ok(ParsedList { conversations: out, e2ee_hidden: hidden })
}

/// Chuẩn hóa kết quả `MESSAGES_JS`; giữ tối đa `MAX_MESSAGES` tin cuối theo thứ tự cũ -> mới.
pub fn parse_messages(raw: &str) -> Result<Vec<Message>, Reason> {
    let v: Value = serde_json::from_str(raw).map_err(|_| Reason::SelectorBroken)?;
    if v.get("ready").and_then(Value::as_bool) != Some(true) {
        return Err(Reason::SelectorBroken);
    }
    let rows = v.get("rows").and_then(Value::as_array).ok_or(Reason::SelectorBroken)?;
    let mut out: Vec<Message> = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let text = row.get("text").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if text.is_empty() {
            continue;
        }
        let from_me = row.get("mine").and_then(Value::as_bool).unwrap_or(false);
        let sender = if from_me { "" } else { row.get("sender").and_then(Value::as_str).unwrap_or("").trim() };
        let text = clip(text, MAX_TEXT);
        out.push(Message {
            id: clip(&format!("m{i}-{}", hash8(&[&text, sender])), MAX_ID),
            from_me,
            sender_name: clip(sender, MAX_TITLE),
            text,
            time: clip(row.get("time").and_then(Value::as_str).unwrap_or(""), MAX_TIME),
        });
    }
    let skip = out.len().saturating_sub(MAX_MESSAGES);
    Ok(out.split_off(skip))
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
    pub url: String,
    pub complete: bool,
    pub login_form: bool,
    pub list: bool,
    pub composer: bool,
    pub pin: bool,
}

pub fn parse_probe(raw: &str) -> Result<Probe, Reason> {
    let v: Value = serde_json::from_str(raw).map_err(|_| Reason::SelectorBroken)?;
    let b = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    Ok(Probe { url: v.get("url").and_then(Value::as_str).unwrap_or("").to_string(), complete: b("complete"), login_form: b("loginForm"), list: b("list"), composer: b("composer"), pin: b("pin") })
}

/// Phân loại trang: lý do không đọc được (đăng nhập hết hạn, checkpoint, chat mã hóa cần PIN) hoặc `Ok`.
/// `thread`: đang mở một hội thoại cụ thể (URL `/messages/e2ee/...` mới coi là chat mã hóa bị khóa).
pub fn classify(p: &Probe, thread: bool) -> Result<(), Reason> {
    let url = p.url.to_ascii_lowercase();
    if url.contains("/checkpoint") || url.contains("/two_step_verification") || url.contains("/confirmemail") {
        return Err(Reason::Checkpoint);
    }
    if p.login_form || url.contains("/login") {
        return Err(Reason::NotLoggedIn);
    }
    if p.pin || (thread && url.contains("/messages/e2ee")) {
        return Err(Reason::E2eeLocked);
    }
    Ok(())
}
