//! Module `gmail`: nhận các op `gmail.*` (OAuth PKCE loopback + REST Gmail). Token chỉ nằm trong
//! `ctx.secrets`; không bao giờ có trong kết quả RPC, lỗi hay log.

pub mod client;
pub mod oauth;
pub mod tokens;

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

use crate::rpc::{Ctx, RpcError, RpcResult};
use client::{ClientConfig, GmailClient, GmailError, SendInput};
use oauth::{AuthConfig, AuthController, OAuthError};
use tokens::{NewRecord, TokenStore};

/// Dịch vụ Gmail: kho token + client REST + bộ điều khiển đăng nhập.
pub struct Service {
    store: Arc<TokenStore>,
    client: GmailClient,
    auth: AuthController,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthStartIn {
    client_id: Option<String>,
    client_secret: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveIn {
    account_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListIn {
    account_id: String,
    folder: String,
    limit: Option<u64>,
    page_token: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetIn {
    account_id: String,
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveIn {
    account_id: String,
    ids: Vec<String>,
    action: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendIn {
    account_id: String,
    to: Vec<String>,
    #[serde(default)]
    cc: Vec<String>,
    #[serde(default)]
    bcc: Vec<String>,
    subject: String,
    text: Option<String>,
    html: Option<String>,
    reply_to_id: Option<String>,
}

fn parse<T: serde::de::DeserializeOwned>(input: Value) -> Result<T, RpcError> {
    serde_json::from_value(if input.is_null() { json!({}) } else { input }).map_err(|_| RpcError::invalid_input("input không hợp lệ"))
}
fn op_err(e: GmailError) -> RpcError {
    RpcError::new(e.code, e.code)
}
fn to_json<T: serde::Serialize>(v: &T) -> RpcResult {
    serde_json::to_value(v).map_err(|_| RpcError::new("internal", "lỗi nội bộ"))
}

impl Service {
    pub fn new(http: reqwest::Client, secrets: Arc<dyn crate::secrets::SecretStore>, client_cfg: ClientConfig, mut auth_cfg: impl FnMut(Arc<TokenStore>, GmailClient) -> AuthConfig) -> Self {
        let store = Arc::new(TokenStore::new(secrets));
        let client = GmailClient::new(http, store.clone(), client_cfg);
        let auth = AuthController::new(auth_cfg(store.clone(), client.clone()));
        Self { store, client, auth }
    }

    /// Cấu hình mặc định: endpoint Google thật, mở trình duyệt hệ thống.
    pub fn production(ctx: &Ctx) -> Self {
        let http = ctx.http.clone();
        let cfg = ClientConfig::default();
        let (api_base, token_endpoint) = (cfg.api_base.clone(), cfg.token_endpoint.clone());
        Self::new(ctx.http.clone(), ctx.secrets.clone(), cfg, move |store, _| AuthConfig {
            http: http.clone(),
            auth_endpoint: oauth::AUTH_ENDPOINT.into(),
            token_endpoint: token_endpoint.clone(),
            timeout: oauth::DEFAULT_AUTH_TIMEOUT,
            open_browser: Arc::new(oauth::open_system_browser),
            on_tokens: save_tokens_hook(http.clone(), api_base.clone(), store),
            now: tokens::now_ms,
            random: oauth::random_bytes,
        })
    }

    pub async fn call(&self, op: &str, input: Value) -> Option<RpcResult> {
        Some(match op {
            "gmail.auth.start" => self.auth_start(input).await,
            "gmail.auth.status" => to_json(&self.auth.status()),
            "gmail.auth.cancel" => to_json(&self.auth.cancel()),
            "gmail.accounts.list" => Ok(json!({"accounts": self.store.list().await})),
            "gmail.accounts.remove" => match parse::<RemoveIn>(input) {
                Err(e) => Err(e),
                Ok(i) => Ok(match self.store.remove(&i.account_id).await {
                    Ok(()) => json!({"ok": true}),
                    Err(e) => json!({"ok": false, "reason": if e == tokens::StoreError::InvalidAccount { "invalid-account" } else { "io-error" }}),
                }),
            },
            "gmail.messages.list" => match parse::<ListIn>(input) {
                Err(e) => Err(e),
                Ok(i) => self.client.list_messages(&i.account_id, &i.folder, i.limit, i.page_token).await.map_err(op_err),
            },
            "gmail.messages.get" => match parse::<GetIn>(input) {
                Err(e) => Err(e),
                Ok(i) => self.client.get_message(&i.account_id, &i.id, true).await.map_err(op_err),
            },
            "gmail.messages.move" => match parse::<MoveIn>(input) {
                Err(e) => Err(e),
                Ok(i) => {
                    let r = match i.action.as_str() {
                        "markRead" => self.client.mark_read(&i.account_id, &i.ids, true).await,
                        "markUnread" => self.client.mark_read(&i.account_id, &i.ids, false).await,
                        a => self.client.move_to_folder(&i.account_id, &i.ids, a).await,
                    };
                    Ok(match r {
                        Ok(()) => json!({"ok": true}),
                        Err(e) => json!({"ok": false, "reason": e.code}),
                    })
                }
            },
            "gmail.messages.send" => match parse::<SendIn>(input) {
                Err(e) => Err(e),
                Ok(i) => {
                    let mail = SendInput { to: i.to, cc: i.cc, bcc: i.bcc, subject: i.subject, text: i.text, html: i.html, reply_to_id: i.reply_to_id, ..Default::default() };
                    Ok(match self.client.send(&i.account_id, mail).await {
                        Ok((id, _)) => json!({"ok": true, "id": id}),
                        Err(e) => json!({"ok": false, "reason": e.code}),
                    })
                }
            },
            _ => return None,
        })
    }

    async fn auth_start(&self, input: Value) -> RpcResult {
        let i: AuthStartIn = parse(input)?;
        if let Some(cid) = i.client_id.filter(|c| !c.is_empty()) {
            let _ = self.store.save_client(&cid, i.client_secret.as_deref().filter(|s| !s.is_empty())).await;
            return Ok(json!({"state": self.auth.start(&cid, i.client_secret)}));
        }
        // Không nhập lại Client ID: dùng lại cái đã lưu, rồi đến cái của tài khoản đầu tiên có clientId.
        if let Some((cid, secret)) = self.store.load_client().await {
            return Ok(json!({"state": self.auth.start(&cid, secret)}));
        }
        for acc in self.store.list().await {
            if let Some(rec) = self.store.load(&acc.id).await.filter(|r| !r.client_id.is_empty()) {
                return Ok(json!({"state": self.auth.start(&rec.client_id, rec.client_secret.clone())}));
            }
        }
        Ok(json!({"state": self.auth.start("", None)}))
    }

    /// Nhập một lần các tài khoản từ thư mục của bản TypeScript (cùng cấp, tên `openclaw-personal`).
    async fn migrate_legacy(&self, state_dir: &std::path::Path) {
        if let Some(legacy) = state_dir.parent().map(|p| p.join("openclaw-personal")).filter(|p| p.is_dir()) {
            self.store.import_legacy(&legacy).await;
        }
    }
}

/// Sau khi đổi mã: gọi getProfile bằng access token mới để biết địa chỉ rồi lưu bản ghi.
pub fn save_tokens_hook(http: reqwest::Client, api_base: String, store: Arc<TokenStore>) -> oauth::OnTokens {
    Arc::new(move |t, client_id, client_secret| {
        let (http, api_base, store) = (http.clone(), api_base.clone(), store.clone());
        Box::pin(async move {
            let res = http.get(format!("{api_base}/profile")).bearer_auth(&t.access_token).send().await.map_err(|_| OAuthError("network"))?;
            let ok = res.status().is_success();
            let body: Value = res.json().await.unwrap_or(Value::Null);
            let address = body.get("emailAddress").and_then(Value::as_str).filter(|_| ok).ok_or(OAuthError("exchange-failed"))?.to_string();
            let id = store
                .save(NewRecord { address: address.clone(), client_id, client_secret, refresh_token: t.refresh_token, access_token: Some(t.access_token), expires_at: Some(t.expires_at), scope: Some(t.scope).filter(|s| !s.is_empty()) })
                .await
                .map_err(|_| OAuthError("exchange-failed"))?;
            Ok((id, address))
        })
    })
}

static SERVICE: OnceLock<Service> = OnceLock::new();

pub async fn handle(op: &str, input: Value, ctx: &Ctx) -> Option<RpcResult> {
    if !op.starts_with("gmail.") {
        return None;
    }
    let svc = SERVICE.get_or_init(|| Service::production(ctx));
    static MIGRATED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    MIGRATED.get_or_init(|| svc.migrate_legacy(&ctx.state_dir)).await;
    Some(svc.call(op, input).await.unwrap_or_else(|| Err(RpcError::new("unknown-op", "op không tồn tại"))))
}

#[cfg(test)]
mod tests;
