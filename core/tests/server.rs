//! Kiểm thử tích hợp: router thật trên 127.0.0.1:0 và tiến trình nhị phân thật.
use openclaw_personal_core::rpc::{Ctx, RpcError};
use openclaw_personal_core::secrets::FileSecretStore;
use openclaw_personal_core::{build_router, build_router_with, DispatchFuture};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

const TOKEN: &str = "0123456789abcdef0123456789abcdef-token";

fn ctx(dir: &std::path::Path) -> Ctx {
    Ctx { state_dir: dir.to_path_buf(), http: reqwest::Client::new(), secrets: Arc::new(FileSecretStore::new(dir)) }
}

async fn serve(router: axum::Router) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    assert!(l.local_addr().unwrap().ip().is_loopback());
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, router).await.unwrap() });
    format!("http://{addr}")
}

async fn start() -> (String, tempfile::TempDir) {
    let d = tempfile::tempdir().unwrap();
    (serve(build_router(TOKEN.into(), ctx(d.path()))).await, d)
}

fn rpc(c: &reqwest::Client, base: &str, token: Option<&str>) -> reqwest::RequestBuilder {
    let r = c.post(format!("{base}/rpc"));
    match token { Some(t) => r.header("x-opcore-token", t), None => r }
}

#[tokio::test]
async fn khong_token_hoac_sai_token_la_401() {
    let (base, _d) = start().await;
    let c = reqwest::Client::new();
    let body = json!({"op": "setup.check"});
    for t in [None, Some("sai"), Some(""), Some(&TOKEN[..TOKEN.len() - 1]), Some("0123456789abcdef0123456789abcdef-tokeX")] {
        let r = rpc(&c, &base, t).json(&body).send().await.unwrap();
        assert_eq!(r.status(), 401, "token {t:?}");
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["code"], "unauthorized");
    }
    assert_eq!(c.get(format!("{base}/health")).send().await.unwrap().status(), 401);
    let ok = c.get(format!("{base}/health")).header("x-opcore-token", TOKEN).send().await.unwrap();
    assert_eq!(ok.status(), 200);
}

#[tokio::test]
async fn xac_thuc_truoc_khi_parse_than() {
    let (base, _d) = start().await;
    let c = reqwest::Client::new();
    // JSON hỏng + không token -> vẫn 401, không lộ lỗi parse.
    let r = rpc(&c, &base, None).body("{hong").send().await.unwrap();
    assert_eq!(r.status(), 401);
}

#[tokio::test]
async fn than_qua_2mb_bi_tu_choi() {
    let (base, _d) = start().await;
    let c = reqwest::Client::new();
    let big = format!(r#"{{"op":"x","input":{{"a":"{}"}}}}"#, "a".repeat(2 * 1024 * 1024 + 10));
    let r = rpc(&c, &base, Some(TOKEN)).header("content-type", "application/json").body(big).send().await.unwrap();
    assert_eq!(r.status(), 413);
}

#[tokio::test]
async fn json_hong_la_4xx_khong_panic() {
    let (base, _d) = start().await;
    let c = reqwest::Client::new();
    for body in ["{hong", "", "[]", r#"{"input":1}"#, r#"{"op":5}"#] {
        let r = rpc(&c, &base, Some(TOKEN)).header("content-type", "application/json").body(body).send().await.unwrap();
        assert_eq!(r.status(), 400, "{body:?}");
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["code"], "invalid-request");
    }
    // Server vẫn sống sau các yêu cầu hỏng.
    let ok = rpc(&c, &base, Some(TOKEN)).json(&json!({"op": "setup.check"})).send().await.unwrap();
    assert_eq!(ok.status(), 200);
}

#[tokio::test]
async fn op_la_va_setup_check() {
    let (base, d) = start().await;
    let c = reqwest::Client::new();
    let v: Value = rpc(&c, &base, Some(TOKEN)).json(&json!({"op": "nope.x"})).send().await.unwrap().json().await.unwrap();
    assert_eq!((v["ok"].clone(), v["error"]["code"].clone()), (json!(false), json!("unknown-op")));
    let v: Value = rpc(&c, &base, Some(TOKEN)).json(&json!({"op": "notify.nope"})).send().await.unwrap().json().await.unwrap();
    assert_eq!(v["error"]["code"], "unknown-op");

    let v: Value = rpc(&c, &base, Some(TOKEN)).json(&json!({"op": "setup.check"})).send().await.unwrap().json().await.unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["result"]["messengerCookies"], json!({"present": false, "savedAt": null}));
    assert!(["available", "missing"].contains(&v["result"]["browser"].as_str().unwrap()));

    // Có cookie: chỉ lộ present + savedAt, tuyệt đối không lộ giá trị.
    std::fs::create_dir_all(d.path().join("secrets")).unwrap();
    std::fs::write(d.path().join("secrets/messenger-default"), r#"{"savedAt":1700000000,"cookies":[{"value":"SUPERSECRET"}]}"#).unwrap();
    let raw = rpc(&c, &base, Some(TOKEN)).json(&json!({"op": "setup.check"})).send().await.unwrap().text().await.unwrap();
    assert!(!raw.contains("SUPERSECRET"));
    let v: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["result"]["messengerCookies"], json!({"present": true, "savedAt": 1700000000}));
}

#[tokio::test]
async fn notify_send_input_sai() {
    let (base, _d) = start().await;
    let c = reqwest::Client::new();
    let v: Value = rpc(&c, &base, Some(TOKEN)).json(&json!({"op": "notify.send", "input": {"title": "", "body": "b"}})).send().await.unwrap().json().await.unwrap();
    assert_eq!(v["ok"], true);
    let reason = v["result"]["reason"].as_str().unwrap();
    // Máy không phải macOS -> unsupported-platform; macOS -> invalid-input (title rỗng).
    assert_eq!(reason, if cfg!(target_os = "macos") { "invalid-input" } else { "unsupported-platform" });
}

#[tokio::test]
async fn timeout_theo_op() {
    let d = tempfile::tempdir().unwrap();
    let disp: openclaw_personal_core::Dispatcher = Arc::new(|op, _i, _c| -> DispatchFuture {
        Box::pin(async move {
            if op == "slow" {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok(json!(1))
            } else {
                Err(RpcError::new("boom", "lỗi"))
            }
        })
    });
    let base = serve(build_router_with(TOKEN.into(), ctx(d.path()), Duration::from_millis(100), disp)).await;
    let c = reqwest::Client::new();
    let t = std::time::Instant::now();
    let v: Value = rpc(&c, &base, Some(TOKEN)).json(&json!({"op": "slow"})).send().await.unwrap().json().await.unwrap();
    assert!(t.elapsed() < Duration::from_secs(3));
    assert_eq!((v["ok"].clone(), v["error"]["code"].clone()), (json!(false), json!("timeout")));
    let v: Value = rpc(&c, &base, Some(TOKEN)).json(&json!({"op": "fast"})).send().await.unwrap().json().await.unwrap();
    assert_eq!(v["error"]["code"], "boom");
}

// ---- Tiến trình thật ----

const BIN: &str = env!("CARGO_BIN_EXE_openclaw-personal-core");

fn spawn(token: &str, dir: &std::path::Path, extra: &[(&str, &str)]) -> std::process::Child {
    let mut cmd = Command::new(BIN);
    cmd.env("OPCORE_TOKEN", token).env("OPCORE_STATE_DIR", dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    for (k, v) in extra { cmd.env(k, v); }
    cmd.spawn().unwrap()
}

fn ready_port(child: &mut std::process::Child) -> (u16, String) {
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["ready"], true);
    (v["port"].as_u64().unwrap() as u16, line)
}

fn wait_exit(child: &mut std::process::Child) -> std::process::ExitStatus {
    for _ in 0..100 {
        if let Some(s) = child.try_wait().unwrap() { return s; }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    panic!("tiến trình không thoát đúng hạn");
}

#[test]
fn token_ngan_bi_tu_choi_luc_khoi_dong() {
    let d = tempfile::tempdir().unwrap();
    let mut c = spawn(&TOKEN[..31], d.path(), &[]);
    assert_eq!(wait_exit(&mut c).code(), Some(2));
    let mut c = spawn("", d.path(), &[]);
    assert_eq!(wait_exit(&mut c).code(), Some(2));
}

#[test]
fn khoi_dong_in_mot_dong_ready_va_thoat_khi_sigterm() {
    let d = tempfile::tempdir().unwrap();
    let mut c = spawn(TOKEN, d.path(), &[]);
    let (port, line) = ready_port(&mut c);
    assert!(!line.contains(TOKEN) && port > 0);
    // Chỉ nghe loopback: kết nối qua 127.0.0.1 được.
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
    // Self-check không để lại khóa thử.
    assert!(!d.path().join("secrets/selfcheck-probe").exists());
    Command::new("kill").args(["-TERM", &c.id().to_string()]).status().unwrap();
    assert!(wait_exit(&mut c).success());
}

#[test]
fn thoat_khi_stdin_dong_neu_bat() {
    let d = tempfile::tempdir().unwrap();
    let mut c = spawn(TOKEN, d.path(), &[("OPCORE_EXIT_ON_STDIN_CLOSE", "1")]);
    ready_port(&mut c);
    drop(c.stdin.take());
    assert!(wait_exit(&mut c).success());
}

#[test]
fn khong_tu_thoat_khi_stdin_dong_neu_khong_bat() {
    let d = tempfile::tempdir().unwrap();
    let mut c = spawn(TOKEN, d.path(), &[]);
    ready_port(&mut c);
    drop(c.stdin.take());
    std::thread::sleep(Duration::from_millis(500));
    assert!(c.try_wait().unwrap().is_none());
    let _ = c.kill();
    let _ = c.wait();
}
