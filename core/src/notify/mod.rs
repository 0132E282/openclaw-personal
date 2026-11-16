//! Module `notify`: thông báo desktop (op `notify.send`) và kiểm tra môi trường (op `setup.check`).
//!
//! Cổng từ `src/connectors/backend/desktopNotify.ts`. Nội dung truyền cho osascript qua argv
//! (AppleScript `on run argv`), KHÔNG nối vào chuỗi script và KHÔNG qua shell.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;

use crate::rpc::{Ctx, RpcError, RpcResult};

pub mod setup;

pub const MAX_TITLE: usize = 80;
pub const MAX_BODY: usize = 240;
pub const NOTIFY_TIMEOUT: Duration = Duration::from_secs(5);

pub const APPLESCRIPT_LINES: [&str; 3] = [
    "on run argv",
    "display notification (item 2 of argv) with title (item 1 of argv)",
    "end run",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyFailure {
    UnsupportedPlatform,
    InvalidInput,
    Failed,
}

impl NotifyFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "unsupported-platform",
            Self::InvalidInput => "invalid-input",
            Self::Failed => "failed",
        }
    }
}

/// Trình chạy lệnh ngoài; tách thành trait để test không spawn tiến trình thật.
#[async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(&self, file: &str, args: &[String], timeout: Duration) -> Result<(), ()>;
}

/// Runner thật dựa trên tokio::process (không shell, kill khi hết giờ).
pub struct ProcessRunner;

#[async_trait]
impl CommandRunner for ProcessRunner {
    async fn run(&self, file: &str, args: &[String], timeout: Duration) -> Result<(), ()> {
        let mut cmd = tokio::process::Command::new(file);
        cmd.args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let status = tokio::time::timeout(timeout, cmd.status()).await.map_err(|_| ())?.map_err(|_| ())?;
        if status.success() { Ok(()) } else { Err(()) }
    }
}

/// Bỏ ký tự điều khiển, gộp khoảng trắng, cắt độ dài; chặn chuỗi bắt đầu bằng '-' bị osascript hiểu là option.
pub fn clean_text(input: &str, max: usize) -> String {
    let replaced: String = input
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let joined = replaced
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut s = joined;
    if s.chars().count() > max {
        s = s.chars().take(max - 1).collect::<String>() + "…";
    }
    if s.starts_with('-') { format!(" {s}") } else { s }
}

pub fn build_osascript_args(title: &str, body: &str) -> Vec<String> {
    let mut v: Vec<String> = APPLESCRIPT_LINES
        .iter()
        .flat_map(|l| ["-e".to_string(), (*l).to_string()])
        .collect();
    v.push(title.to_string());
    v.push(body.to_string());
    v
}

pub struct Notifier<'a> {
    pub runner: &'a dyn CommandRunner,
    /// Giá trị kiểu `std::env::consts::OS` ("macos", "linux", ...).
    pub os: &'a str,
}

impl Notifier<'_> {
    pub async fn send(&self, title: Option<&str>, body: Option<&str>) -> Result<(), NotifyFailure> {
        if self.os != "macos" {
            return Err(NotifyFailure::UnsupportedPlatform);
        }
        let t = clean_text(title.unwrap_or(""), MAX_TITLE);
        let b = clean_text(body.unwrap_or(""), MAX_BODY);
        if t.trim().is_empty() {
            return Err(NotifyFailure::InvalidInput);
        }
        self.runner
            .run("osascript", &build_osascript_args(&t, &b), NOTIFY_TIMEOUT)
            .await
            .map_err(|_| NotifyFailure::Failed)
    }
}

pub fn send_result(r: Result<(), NotifyFailure>) -> Value {
    match r {
        Ok(()) => json!({"ok": true}),
        Err(f) => json!({"ok": false, "reason": f.as_str()}),
    }
}

pub async fn handle(op: &str, input: Value, _ctx: &Ctx) -> Option<RpcResult> {
    match op {
        "notify.send" => {
            let n = Notifier { runner: &ProcessRunner, os: std::env::consts::OS };
            // Title không phải chuỗi -> invalid-input (sau kiểm tra nền tảng, như bản TS).
            let title = input.get("title").and_then(Value::as_str);
            let body = input.get("body").and_then(Value::as_str);
            Some(Ok(send_result(n.send(title, body).await)))
        }
        o if o.starts_with("notify.") => Some(Err(RpcError::new("unknown-op", "op không tồn tại"))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<(String, Vec<String>, Duration)>>,
        fail: bool,
    }
    #[async_trait]
    impl CommandRunner for Fake {
        async fn run(&self, f: &str, a: &[String], t: Duration) -> Result<(), ()> {
            self.calls.lock().unwrap().push((f.into(), a.to_vec(), t));
            if self.fail { Err(()) } else { Ok(()) }
        }
    }

    #[tokio::test]
    async fn argv_rieng_khong_noi_vao_script() {
        let fake = Fake::default();
        let n = Notifier { runner: &fake, os: "macos" };
        let evil = "x\" & do shell script \"id\" & \"\n$(id);`id`";
        assert!(n.send(Some("Tin mới"), Some(evil)).await.is_ok());
        let calls = fake.calls.lock().unwrap();
        let (file, args, _) = &calls[0];
        assert_eq!(file, "osascript");
        let script: Vec<&String> = args.iter().enumerate().filter(|(i, _)| i % 2 == 1 && *i < 6).map(|(_, s)| s).collect();
        let joined = script.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n");
        assert!(!joined.contains("do shell script") && !joined.contains("$(") && !joined.contains("Tin mới"));
        assert_eq!(args[args.len() - 2], "Tin mới");
        assert_eq!(args[args.len() - 1], "x\" & do shell script \"id\" & \" $(id);`id`");
    }

    #[tokio::test]
    async fn nen_tang_input_loi_runner() {
        let fake = Fake::default();
        let linux = Notifier { runner: &fake, os: "linux" };
        assert_eq!(linux.send(Some("a"), Some("b")).await, Err(NotifyFailure::UnsupportedPlatform));
        assert!(fake.calls.lock().unwrap().is_empty());
        let bad = Fake { fail: true, ..Default::default() };
        let n = Notifier { runner: &bad, os: "macos" };
        assert_eq!(n.send(Some(""), Some("b")).await, Err(NotifyFailure::InvalidInput));
        assert_eq!(n.send(None, Some("b")).await, Err(NotifyFailure::InvalidInput));
        assert_eq!(n.send(Some("  \t "), Some("b")).await, Err(NotifyFailure::InvalidInput));
        assert_eq!(n.send(Some("a"), Some("b")).await, Err(NotifyFailure::Failed));
    }

    #[test]
    fn clean_text_quy_tac() {
        assert_eq!(clean_text(&"a".repeat(1000), MAX_BODY).chars().count(), MAX_BODY);
        assert_eq!(clean_text("a\u{0}b\tc", 50), "a b c");
        assert!(!clean_text("-e foo", 50).starts_with('-'));
        assert!(!clean_text("\n-e foo", 50).starts_with('-'));
        assert_eq!(&build_osascript_args("t", "b")[6..], ["t", "b"]);
        assert_eq!(send_result(Err(NotifyFailure::Failed)), json!({"ok": false, "reason": "failed"}));
    }
}
