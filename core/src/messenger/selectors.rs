//! MỌI selector/đoạn JS đọc giao diện Facebook nằm ở đây, kèm phần chuẩn hóa dữ liệu thô (thuần, test được).
//! Facebook đổi giao diện thì chỉ sửa file này. LƯU Ý: các selector dưới đây là nỗ lực tốt nhất theo cấu trúc
//! đã biết của https://www.facebook.com/messages/; LIST_JS và MESSAGES_JS đã đối chiếu với DOM thật (tiếng Việt).

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::chat::Reason;

pub const MESSAGES_URL: &str = "https://www.facebook.com/messages/";
const THREAD_URL_PREFIX: &str = "https://www.facebook.com/messages/t/";
const E2EE_THREAD_URL_PREFIX: &str = "https://www.facebook.com/messages/e2ee/t/";
/// Tiền tố id hội thoại mã hóa đầu-cuối (giữ nguyên hợp đồng: id vẫn là chuỗi).
pub const E2EE_ID_PREFIX: &str = "e2ee-";

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
    list: !!document.querySelector('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"], [role="grid"], [role="tablist"]'),
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
    let avatar = '';
    for (const im of a.querySelectorAll('img, image')) {
      const u = im.getAttribute('src') || im.getAttribute('xlink:href') || im.getAttribute('href') || '';
      if (/^https:\/\//i.test(u) && u.length <= 600) { avatar = u; break; }
    }
    rows.push({href, lines, unread, avatar, avatars: a.querySelectorAll('img, image').length});
    if (rows.length >= 120) break;
  }
  return JSON.stringify({ready: links.length > 0 || !!document.querySelector('[role="grid"], [role="tablist"]'), rows});
})()"#;

/// Đọc tin của hội thoại đang mở (đã kiểm chứng trên DOM thật của facebook.com/messages/t/<id>): khung tin là
/// `div[role="log"]`; mỗi tin là `[data-scope="messages_table"][data-message-id]` (còn `aria-label` dạng
/// "<thời gian>, <người gửi>: <nội dung>", tùy ngôn ngữ nên chỉ dùng để rút nhãn thời gian). Các phần tử
/// `data-scope="messages_table"` KHÔNG có `data-message-id` là dòng phân cách giờ/tiêu đề, bỏ qua.
/// Tin của mình: thanh `role="toolbar"` (nút phản hồi/biểu cảm) nằm bên TRÁI bong bóng, của đối phương nằm bên phải.
/// Người gửi: `h4` đầu cụm tin của đối phương (các tin liền sau không có `h4` nên lấy lại tên gần nhất).
/// `loading`: còn thanh `role="progressbar"` trong khung chính; `composer`: ô soạn đã có.
pub const MESSAGES_JS: &str = r#"(() => {
  const main = document.querySelector('[role="main"]');
  const loading = !!(main && main.querySelector('[role="progressbar"]'));
  const log = document.querySelector('[role="log"]');
  if (!log) return JSON.stringify({ready: false, loading, composer: false, rows: []});
  const lr = log.getBoundingClientRect();
  const out = [];
  let last = '';
  for (const m of [...log.querySelectorAll('[data-scope="messages_table"][data-message-id]')].slice(-150)) {
    const h = m.querySelector('h4, h5');
    const head = h ? (h.innerText || '').trim() : '';
    const clone = m.cloneNode(true);
    clone.querySelectorAll('h4, h5, [role="toolbar"]').forEach(n => n.remove());
    const text = (clone.textContent || '').trim();
    const mr = m.getBoundingClientRect();
    const bar = m.querySelector('[role="toolbar"]');
    const br = bar ? bar.getBoundingClientRect() : null;
    let mine;
    if (br && br.width > 0) {
      mine = br.left < mr.left + mr.width / 2;
    } else {
      const b = (m.querySelector('span div[role="none"], span div[role="presentation"]') || m).getBoundingClientRect();
      mine = b.left + b.width / 2 > lr.left + lr.width * 0.6;
    }
    if (!mine && head) last = head;
    const label = m.getAttribute('aria-label') || '';
    const pre = text && label.endsWith(text) ? label.slice(0, label.length - text.length) : label;
    const cut = pre.replace(/[:\s]+$/, '');
    const i = cut.lastIndexOf(', ');
    out.push({text, mine, sender: mine ? '' : (head || last), time: i > 0 ? cut.slice(0, i) : ''});
  }
  return JSON.stringify({ready: true, loading, composer: !!document.querySelector('div[role="textbox"][contenteditable="true"]'), rows: out});
})()"#;

/// Nút tài khoản ở góc phải (đã đối chiếu DOM thật, tiếng Việt: `div[role="button"][aria-label="Tài khoản, trang cá nhân của bạn"]`
/// chứa `svg > g > image` là ảnh đại diện của CHÍNH mình). Chọn theo nhãn đa ngôn ngữ + có ảnh bên trong.
macro_rules! account_button_js {
    () => {
        r#"const btn = [...document.querySelectorAll('[role="button"][aria-label]')].find(x => /tài khoản|account|profile|trang cá nhân/i.test(x.getAttribute('aria-label') || '') && x.querySelector('image, img'));
  const imgUrl = el => { const im = el && el.querySelector('image, img'); return im ? (im.getAttribute('xlink:href') || im.getAttribute('href') || im.getAttribute('src') || '') : ''; };
  const card = () => document.querySelector('[role="dialog"] a[href="/me/"]');"#
    };
}

/// Mở menu tài khoản (nếu chưa mở). Tên chỉ có trong menu: thẻ `[role="dialog"] a[href="/me/"]` (dòng đầu là tên mình).
pub const ACCOUNT_OPEN_JS: &str = concat!(
    "(() => {\n  ",
    account_button_js!(),
    r#"
  if (card()) return JSON.stringify({found: true});
  if (!btn) return JSON.stringify({found: false});
  btn.click();
  return JSON.stringify({found: true});
})()"#
);

/// Đọc tên (dòng đầu thẻ `/me/` trong menu) và ảnh đại diện (nút tài khoản, hoặc ảnh trong thẻ `/me/`).
pub const ACCOUNT_READ_JS: &str = concat!(
    "(() => {\n  ",
    account_button_js!(),
    r#"
  const c = card();
  const name = c ? ((c.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '') : '';
  return JSON.stringify({name, avatar: imgUrl(btn), cardAvatar: imgUrl(c)});
})()"#
);

/// Đóng menu tài khoản (bấm lại nút) để không để lại hộp thoại trên trang.
pub const ACCOUNT_CLOSE_JS: &str = concat!(
    "(() => {\n  ",
    account_button_js!(),
    r#"
  if (card() && btn) btn.click();
  return JSON.stringify({});
})()"#
);

/// Tài khoản Facebook đang đăng nhập.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountInfo {
    pub name: String,
    /// URL https ảnh đại diện; rỗng nếu không lấy được.
    pub avatar: String,
}

impl AccountInfo {
    pub fn to_json(&self) -> Value {
        json!({"name": self.name, "avatar": self.avatar})
    }
}

const MAX_ACCOUNT_NAME: usize = 80;

/// Chuẩn hóa kết quả `ACCOUNT_READ_JS`: `Ok(None)` khi menu chưa có tên (đọc lại sau), `Err` khi sai dạng.
/// Ảnh: ưu tiên ảnh ở nút tài khoản, rơi về ảnh trong thẻ `/me/`; cùng bộ lọc host như ảnh hội thoại.
pub fn parse_account(raw: &str) -> Result<Option<AccountInfo>, Reason> {
    let v: Value = serde_json::from_str(raw).map_err(|_| Reason::SelectorBroken)?;
    let name = v.get("name").and_then(Value::as_str).unwrap_or("").trim();
    if name.is_empty() || name.chars().any(char::is_control) {
        return Ok(None);
    }
    let get = |k: &str| avatar_url(v.get(k).and_then(Value::as_str).unwrap_or(""));
    let avatar = Some(get("avatar")).filter(|a| !a.is_empty()).unwrap_or_else(|| get("cardAvatar"));
    Ok(Some(AccountInfo { name: clip(name, MAX_ACCOUNT_NAME), avatar }))
}

/// Ô soạn đã rỗng chưa (xác nhận tin đã gửi đi).
pub const COMPOSER_EMPTY_JS: &str = r#"(() => {
  const c = document.querySelector('div[role="textbox"][contenteditable="true"]');
  return JSON.stringify({found: !!c, empty: !!c && (c.innerText || '').trim() === ''});
})()"#;

/// Địa chỉ trang của một hội thoại; chỉ nhận id số.
/// Chat mã hóa đầu-cuối mở ở `/messages/e2ee/t/<id>/`.
pub fn thread_url(id: &str) -> Option<String> {
    let (num, e2ee) = split_conversation_id(id)?;
    Some(if e2ee { format!("{E2EE_THREAD_URL_PREFIX}{num}/") } else { format!("{THREAD_URL_PREFIX}{num}/") })
}

/// Tách `(id số, là chat mã hóa)` từ id hội thoại `123` hoặc `e2ee-123`; `None` nếu sai dạng.
pub fn split_conversation_id(id: &str) -> Option<(&str, bool)> {
    let (num, e2ee) = match id.strip_prefix(E2EE_ID_PREFIX) {
        Some(rest) => (rest, true),
        None => (id, false),
    };
    ((1..=30).contains(&num.len()) && num.bytes().all(|b| b.is_ascii_digit())).then_some((num, e2ee))
}

/// `^(e2ee-)?[0-9]{1,30}$`: id số của Facebook, chat mã hóa thêm tiền tố `e2ee-`; chặn mọi chuỗi có thể chèn vào URL.
pub fn valid_conversation_id(id: &str) -> bool {
    split_conversation_id(id).is_some()
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
    /// URL https ảnh đại diện (fbcdn/facebook); rỗng nếu không có.
    pub avatar: String,
}

impl Conversation {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "title": self.title, "snippet": self.snippet, "time": self.time, "unread": self.unread, "isGroup": self.is_group, "avatar": self.avatar})
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
    /// Giữ cho tương thích hợp đồng: chat mã hóa nay được liệt kê (id `e2ee-<id>`) nên luôn 0.
    pub e2ee_hidden: usize,
}

const MAX_AVATAR: usize = 600;

/// Chỉ nhận URL https tới host `*.fbcdn.net`, `*.facebook.com` hoặc chứa `scontent`; còn lại (data:, blob:, host lạ) -> rỗng.
/// URL dài quá `MAX_AVATAR` bị bỏ (cắt giữa chừng sẽ hỏng chữ ký).
pub fn avatar_url(raw: &str) -> String {
    let u = raw.trim();
    let Some(rest) = u.strip_prefix("https://") else { return String::new() };
    if u.len() > MAX_AVATAR || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return String::new();
    }
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = rest[..host_end].to_ascii_lowercase();
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return String::new();
    }
    let ok = host.ends_with(".fbcdn.net") || host.ends_with(".facebook.com") || host.contains("scontent");
    if ok { u.to_string() } else { String::new() }
}

/// Chuẩn hóa kết quả `LIST_JS`. `Err(SelectorBroken)` khi dữ liệu sai dạng hoặc trang chưa có khung danh sách.
pub fn parse_conversations(raw: &str) -> Result<ParsedList, Reason> {
    let v: Value = serde_json::from_str(raw).map_err(|_| Reason::SelectorBroken)?;
    if v.get("ready").and_then(Value::as_bool) != Some(true) {
        return Err(Reason::SelectorBroken);
    }
    let rows = v.get("rows").and_then(Value::as_array).ok_or(Reason::SelectorBroken)?;
    let mut out: Vec<Conversation> = Vec::new();
    for row in rows {
        let Some((id, e2ee)) = row.get("href").and_then(Value::as_str).and_then(conversation_id_of_href) else { continue };
        let id = if e2ee { format!("{E2EE_ID_PREFIX}{id}") } else { id };
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
            avatar: avatar_url(row.get("avatar").and_then(Value::as_str).unwrap_or("")),
            is_group: row.get("avatars").and_then(Value::as_u64).unwrap_or(0) > 1,
        });
        if out.len() >= MAX_CONVERSATIONS {
            break;
        }
    }
    Ok(ParsedList { conversations: out, e2ee_hidden: 0 })
}

pub struct ParsedMessages {
    pub messages: Vec<Message>,
    /// Trang còn đang tải (thanh tiến trình trong khung chính).
    pub loading: bool,
}

/// Chuẩn hóa kết quả `MESSAGES_JS`; giữ tối đa `MAX_MESSAGES` tin cuối theo thứ tự cũ -> mới.
/// `Err(SelectorBroken)` khi dữ liệu sai dạng hoặc chưa có khung tin (`ready:false`).
pub fn parse_messages_page(raw: &str) -> Result<ParsedMessages, Reason> {
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
    Ok(ParsedMessages { messages: out.split_off(skip), loading: v.get("loading").and_then(Value::as_bool).unwrap_or(false) })
}

/// Như `parse_messages_page` nhưng chỉ lấy danh sách tin.
pub fn parse_messages(raw: &str) -> Result<Vec<Message>, Reason> {
    parse_messages_page(raw).map(|p| p.messages)
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
    // Chat mã hóa mở được ở `/messages/e2ee/t/<id>`; bị đẩy về `/messages/e2ee/` (không `t/`) tức là đang khóa chờ PIN.
    if p.pin || (thread && url.contains("/messages/e2ee") && !url.contains("/messages/e2ee/t/")) {
        return Err(Reason::E2eeLocked);
    }
    Ok(())
}
