//! Test Gmail: không dùng mạng thật hay thông tin đăng nhập thật (wiremock + kho bí mật giả trong bộ nhớ).

use super::client::*;
use super::oauth::*;
use super::tokens::*;
use super::*;
use crate::secrets::{SecretError, SecretStore};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::Notify;
use wiremock::matchers::{body_string_contains, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Default)]
struct MemSecrets(Mutex<HashMap<String, String>>);

#[async_trait]
impl SecretStore for MemSecrets {
    async fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    async fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    async fn delete(&self, key: &str) -> Result<(), SecretError> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
    async fn list(&self, prefix: &str) -> Result<Vec<String>, SecretError> {
        Ok(self.0.lock().unwrap().keys().filter(|k| k.starts_with(prefix)).cloned().collect())
    }
}

const SECRET_WORDS: [&str; 4] = ["old-access", "new-access", "refresh-secret", "client-secret-xyz"];

fn fixed_random(n: usize) -> Vec<u8> {
    (0..n).map(|i| i as u8).collect()
}

fn service(base: &str, open: OpenBrowser) -> Service {
    let secrets: Arc<dyn SecretStore> = Arc::new(MemSecrets::default());
    let http = reqwest::Client::new();
    let cfg = ClientConfig { api_base: format!("{base}/gmail"), token_endpoint: format!("{base}/token"), base_delay_ms: 1, random: fixed_random, ..ClientConfig::default() };
    let (b, h) = (base.to_string(), http.clone());
    Service::new(http, secrets, cfg, move |store, _| AuthConfig {
        http: h.clone(),
        auth_endpoint: format!("{b}/auth"),
        token_endpoint: format!("{b}/token"),
        timeout: Duration::from_secs(10),
        open_browser: open.clone(),
        on_tokens: save_tokens_hook(h.clone(), format!("{b}/gmail"), store),
        now: now_ms,
        random: random_bytes,
    })
}

fn no_browser() -> OpenBrowser {
    Arc::new(|_| Ok(()))
}

async fn seed(svc: &Service, access: Option<&str>, expires_at: Option<u64>) -> String {
    svc.store
        .save(NewRecord {
            address: "Me@Example.com".into(),
            client_id: "client-id-12345".into(),
            client_secret: Some("client-secret-xyz".into()),
            refresh_token: "refresh-secret".into(),
            access_token: access.map(Into::into),
            expires_at,
            scope: None,
        })
        .await
        .unwrap()
}

fn token_ok() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"access_token": "new-access", "expires_in": 3600, "scope": "s"}))
}

fn assert_no_secrets(v: &Value) {
    let s = v.to_string();
    for w in SECRET_WORDS {
        assert!(!s.contains(w), "lộ bí mật {w} trong {s}");
    }
}

#[test]
fn account_id_is_stable_and_lowercased() {
    let id = account_id(" Me@Example.com ");
    assert_eq!(id, account_id("me@example.com"));
    assert!(valid_account_id(&id));
    assert!(!valid_account_id("g-XYZ"));
}

#[test]
fn pkce_matches_rfc7636_vector() {
    assert_eq!(challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    let (v, c) = create_pkce(&random_bytes);
    assert_eq!(v.len(), 43);
    assert_eq!(c, challenge_of(&v));
    let url = build_auth_url("https://a/auth", "cid", "http://127.0.0.1:1/callback", "st", &c);
    assert!(url.contains("code_challenge_method=S256") && url.contains("state=st") && url.contains("gmail.send"));
}

async fn http_get(addr: std::net::SocketAddr, target: &str, host: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes()).await.unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out).await;
    out
}

#[tokio::test]
async fn loopback_binds_localhost_only_and_rejects_state_mismatch() {
    let lb = start_loopback("good".into(), Duration::from_secs(5), Arc::new(Notify::new())).await.unwrap();
    assert!(lb.addr.ip().is_loopback() && lb.addr.ip().to_string() == "127.0.0.1");
    let host = format!("127.0.0.1:{}", lb.addr.port());
    let r = http_get(lb.addr, "/callback?state=evil&code=abc", &host).await;
    assert!(r.starts_with("HTTP/1.1 400"));
    assert_eq!(lb.code.await.unwrap(), Err(OAuthError("state-mismatch")));
}

#[tokio::test]
async fn loopback_accepts_good_state_and_rejects_bad_host() {
    let lb = start_loopback("good".into(), Duration::from_secs(5), Arc::new(Notify::new())).await.unwrap();
    let host = format!("127.0.0.1:{}", lb.addr.port());
    assert!(http_get(lb.addr, "/callback?state=good&code=abc", "evil.example").await.starts_with("HTTP/1.1 404"));
    assert!(http_get(lb.addr, "/other", &host).await.starts_with("HTTP/1.1 404"));
    assert!(http_get(lb.addr, "/callback?state=good&code=abc", &host).await.starts_with("HTTP/1.1 200"));
    assert_eq!(lb.code.await.unwrap(), Ok("abc".to_string()));
}

#[tokio::test]
async fn loopback_times_out_and_cancels() {
    let lb = start_loopback("s".into(), Duration::from_millis(50), Arc::new(Notify::new())).await.unwrap();
    assert_eq!(lb.code.await.unwrap(), Err(OAuthError("timeout")));
    let n = Arc::new(Notify::new());
    let lb = start_loopback("s".into(), Duration::from_secs(5), n.clone()).await.unwrap();
    n.notify_one();
    assert_eq!(lb.code.await.unwrap(), Err(OAuthError("cancelled")));
}

#[tokio::test]
async fn full_auth_flow_saves_account_without_leaking_tokens() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .and(body_string_contains("grant_type=authorization_code"))
        .and(body_string_contains("code_verifier="))
        .and(body_string_contains("client_secret=client-secret-xyz"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access_token": "new-access", "refresh_token": "refresh-secret", "expires_in": 3600, "scope": "s"})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET")).and(path("/gmail/profile")).and(header("authorization", "Bearer new-access")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"emailAddress": "me@example.com"}))).mount(&server).await;
    // "Trình duyệt" giả: đọc redirect_uri + state từ URL rồi gọi callback.
    let open: OpenBrowser = Arc::new(|url| {
        let u = url::Url::parse(url).map_err(|_| ())?;
        let q: HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        let (redirect, state) = (q["redirect_uri"].clone(), q["state"].clone());
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let r = url::Url::parse(&redirect).unwrap();
            let mut s = std::net::TcpStream::connect(("127.0.0.1", r.port().unwrap())).unwrap();
            write!(s, "GET /callback?state={state}&code=thecode HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", r.port().unwrap()).unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
        });
        Ok(())
    });
    let svc = service(&server.uri(), open);
    let r = svc.call("gmail.auth.start", json!({"clientId": "client-id-12345", "clientSecret": "client-secret-xyz"})).await.unwrap().unwrap();
    assert_eq!(r, json!({"state": "waiting"}));
    let mut st = Value::Null;
    for _ in 0..100 {
        st = svc.call("gmail.auth.status", json!({})).await.unwrap().unwrap();
        if st["state"] != "waiting" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(st["state"], "succeeded", "{st}");
    assert_eq!(st["address"], "me@example.com");
    assert_no_secrets(&st);
    let list = svc.call("gmail.accounts.list", json!({})).await.unwrap().unwrap();
    assert_eq!(list["accounts"][0]["needsReauth"], false);
    assert_no_secrets(&list);
    // auth.start không clientId: dùng lại clientId/secret đã lưu.
    let again = svc.call("gmail.auth.start", json!({})).await.unwrap().unwrap();
    assert_eq!(again["state"], "waiting");
    svc.call("gmail.auth.cancel", json!({})).await.unwrap().unwrap();
}

#[tokio::test]
async fn auth_start_with_invalid_client_id_fails_and_cancel_works() {
    let svc = service("http://127.0.0.1:1", no_browser());
    assert_eq!(svc.call("gmail.auth.start", json!({})).await.unwrap().unwrap(), json!({"state": "failed"}));
    let st = svc.call("gmail.auth.status", json!({})).await.unwrap().unwrap();
    assert_eq!(st["reason"], "invalid-input");
    assert_eq!(svc.call("gmail.auth.start", json!({"clientId": "client-id-12345"})).await.unwrap().unwrap()["state"], "waiting");
    assert_eq!(svc.call("gmail.auth.cancel", json!({})).await.unwrap().unwrap()["state"], "cancelled");
}

#[tokio::test]
async fn refresh_on_401_exactly_once_then_succeeds() {
    let server = MockServer::start().await;
    let svc = service(&server.uri(), no_browser());
    let id = seed(&svc, Some("old-access"), Some(now_ms() + 3_600_000)).await;
    Mock::given(method("GET")).and(path("/gmail/messages/m1")).and(header("authorization", "Bearer old-access")).respond_with(ResponseTemplate::new(401)).expect(1).mount(&server).await;
    Mock::given(method("GET"))
        .and(path("/gmail/messages/m1"))
        .and(header("authorization", "Bearer new-access"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "m1", "labelIds": ["INBOX", "UNREAD"], "internalDate": "1700000000000", "snippet": "hi", "payload": {"mimeType": "text/plain", "headers": [{"name": "From", "value": "=?UTF-8?B?w4Fu?= <a@b.co>"}, {"name": "Subject", "value": "x"}], "body": {"data": "aGVsbG8"}}})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST")).and(path("/token")).and(body_string_contains("grant_type=refresh_token")).respond_with(token_ok()).expect(1).mount(&server).await;
    let m = svc.call("gmail.messages.get", json!({"accountId": id, "id": "m1"})).await.unwrap().unwrap();
    assert_eq!(m["text"], "hello");
    assert_eq!(m["unread"], true);
    assert_eq!(m["box"], "inbox");
    assert_eq!(m["from"], json!({"name": "Án", "address": "a@b.co"}));
    assert_eq!(m["date"], "2023-11-14T22:13:20.000Z");
    assert_no_secrets(&m);
}

#[tokio::test]
async fn persistent_401_gives_reauth_required_after_single_refresh() {
    let server = MockServer::start().await;
    let svc = service(&server.uri(), no_browser());
    let id = seed(&svc, Some("old-access"), Some(now_ms() + 3_600_000)).await;
    Mock::given(method("GET")).and(path("/gmail/messages/m1")).respond_with(ResponseTemplate::new(401)).mount(&server).await;
    Mock::given(method("POST")).and(path("/token")).respond_with(token_ok()).expect(1).mount(&server).await;
    let e = svc.call("gmail.messages.get", json!({"accountId": id, "id": "m1"})).await.unwrap().unwrap_err();
    assert_eq!(e.code, "reauth-required");
    assert!(!format!("{e:?}").contains("new-access"));
}

#[tokio::test]
async fn invalid_grant_marks_needs_reauth() {
    let server = MockServer::start().await;
    let svc = service(&server.uri(), no_browser());
    let id = seed(&svc, None, None).await;
    Mock::given(method("POST")).and(path("/token")).respond_with(ResponseTemplate::new(400).set_body_json(json!({"error": "invalid_grant", "error_description": "refresh-secret revoked"}))).mount(&server).await;
    let r = svc.call("gmail.messages.move", json!({"accountId": id, "ids": ["m1"], "action": "trash"})).await.unwrap().unwrap();
    assert_eq!(r, json!({"ok": false, "reason": "reauth-required"}));
    let list = svc.call("gmail.accounts.list", json!({})).await.unwrap().unwrap();
    assert_eq!(list["accounts"][0]["needsReauth"], true);
    assert_no_secrets(&list);
}

#[tokio::test]
async fn retries_5xx_with_bound_then_reports_server_error() {
    let server = MockServer::start().await;
    let svc = service(&server.uri(), no_browser());
    let id = seed(&svc, Some("old-access"), Some(now_ms() + 3_600_000)).await;
    Mock::given(method("GET")).and(path("/gmail/profile")).respond_with(ResponseTemplate::new(503)).expect(4).mount(&server).await;
    let e = svc.client.get_profile(&id).await.unwrap_err();
    assert_eq!(e.code, "server-error");
    assert_eq!(e.status, Some(503));
}

#[tokio::test]
async fn folder_mapping_and_unsupported_folders() {
    assert_eq!(folder_labels("all"), Some(&["INBOX"][..]));
    assert_eq!(folder_labels("unread"), Some(&["INBOX", "UNREAD"][..]));
    assert_eq!(folder_labels("spam"), Some(&["SPAM"][..]));
    assert_eq!(folder_labels("trash"), Some(&["TRASH"][..]));
    assert!(folder_labels("stranger").is_none() && folder_labels("blocked").is_none());

    let server = MockServer::start().await;
    let svc = service(&server.uri(), no_browser());
    let id = seed(&svc, Some("old-access"), Some(now_ms() + 3_600_000)).await;
    let r = svc.call("gmail.messages.list", json!({"accountId": id, "folder": "blocked"})).await.unwrap().unwrap();
    assert_eq!(r, json!({"messages": [], "nextPageToken": null, "supported": false}));

    Mock::given(method("GET")).and(path("/gmail/messages")).and(query_param("labelIds", "TRASH")).and(query_param("includeSpamTrash", "true")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"messages": [{"id": "t1"}], "nextPageToken": "next"}))).expect(1).mount(&server).await;
    Mock::given(method("GET")).and(path("/gmail/messages/t1")).and(query_param("format", "metadata")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "t1", "labelIds": ["TRASH"], "internalDate": "0", "payload": {"headers": []}}))).mount(&server).await;
    let r = svc.call("gmail.messages.list", json!({"accountId": id, "folder": "trash", "limit": 1})).await.unwrap().unwrap();
    assert_eq!(r["supported"], true);
    assert_eq!(r["messages"][0]["box"], "trash");
    assert_eq!(r["nextPageToken"], "next");
}

#[tokio::test]
async fn move_and_unsupported_actions() {
    let server = MockServer::start().await;
    let svc = service(&server.uri(), no_browser());
    let id = seed(&svc, Some("old-access"), Some(now_ms() + 3_600_000)).await;
    Mock::given(method("POST")).and(path("/gmail/messages/batchModify")).and(body_string_contains("\"addLabelIds\":[\"SPAM\"]")).respond_with(ResponseTemplate::new(204)).expect(1).mount(&server).await;
    Mock::given(method("POST")).and(path("/gmail/messages/a1/modify")).and(body_string_contains("\"removeLabelIds\":[\"UNREAD\"]")).respond_with(ResponseTemplate::new(200).set_body_json(json!({}))).expect(1).mount(&server).await;
    let ok = json!({"ok": true});
    assert_eq!(svc.call("gmail.messages.move", json!({"accountId": id, "ids": ["a1", "a2", "a1"], "action": "spam"})).await.unwrap().unwrap(), ok);
    assert_eq!(svc.call("gmail.messages.move", json!({"accountId": id, "ids": ["a1"], "action": "markRead"})).await.unwrap().unwrap(), ok);
    let r = svc.call("gmail.messages.move", json!({"accountId": id, "ids": ["a1"], "action": "block"})).await.unwrap().unwrap();
    assert_eq!(r, json!({"ok": false, "reason": "unsupported"}));
    let r = svc.call("gmail.messages.move", json!({"accountId": id, "ids": ["bad id!"], "action": "trash"})).await.unwrap().unwrap();
    assert_eq!(r, json!({"ok": false, "reason": "invalid-input"}));
}

#[test]
fn header_injection_is_rejected() {
    for bad in ["a@b.co\r\nBcc: x@y.z", "a@b.co\nX: y", "x\u{2028}y@b.co"] {
        assert_eq!(format_address(bad).unwrap_err().code, "invalid-input", "{bad:?}");
    }
    assert!(encode_header_word("hi\r\nBcc: x@y.z").is_err());
    let mut m = SendInput { to: vec!["a@b.co".into()], subject: "ok\r\nBcc: evil@x.y".into(), text: Some("t".into()), ..Default::default() };
    assert!(build_raw_message(&m, 0, &fixed_random).is_err());
    m.subject = "ok".into();
    m.cc = vec!["c@d.co\r\nX: 1".into()];
    assert!(build_raw_message(&m, 0, &fixed_random).is_err());
    m.cc = vec![];
    m.in_reply_to = Some("<id>\r\nX: 1".into());
    assert!(build_raw_message(&m, 0, &fixed_random).is_err());
    m.in_reply_to = None;
    m.to = vec![];
    assert!(build_raw_message(&m, 0, &fixed_random).is_err());
}

#[test]
fn address_formatting() {
    assert_eq!(format_address("a@b.co").unwrap(), "a@b.co");
    assert_eq!(format_address("Bob <a@b.co>").unwrap(), "\"Bob\" <a@b.co>");
    assert!(format_address("Bo\"b <a@b.co>").is_err());
    assert!(format_address("not an address").is_err());
    assert!(format_address("Nguyễn Văn <a@b.co>").unwrap().starts_with("=?UTF-8?B?"));
}

#[test]
fn non_ascii_subject_is_rfc2047_encoded_and_roundtrips() {
    let long = "Chào bạn, đây là một tiêu đề tiếng Việt rất dài để buộc phải tách thành nhiều encoded-word khác nhau";
    let enc = encode_header_word(long).unwrap();
    assert!(enc.is_ascii() && enc.contains("\r\n =?UTF-8?B?"));
    assert!(enc.split("\r\n ").all(|w| w.len() <= 75));
    assert_eq!(decode_mime_words(&enc), long);
    assert_eq!(encode_header_word("plain").unwrap(), "plain");
    assert_eq!(decode_mime_words("=?UTF-8?Q?caf=C3=A9_ok?="), "café ok");
    assert_eq!(decode_mime_words("=?ISO-8859-1?Q?caf=E9?="), "café");

    let m = SendInput { to: vec!["a@b.co".into()], subject: "Xin chào".into(), text: Some("nội dung".into()), html: Some("<p>x</p>".into()), ..Default::default() };
    let raw = build_raw_message(&m, 1_700_000_000_000, &fixed_random).unwrap();
    assert!(raw.contains("Subject: =?UTF-8?B?WGluIGNow6Bv?=\r\n"));
    assert!(raw.contains("Date: Tue, 14 Nov 2023 22:13:20 GMT\r\n"));
    assert!(raw.contains("multipart/alternative; boundary=\"=_op_000102030405060708090a0b\""));
    assert!(raw.is_ascii());
}

#[tokio::test]
async fn send_with_reply_threading_returns_only_id() {
    let server = MockServer::start().await;
    let svc = service(&server.uri(), no_browser());
    let id = seed(&svc, Some("old-access"), Some(now_ms() + 3_600_000)).await;
    Mock::given(method("GET")).and(path("/gmail/messages/r1")).and(query_param("format", "metadata")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "r1", "threadId": "th1", "payload": {"headers": [{"name": "Message-ID", "value": " <orig@x> "}, {"name": "References", "value": "<root@x>"}]}}))).mount(&server).await;
    Mock::given(method("POST")).and(path("/gmail/messages/send")).and(body_string_contains("\"threadId\":\"th1\"")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "sent1", "threadId": "th1"}))).expect(1).mount(&server).await;
    let r = svc.call("gmail.messages.send", json!({"accountId": id, "to": ["a@b.co"], "subject": "Re: x", "text": "hi", "replyToId": "r1"})).await.unwrap().unwrap();
    assert_eq!(r, json!({"ok": true, "id": "sent1"}));
    let reqs = server.received_requests().await.unwrap();
    let send = reqs.iter().find(|r| r.url.path() == "/gmail/messages/send").unwrap();
    let body: Value = serde_json::from_slice(&send.body).unwrap();
    let raw = String::from_utf8(base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, body["raw"].as_str().unwrap()).unwrap()).unwrap();
    assert!(raw.contains("In-Reply-To: <orig@x>\r\n") && raw.contains("References: <root@x> <orig@x>\r\n"));
    let bad = svc.call("gmail.messages.send", json!({"accountId": id, "to": ["a@b.co\r\nBcc: x@y.z"], "subject": "s", "text": "t"})).await.unwrap().unwrap();
    assert_eq!(bad, json!({"ok": false, "reason": "invalid-input"}));
}

#[tokio::test]
async fn accounts_remove_and_errors_never_contain_tokens() {
    let server = MockServer::start().await;
    let svc = service(&server.uri(), no_browser());
    let id = seed(&svc, Some("old-access"), Some(now_ms() + 3_600_000)).await;
    Mock::given(method("GET")).and(path("/gmail/messages/m1")).respond_with(ResponseTemplate::new(404).set_body_string("old-access refresh-secret")).mount(&server).await;
    let e = svc.call("gmail.messages.get", json!({"accountId": id, "id": "m1"})).await.unwrap().unwrap_err();
    assert_eq!(e.code, "not-found");
    for w in SECRET_WORDS {
        assert!(!e.message.contains(w) && !e.code.contains(w));
    }
    assert_eq!(svc.call("gmail.accounts.remove", json!({"accountId": "nope"})).await.unwrap().unwrap(), json!({"ok": false, "reason": "invalid-account"}));
    assert_eq!(svc.call("gmail.accounts.remove", json!({"accountId": id})).await.unwrap().unwrap(), json!({"ok": true}));
    assert_eq!(svc.call("gmail.accounts.list", json!({})).await.unwrap().unwrap(), json!({"accounts": []}));
    let e = svc.call("gmail.messages.get", json!({"accountId": id, "id": "m1"})).await.unwrap().unwrap_err();
    assert_eq!(e.code, "no-account");
    assert!(svc.call("other.op", json!({})).await.is_none());
}

#[tokio::test]
async fn client_luu_ngay_va_nhap_tai_khoan_cu() {
    use crate::gmail::tokens::TokenStore;
    use crate::sqlite_store::SqliteSecretStore;
    let d = tempfile::tempdir().unwrap();
    let store = TokenStore::new(std::sync::Arc::new(SqliteSecretStore::open(d.path()).unwrap()));
    assert!(store.load_client().await.is_none());
    store.save_client("cid.apps.googleusercontent.com", Some("sec")).await.unwrap();
    assert_eq!(store.load_client().await, Some(("cid.apps.googleusercontent.com".into(), Some("sec".into()))));

    let legacy = d.path().join("legacy");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::write(legacy.join("gmail-index.json"), "{}").unwrap();
    let id = crate::gmail::tokens::account_id("a@gmail.com");
    std::fs::write(legacy.join(format!("gmail-{id}.json")), r#"{"address":"a@gmail.com","clientId":"c","refreshToken":"r","accessToken":"t","expiresAt":5}"#).unwrap();
    assert_eq!(store.import_legacy(&legacy).await, 1);
    assert_eq!(store.import_legacy(&legacy).await, 0); // chạy lại không nhân đôi
    assert_eq!(store.list().await.len(), 1);
    assert!(legacy.join(format!("gmail-{id}.json")).exists());
}
