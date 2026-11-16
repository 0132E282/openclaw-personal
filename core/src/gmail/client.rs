//! Client REST Gmail mỏng, ánh xạ sang hình dạng Message của UI.
//!
//! Ánh xạ thư mục -> nhãn Gmail: all -> INBOX; unread -> INBOX + UNREAD; spam -> SPAM; trash -> TRASH.
//! `stranger`/`blocked` không có nhãn Gmail gốc: list trả rỗng + supported:false, các hành động
//! block/unblock/accept/deletePermanent trả `unsupported`. Lỗi chỉ mang mã + status HTTP, không mang
//! token hay nội dung phản hồi.

use base64::{engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::future::join_all;
use reqwest::Method;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::oauth::{self, ClientCreds, OAuthError};
use super::tokens::{now_ms, valid_account_id, TokenStore};

pub const API_BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
pub const MAX_LIST: usize = 100;
pub const MAX_PAGES: usize = 5;
pub const MAX_RAW_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECIPIENTS: usize = 100;
const BATCH_MAX: usize = 1000;
const META_CONCURRENCY: usize = 25;

/// Lỗi Gmail: mã cố định (`reauth-required`, `no-account`, `invalid-input`, `unsupported`, `not-found`,
/// `forbidden`, `bad-request`, `rate-limited`, `server-error`, `network`, `auth-failed`, `invalid-response`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GmailError {
    pub code: &'static str,
    pub status: Option<u16>,
}
impl GmailError {
    pub const fn new(code: &'static str) -> Self {
        Self { code, status: None }
    }
    const fn with(code: &'static str, status: u16) -> Self {
        Self { code, status: Some(status) }
    }
}
impl std::fmt::Display for GmailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
type GResult<T> = Result<T, GmailError>;
const INVALID: GmailError = GmailError::new("invalid-input");

/// None = không hỗ trợ (stranger/blocked).
pub fn folder_labels(folder: &str) -> Option<&'static [&'static str]> {
    match folder {
        "all" => Some(&["INBOX"]),
        "unread" => Some(&["INBOX", "UNREAD"]),
        "spam" => Some(&["SPAM"]),
        "trash" => Some(&["TRASH"]),
        _ => None,
    }
}

pub struct LabelChange {
    pub add: &'static [&'static str],
    pub remove: &'static [&'static str],
}
/// Ok(None) = không hỗ trợ trên Gmail; Err = hành động không biết.
pub fn move_labels(action: &str) -> GResult<Option<LabelChange>> {
    Ok(match action {
        "spam" => Some(LabelChange { add: &["SPAM"], remove: &["INBOX"] }),
        "unspam" => Some(LabelChange { add: &["INBOX"], remove: &["SPAM"] }),
        "trash" => Some(LabelChange { add: &["TRASH"], remove: &["INBOX"] }),
        "restore" => Some(LabelChange { add: &["INBOX"], remove: &["TRASH"] }),
        "block" | "unblock" | "accept" | "deletePermanent" => None,
        _ => return Err(INVALID),
    })
}

/* ---------- mã hóa header / RFC 5322 ---------- */

fn is_ctl(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{a}'..='\u{1f}' | '\u{7f}' | '\u{85}' | '\u{2028}' | '\u{2029}')
}
/// Chống CRLF injection: từ chối mọi ký tự điều khiển (trừ tab) trong giá trị header.
pub fn assert_no_ctl(s: &str) -> GResult<&str> {
    if s.chars().any(is_ctl) {
        Err(INVALID)
    } else {
        Ok(s)
    }
}
fn printable_ascii(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// RFC 2047: chia theo ký tự (không cắt giữa code point), mỗi encoded-word <= 75 ký tự.
pub fn encode_header_word(value: &str) -> GResult<String> {
    assert_no_ctl(value)?;
    if printable_ascii(value) && !value.contains("=?") {
        return Ok(value.to_string());
    }
    let mut words: Vec<String> = Vec::new();
    let (mut chunk, mut bytes) = (String::new(), 0usize);
    for ch in value.chars() {
        let n = ch.len_utf8();
        if bytes + n > 45 {
            words.push(std::mem::take(&mut chunk));
            bytes = 0;
        }
        chunk.push(ch);
        bytes += n;
    }
    if !chunk.is_empty() {
        words.push(chunk);
    }
    Ok(words.iter().map(|w| format!("=?UTF-8?B?{}?=", STANDARD.encode(w.as_bytes()))).collect::<Vec<_>>().join("\r\n "))
}

fn is_addr(s: &str) -> bool {
    let bad = |c: char| c.is_whitespace() || "<>,;\"@()\\".contains(c);
    match s.split_once('@') {
        Some((l, d)) => !l.is_empty() && !d.is_empty() && !l.chars().any(bad) && !d.chars().any(bad),
        None => false,
    }
}
fn unquote(s: &str) -> &str {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

pub fn format_address(input: &str) -> GResult<String> {
    let s = assert_no_ctl(input)?.trim();
    if is_addr(s) {
        return Ok(s.to_string());
    }
    if !s.ends_with('>') {
        return Err(INVALID);
    }
    let lt = s.rfind('<').ok_or(INVALID)?;
    let addr = &s[lt + 1..s.len() - 1];
    if addr.contains(['<', '>']) || !is_addr(addr) {
        return Err(INVALID);
    }
    let name = unquote(s[..lt].trim_end()).trim();
    if name.contains(['"', '\\', '<', '>']) {
        return Err(INVALID);
    }
    if name.is_empty() {
        return Ok(addr.to_string());
    }
    if printable_ascii(name) {
        Ok(format!("\"{name}\" <{addr}>"))
    } else {
        Ok(format!("{} <{addr}>", encode_header_word(name)?))
    }
}

#[derive(Default, Clone)]
pub struct SendInput {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub reply_to_id: Option<String>,
}

fn wrap76(b: &str) -> String {
    b.as_bytes().chunks(76).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("\r\n")
}
fn body_part(ty: &str, content: &str) -> (String, String) {
    (format!("Content-Type: {ty}; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64"), wrap76(&STANDARD.encode(content.as_bytes())))
}

/// Ngày dương lịch từ số ngày kể từ 1970-01-01 (thuật toán civil_from_days).
fn civil(ms: u64) -> (i64, u32, u32, u32, u32, u32, u32, u32) {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    let wd = (days + 4).rem_euclid(7) as u32; // 0 = Chủ nhật
    (y, m, d, (rem / 3600) as u32, (rem % 3600 / 60) as u32, (rem % 60) as u32, wd, (ms % 1000) as u32)
}
pub fn http_date(ms: u64) -> String {
    const WD: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MO: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (y, m, d, h, mi, s, wd, _) = civil(ms);
    format!("{}, {d:02} {} {y:04} {h:02}:{mi:02}:{s:02} GMT", WD[wd as usize], MO[m as usize - 1])
}
pub fn iso_date(ms: u64) -> String {
    let (y, m, d, h, mi, s, _, milli) = civil(ms);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// Dựng thư RFC 5322 (CRLF). Header From do Gmail tự gán theo tài khoản.
pub fn build_raw_message(m: &SendInput, now: u64, random: &dyn Fn(usize) -> Vec<u8>) -> GResult<String> {
    let fmt = |v: &[String]| v.iter().map(|a| format_address(a)).collect::<GResult<Vec<_>>>();
    let (to, cc, bcc) = (fmt(&m.to)?, fmt(&m.cc)?, fmt(&m.bcc)?);
    let total = to.len() + cc.len() + bcc.len();
    if total == 0 || total > MAX_RECIPIENTS {
        return Err(INVALID);
    }
    let text = m.text.as_deref().filter(|s| !s.is_empty());
    let html = m.html.as_deref().filter(|s| !s.is_empty());
    if text.is_none() && html.is_none() {
        return Err(INVALID);
    }
    let mut head = vec!["MIME-Version: 1.0".to_string(), format!("Date: {}", http_date(now))];
    if !to.is_empty() {
        head.push(format!("To: {}", to.join(", ")));
    }
    if !cc.is_empty() {
        head.push(format!("Cc: {}", cc.join(", ")));
    }
    if !bcc.is_empty() {
        head.push(format!("Bcc: {}", bcc.join(", ")));
    }
    head.push(format!("Subject: {}", encode_header_word(&m.subject)?));
    if let Some(v) = m.in_reply_to.as_deref().filter(|s| !s.is_empty()) {
        head.push(format!("In-Reply-To: {}", assert_no_ctl(v)?));
    }
    if let Some(v) = m.references.as_deref().filter(|s| !s.is_empty()) {
        head.push(format!("References: {}", assert_no_ctl(v)?));
    }
    let body = match (text, html) {
        (Some(t), Some(h)) => {
            let b: String = std::iter::once("=_op_".to_string()).chain(random(12).iter().map(|x| format!("{x:02x}"))).collect();
            head.push(format!("Content-Type: multipart/alternative; boundary=\"{b}\""));
            let (th, tb) = body_part("text/plain", t);
            let (hh, hb) = body_part("text/html", h);
            format!("\r\n--{b}\r\n{th}\r\n\r\n{tb}\r\n--{b}\r\n{hh}\r\n\r\n{hb}\r\n--{b}--\r\n")
        }
        (t, h) => {
            let (ph, pb) = match h {
                Some(h) => body_part("text/html", h),
                None => body_part("text/plain", t.unwrap_or_default()),
            };
            head.push(ph);
            format!("\r\n{pb}\r\n")
        }
    };
    let raw = format!("{}\r\n{body}", head.join("\r\n"));
    if raw.len() > MAX_RAW_BYTES {
        return Err(INVALID);
    }
    Ok(raw)
}

/* ---------- phân tích thư Gmail -> Message ---------- */

fn from_b64url(data: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')).ok()
}
fn decode_text(data: &str) -> String {
    from_b64url(data).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
}

fn decode_charset(cs: &str, bytes: Vec<u8>) -> String {
    match cs.to_ascii_lowercase().as_str() {
        "iso-8859-1" | "latin1" | "us-ascii" | "ascii" => bytes.iter().map(|&b| b as char).collect(),
        _ => String::from_utf8_lossy(&bytes).into_owned(),
    }
}
fn decode_q(txt: &str) -> Vec<u8> {
    let b = txt.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'_' => out.push(b' '),
            b'=' if i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() => {
                out.push(u8::from_str_radix(&txt[i + 1..i + 3], 16).unwrap_or(b'?'));
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    out
}

/// Giải mã encoded-word RFC 2047 (B/Q); khoảng trắng giữa hai encoded-word liền nhau bị bỏ.
pub fn decode_mime_words(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    let mut prev_word = false;
    while let Some(start) = rest.find("=?") {
        let (pre, tail) = rest.split_at(start);
        // tail = "=?cs?e?txt?=..."
        let parsed = (|| {
            let body = &tail[2..];
            let (cs, r) = body.split_once('?')?;
            let (enc, r) = r.split_once('?')?;
            let (txt, after) = r.split_once("?=")?;
            if cs.is_empty() || enc.len() != 1 || txt.contains(['?', ' ']) {
                return None;
            }
            let bytes = match enc {
                "b" | "B" => STANDARD.decode(txt).ok()?,
                "q" | "Q" => decode_q(txt),
                _ => return None,
            };
            Some((decode_charset(cs, bytes), after))
        })();
        match parsed {
            Some((decoded, after)) => {
                if !(prev_word && pre.trim().is_empty()) {
                    out.push_str(pre);
                }
                out.push_str(&decoded);
                rest = after;
                prev_word = true;
            }
            None => {
                out.push_str(pre);
                out.push_str("=?");
                rest = &tail[2..];
                prev_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn parse_address_header(h: &str) -> (String, String) {
    let v = decode_mime_words(h);
    let v = v.trim();
    if v.ends_with('>') {
        if let Some(lt) = v.rfind('<') {
            let addr = &v[lt + 1..v.len() - 1];
            if !addr.contains(['<', '>']) && !addr.is_empty() {
                return (unquote(v[..lt].trim_end()).trim().to_string(), addr.trim().to_string());
            }
        }
    }
    (String::new(), v.to_string())
}

fn header_of<'a>(p: &'a Value, name: &str) -> Option<&'a str> {
    p.get("headers")?.as_array()?.iter().find(|h| h.get("name").and_then(Value::as_str).is_some_and(|n| n.eq_ignore_ascii_case(name)))?.get("value")?.as_str()
}

fn collect_bodies(p: &Value, text: &mut Option<String>, html: &mut Option<String>) {
    if let Some(data) = p.pointer("/body/data").and_then(Value::as_str) {
        match p.get("mimeType").and_then(Value::as_str) {
            Some("text/plain") if text.is_none() => *text = Some(decode_text(data)),
            Some("text/html") if html.is_none() => *html = Some(decode_text(data)),
            _ => {}
        }
    }
    for c in p.get("parts").and_then(Value::as_array).into_iter().flatten() {
        collect_bodies(c, text, html);
    }
}

pub fn box_of(labels: &[&str]) -> &'static str {
    if labels.contains(&"TRASH") {
        "trash"
    } else if labels.contains(&"SPAM") {
        "spam"
    } else {
        "inbox"
    }
}

pub fn to_message(account_id: &str, g: &Value, with_body: bool) -> Value {
    let labels: Vec<&str> = g.get("labelIds").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let payload = g.get("payload").unwrap_or(&Value::Null);
    let ms = g.get("internalDate").and_then(Value::as_str).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let (name, address) = parse_address_header(header_of(payload, "From").unwrap_or(""));
    let to: Vec<String> = header_of(payload, "To").unwrap_or("").split(',').map(|a| decode_mime_words(a).trim().to_string()).filter(|a| !a.is_empty()).collect();
    let mut m = json!({
        "id": g.get("id").and_then(Value::as_str).unwrap_or(""),
        "accountId": account_id,
        "box": box_of(&labels),
        "from": {"name": name, "address": address},
        "to": to,
        "subject": decode_mime_words(header_of(payload, "Subject").unwrap_or("")),
        "snippet": g.get("snippet").and_then(Value::as_str).unwrap_or(""),
        "date": iso_date(ms),
        "unread": labels.contains(&"UNREAD"),
    });
    if with_body {
        let (mut text, mut html) = (None, None);
        collect_bodies(payload, &mut text, &mut html);
        if let Some(t) = text {
            m["text"] = Value::String(t);
        }
        if let Some(h) = html {
            m["html"] = Value::String(h);
        }
    }
    m
}

/* ---------- client ---------- */

#[derive(Clone)]
pub struct ClientConfig {
    pub api_base: String,
    pub token_endpoint: String,
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub now: fn() -> u64,
    pub random: fn(usize) -> Vec<u8>,
}
impl Default for ClientConfig {
    fn default() -> Self {
        Self { api_base: API_BASE.into(), token_endpoint: oauth::TOKEN_ENDPOINT.into(), max_retries: 3, base_delay_ms: 500, now: now_ms, random: oauth::random_bytes }
    }
}

struct Inner {
    http: reqwest::Client,
    store: Arc<TokenStore>,
    cfg: ClientConfig,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Clone)]
pub struct GmailClient(Arc<Inner>);

fn valid_msg_id(id: &str) -> GResult<&str> {
    if (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        Ok(id)
    } else {
        Err(INVALID)
    }
}

impl GmailClient {
    pub fn new(http: reqwest::Client, store: Arc<TokenStore>, cfg: ClientConfig) -> Self {
        Self(Arc::new(Inner { http, store, cfg, locks: Mutex::new(HashMap::new()) }))
    }

    /// Làm mới access token; đơn luồng theo tài khoản. `stale` là token vừa bị 401 (không dùng lại).
    async fn refresh(&self, id: &str, stale: Option<&str>) -> GResult<String> {
        let i = &*self.0;
        let lock = i.locks.lock().unwrap().entry(id.to_string()).or_default().clone();
        let _g = lock.lock().await;
        let rec = i.store.load(id).await.ok_or(GmailError::new("no-account"))?;
        let now = (i.cfg.now)();
        if let (Some(a), Some(e)) = (&rec.access_token, rec.expires_at) {
            if Some(a.as_str()) != stale && e.saturating_sub(60_000) > now {
                return Ok(a.clone());
            }
        }
        let creds = ClientCreds { client_id: &rec.client_id, client_secret: rec.client_secret.as_deref() };
        match oauth::refresh_access_token(&i.http, &i.cfg.token_endpoint, now, &creds, &rec.refresh_token).await {
            Ok(t) => {
                i.store.update_access(id, &t.access_token, t.expires_at, Some(&t.refresh_token), Some(&t.scope)).await.map_err(|_| GmailError::new("auth-failed"))?;
                Ok(t.access_token)
            }
            Err(OAuthError("reauth-required")) => {
                let _ = i.store.mark_reauth(id).await;
                Err(GmailError::new("reauth-required"))
            }
            Err(OAuthError("network")) => Err(GmailError::new("network")),
            Err(_) => Err(GmailError::new("auth-failed")),
        }
    }

    async fn token(&self, id: &str) -> GResult<String> {
        if !valid_account_id(id) {
            return Err(GmailError::new("no-account"));
        }
        let rec = self.0.store.load(id).await.ok_or(GmailError::new("no-account"))?;
        if let (Some(a), Some(e)) = (rec.access_token, rec.expires_at) {
            if e.saturating_sub(60_000) > (self.0.cfg.now)() {
                return Ok(a);
            }
        }
        self.refresh(id, None).await
    }

    async fn request(&self, id: &str, method: Method, path: &str, query: &[(&str, String)], body: Option<Value>) -> GResult<Value> {
        let i = &*self.0;
        let mut url = format!("{}{path}", i.cfg.api_base);
        if !query.is_empty() {
            url.push('?');
            url.push_str(&url::form_urlencoded::Serializer::new(String::new()).extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str()))).finish());
        }
        let mut access = self.token(id).await?;
        let (mut refreshed, mut attempt) = (false, 0u32);
        loop {
            let mut req = i.http.request(method.clone(), &url).bearer_auth(&access).header("Accept", "application/json");
            if let Some(b) = &body {
                req = req.header("Content-Type", "application/json").body(b.to_string());
            }
            let res = match req.send().await {
                Ok(r) => r,
                Err(_) => {
                    if attempt < i.cfg.max_retries {
                        tokio::time::sleep(Duration::from_millis(i.cfg.base_delay_ms << attempt)).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(GmailError::new("network"));
                }
            };
            let status = res.status().as_u16();
            if res.status().is_success() {
                return Ok(res.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null));
            }
            if status == 401 {
                if refreshed {
                    return Err(GmailError::with("reauth-required", 401));
                }
                refreshed = true;
                access = self.refresh(id, Some(&access)).await?;
                continue;
            }
            if status == 429 || status >= 500 {
                if attempt >= i.cfg.max_retries {
                    return Err(GmailError::with(if status == 429 { "rate-limited" } else { "server-error" }, status));
                }
                let ra = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<f64>().ok()).filter(|v| *v > 0.0);
                let ms = match ra {
                    Some(s) => ((s * 1000.0) as u64).min(10_000),
                    None => (i.cfg.base_delay_ms << attempt).min(8000),
                };
                tokio::time::sleep(Duration::from_millis(ms)).await;
                attempt += 1;
                continue;
            }
            let code = match status {
                404 => "not-found",
                403 => "forbidden",
                _ => "bad-request",
            };
            return Err(GmailError::with(code, status));
        }
    }

    pub async fn get_profile(&self, id: &str) -> GResult<(String, u64)> {
        let r = self.request(id, Method::GET, "/profile", &[], None).await?;
        let addr = r.get("emailAddress").and_then(Value::as_str).ok_or(GmailError::new("invalid-response"))?;
        Ok((addr.to_string(), r.get("messagesTotal").and_then(Value::as_u64).unwrap_or(0)))
    }

    pub async fn get_message(&self, account_id: &str, id: &str, full: bool) -> GResult<Value> {
        let mut q = vec![("format", if full { "full" } else { "metadata" }.to_string())];
        if !full {
            q.extend(["From", "To", "Subject", "Date"].map(|h| ("metadataHeaders", h.to_string())));
            // Chỉ lấy đúng trường danh sách cần: phản hồi nhỏ hơn nhiều, nhanh hơn.
            q.push(("fields", "id,labelIds,snippet,internalDate,payload/headers".to_string()));
        }
        let g = self.request(account_id, Method::GET, &format!("/messages/{}", valid_msg_id(id)?), &q, None).await?;
        if !g.is_object() {
            return Err(GmailError::new("invalid-response"));
        }
        Ok(to_message(account_id, &g, full))
    }

    /// Trả `{messages, nextPageToken, supported}`.
    pub async fn list_messages(&self, account_id: &str, folder: &str, limit: Option<u64>, page_token: Option<String>) -> GResult<Value> {
        let Some(labels) = folder_labels(folder) else {
            return Ok(json!({"messages": [], "nextPageToken": null, "supported": false}));
        };
        let cap = match limit {
            Some(l) if l > 0 => (l as usize).min(MAX_LIST),
            _ => 25,
        };
        let mut ids: Vec<String> = Vec::new();
        let mut page = page_token;
        for _ in 0..MAX_PAGES {
            if ids.len() >= cap {
                break;
            }
            let mut q = vec![("maxResults", (cap - ids.len()).to_string())];
            q.extend(labels.iter().map(|l| ("labelIds", l.to_string())));
            if folder == "spam" || folder == "trash" {
                q.push(("includeSpamTrash", "true".into()));
            }
            if let Some(p) = &page {
                q.push(("pageToken", p.clone()));
            }
            let r = self.request(account_id, Method::GET, "/messages", &q, None).await?;
            if !r.is_object() {
                return Err(GmailError::new("invalid-response"));
            }
            for m in r.get("messages").and_then(Value::as_array).into_iter().flatten() {
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    if ids.len() < cap {
                        ids.push(id.to_string());
                    }
                }
            }
            page = r.get("nextPageToken").and_then(Value::as_str).map(str::to_string);
            if page.is_none() {
                break;
            }
        }
        let mut messages = Vec::new();
        for chunk in ids.chunks(META_CONCURRENCY) {
            for r in join_all(chunk.iter().map(|id| self.get_message(account_id, id, false))).await {
                messages.push(r?);
            }
        }
        Ok(json!({"messages": messages, "nextPageToken": page, "supported": true}))
    }

    async fn modify_labels(&self, account_id: &str, ids: &[String], add: &[&str], remove: &[&str]) -> GResult<()> {
        let mut clean: Vec<&str> = Vec::new();
        for id in ids {
            let id = valid_msg_id(id)?;
            if !clean.contains(&id) {
                clean.push(id);
            }
        }
        for chunk in clean.chunks(BATCH_MAX) {
            if chunk.len() == 1 {
                self.request(account_id, Method::POST, &format!("/messages/{}/modify", chunk[0]), &[], Some(json!({"addLabelIds": add, "removeLabelIds": remove}))).await?;
            } else {
                self.request(account_id, Method::POST, "/messages/batchModify", &[], Some(json!({"ids": chunk, "addLabelIds": add, "removeLabelIds": remove}))).await?;
            }
        }
        Ok(())
    }

    pub async fn mark_read(&self, account_id: &str, ids: &[String], read: bool) -> GResult<()> {
        if read {
            self.modify_labels(account_id, ids, &[], &["UNREAD"]).await
        } else {
            self.modify_labels(account_id, ids, &["UNREAD"], &[]).await
        }
    }

    pub async fn move_to_folder(&self, account_id: &str, ids: &[String], action: &str) -> GResult<()> {
        let c = move_labels(action)?.ok_or(GmailError::new("unsupported"))?;
        self.modify_labels(account_id, ids, c.add, c.remove).await
    }

    /// Trả `(id, threadId)`.
    pub async fn send(&self, account_id: &str, input: SendInput) -> GResult<(String, Option<String>)> {
        let mut draft = SendInput { in_reply_to: None, references: None, ..input.clone() };
        let mut thread_id: Option<String> = None;
        if let Some(rid) = input.reply_to_id.as_deref().filter(|s| !s.is_empty()) {
            let q = vec![("format", "metadata".to_string()), ("metadataHeaders", "Message-ID".into()), ("metadataHeaders", "References".into())];
            let g = self.request(account_id, Method::GET, &format!("/messages/{}", valid_msg_id(rid)?), &q, None).await?;
            let payload = g.get("payload").unwrap_or(&Value::Null);
            if let Some(mid) = header_of(payload, "Message-ID") {
                let mid = mid.trim();
                draft.in_reply_to = Some(mid.to_string());
                draft.references = Some(match header_of(payload, "References") {
                    Some(r) => format!("{} {mid}", r.trim()),
                    None => mid.to_string(),
                });
            }
            thread_id = g.get("threadId").and_then(Value::as_str).map(str::to_string);
        }
        let raw = build_raw_message(&draft, (self.0.cfg.now)(), &self.0.cfg.random)?;
        let raw = URL_SAFE_NO_PAD.encode(raw.as_bytes());
        let body = match &thread_id {
            Some(t) => json!({"raw": raw, "threadId": t}),
            None => json!({"raw": raw}),
        };
        let r = self.request(account_id, Method::POST, "/messages/send", &[], Some(body)).await?;
        let id = r.get("id").and_then(Value::as_str).ok_or(GmailError::new("invalid-response"))?;
        Ok((id.to_string(), r.get("threadId").and_then(Value::as_str).map(str::to_string)))
    }
}
