//! Module `messenger`: cookie Messenger (kho bí mật) và đăng nhập bằng trình duyệt thật.
//! Ops: `messenger.login.start|status|cancel`, `messenger.cookies.set|clear`,
//! `messenger.status|conversations|messages|send` (đọc/gửi qua trình duyệt headless, xem `chat`).
//! Output không bao giờ chứa cookie.

pub mod chat;
pub mod chat_chromium;
pub mod cookies;
pub mod login;
pub mod selectors;

use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

use crate::rpc::{Ctx, RpcError, RpcResult};
use chat::{ChatConfig, MessengerChat, PageLauncher, Reason};
use chat_chromium::ChromiumPageLauncher;
use cookies::{CookieStatus, CookieStore};
use login::{BrowserLauncher, ChromiumLauncher, LoginConfig, LoginController};

pub const DEFAULT_ACCOUNT: &str = "default";

fn controller() -> &'static LoginController {
    static C: OnceLock<LoginController> = OnceLock::new();
    C.get_or_init(LoginController::new)
}

fn chat() -> &'static MessengerChat {
    static C: OnceLock<MessengerChat> = OnceLock::new();
    C.get_or_init(|| MessengerChat::new(ChatConfig::default()))
}

fn profile_dir(ctx: &Ctx) -> std::path::PathBuf {
    ctx.state_dir.join("messenger-browser")
}

const FOLDERS: [&str; 6] = ["all", "unread", "group", "stranger", "blocked", "spam"];

/// Ops đọc/gửi; `None` nếu không phải op này. Tách riêng để test bằng trình duyệt giả.
pub async fn chat_op(op: &str, input: &Value, store: &CookieStore, svc: &MessengerChat, launcher: &dyn PageLauncher) -> Option<RpcResult> {
    let fail = |r: Reason| json!({"ok": false, "reason": r.as_str()});
    Some(match op {
        "messenger.status" => {
            let s = svc.status(store).await;
            Ok(json!({"state": s.state, "reason": s.reason}))
        }
        "messenger.conversations" => {
            let folder = match input.get("folder") {
                None | Some(Value::Null) => "all",
                Some(Value::String(f)) if FOLDERS.contains(&f.as_str()) => f.as_str(),
                _ => return Some(Err(RpcError::invalid_input("folder không hợp lệ"))),
            };
            Ok(match svc.conversations(launcher, store, folder).await {
                Ok(l) => json!({"ok": true, "conversations": l.conversations.iter().map(|c| c.to_json()).collect::<Vec<_>>(), "e2eeHidden": l.e2ee_hidden}),
                Err(r) => json!({"ok": false, "reason": r.as_str(), "conversations": [], "e2eeHidden": 0}),
            })
        }
        "messenger.messages" => {
            let Some(id) = input.get("conversationId").and_then(Value::as_str) else {
                return Some(Err(RpcError::invalid_input("conversationId không hợp lệ")));
            };
            Ok(match svc.messages(launcher, store, id).await {
                Ok(l) => json!({"ok": true, "messages": l.iter().map(|m| m.to_json()).collect::<Vec<_>>()}),
                Err(r) => json!({"ok": false, "reason": r.as_str(), "messages": []}),
            })
        }
        "messenger.send" => {
            let (Some(id), Some(text)) = (input.get("conversationId").and_then(Value::as_str), input.get("text").and_then(Value::as_str)) else {
                return Some(Err(RpcError::invalid_input("conversationId/text không hợp lệ")));
            };
            Ok(match svc.send(launcher, store, id, text).await {
                Ok(()) => json!({"ok": true}),
                Err(r) => fail(r),
            })
        }
        _ => return None,
    })
}

/// Phần Messenger của `setup.check`: chỉ `{present, savedAt}`.
#[allow(dead_code)]
pub async fn cookie_status(ctx: &Ctx, account: Option<&str>) -> CookieStatus {
    CookieStore::new(ctx.secrets.clone()).status(account.unwrap_or(DEFAULT_ACCOUNT)).await
}

fn account_of(input: &Value) -> Result<String, RpcError> {
    match input.get("account") {
        None | Some(Value::Null) => Ok(DEFAULT_ACCOUNT.to_string()),
        Some(Value::String(a)) if cookies::valid_account(a) => Ok(a.clone()),
        _ => Err(RpcError::invalid_input("account không hợp lệ")),
    }
}

/// Nhận cookie dạng mảng hoặc `{cUser, xs}`.
fn cookies_of(input: &Value) -> Option<Value> {
    match input.get("cookies")? {
        v @ Value::Array(_) => Some(v.clone()),
        Value::Object(o) => {
            let c_user = o.get("cUser")?.as_str()?;
            let xs = o.get("xs")?.as_str()?;
            Some(json!([{"name": "c_user", "value": c_user}, {"name": "xs", "value": xs}]))
        }
        _ => None,
    }
}

async fn set_cookies(input: &Value, ctx: &Ctx) -> RpcResult {
    let account = match account_of(input) {
        Ok(a) => a,
        Err(_) => return Ok(json!({"ok": false, "reason": "invalid-account"})),
    };
    let Some(cookies) = cookies_of(input) else {
        return Ok(json!({"ok": false, "reason": "invalid-cookies"}));
    };
    Ok(match CookieStore::new(ctx.secrets.clone()).save(&account, &cookies).await {
        Ok(()) => {
            // Cookie mới: bỏ cờ hết hạn và phiên trình duyệt cũ.
            chat().reset().await;
            json!({"ok": true})
        }
        Err(e) => json!({"ok": false, "reason": e.code()}),
    })
}

async fn clear_cookies(input: &Value, ctx: &Ctx) -> RpcResult {
    let account = match account_of(input) {
        Ok(a) => a,
        Err(_) => return Ok(json!({"ok": false, "reason": "invalid-account"})),
    };
    Ok(match CookieStore::new(ctx.secrets.clone()).clear(&account).await {
        Ok(()) => {
            // Đóng phiên và xóa luôn thư mục trình duyệt riêng để không còn phiên Facebook nào trên máy.
            chat().reset().await;
            let _ = tokio::fs::remove_dir_all(profile_dir(ctx)).await;
            json!({"ok": true})
        }
        Err(e) => json!({"ok": false, "reason": e.code()}),
    })
}

pub async fn handle(op: &str, input: Value, ctx: &Ctx) -> Option<RpcResult> {
    let launcher = ChromiumPageLauncher { profile_dir: profile_dir(ctx) };
    if let Some(r) = chat_op(op, &input, &CookieStore::new(ctx.secrets.clone()), chat(), &launcher).await {
        return Some(r);
    }
    Some(match op {
        "messenger.cookies.set" => set_cookies(&input, ctx).await,
        "messenger.cookies.clear" => clear_cookies(&input, ctx).await,
        "messenger.login.start" => match account_of(&input) {
            Err(e) => Err(e),
            Ok(account) => {
                let launcher: Arc<dyn BrowserLauncher> = Arc::new(ChromiumLauncher);
                let st = controller().start(launcher, CookieStore::new(ctx.secrets.clone()), account, LoginConfig::default());
                let mut out = st.to_json();
                if st.reason == Some("browser-missing") {
                    out["ok"] = json!(false);
                }
                Ok(out)
            }
        },
        "messenger.login.status" => Ok(controller().status().to_json()),
        "messenger.login.cancel" => Ok(controller().cancel().await.to_json()),
        _ if op.starts_with("messenger.") => Err(RpcError::not_implemented(op)),
        _ => return None,
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod chat_tests;
