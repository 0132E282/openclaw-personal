//! Op `setup.check`: báo trạng thái môi trường (trình duyệt, thông báo desktop, cookie Messenger).
//! Không bao giờ trả giá trị bí mật; với cookie chỉ trả có/không và mốc `savedAt` (số nguyên).
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::rpc::{Ctx, RpcResult};

pub const MESSENGER_COOKIE_KEY: &str = "messenger-default";

fn candidate_paths() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Some(home) = std::env::var_os("HOME") {
        v.push(Path::new(&home).join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
    }
    v
}

/// Có trình duyệt Chromium nào ở đường dẫn phổ biến không (hoặc `OPCORE_CHROME_PATH`).
pub fn browser_available(paths: &[PathBuf]) -> bool {
    paths.iter().any(|p| p.is_file())
}

fn detect_browser() -> bool {
    if let Some(p) = std::env::var_os("OPCORE_CHROME_PATH") {
        if Path::new(&p).is_file() {
            return true;
        }
    }
    browser_available(&candidate_paths())
}

/// Chỉ lấy trường số `savedAt` từ JSON cookie; mọi thứ khác bị bỏ.
pub fn extract_saved_at(raw: &str) -> Option<i64> {
    serde_json::from_str::<Value>(raw).ok()?.get("savedAt")?.as_i64()
}

pub async fn check(_input: Value, ctx: &Ctx) -> RpcResult {
    let desktop = if std::env::consts::OS == "macos" { "supported" } else { "unsupported-platform" };
    let cookie = ctx.secrets.get(MESSENGER_COOKIE_KEY).await.ok().flatten();
    let saved_at = cookie.as_deref().and_then(extract_saved_at);
    Ok(json!({
        "browser": if detect_browser() { "available" } else { "missing" },
        "desktopNotify": desktop,
        "messengerCookies": {"present": cookie.is_some(), "savedAt": saved_at},
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_theo_duong_dan() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("chrome");
        std::fs::write(&f, b"").unwrap();
        assert!(browser_available(&[d.path().join("none"), f]));
        assert!(!browser_available(&[d.path().join("none")]));
    }

    #[test]
    fn saved_at_chi_lay_so() {
        assert_eq!(extract_saved_at(r#"{"savedAt":123,"cookies":[{"value":"S"}]}"#), Some(123));
        assert_eq!(extract_saved_at("khong phai json"), None);
        assert_eq!(extract_saved_at(r#"{"savedAt":"x"}"#), None);
    }
}
