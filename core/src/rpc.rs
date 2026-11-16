//! Giao thức RPC giữa plugin JS và dịch vụ Rust.
//!
//! `POST /rpc` với header `x-opcore-token`, thân `{"op": "...", "input": {...}}`.
//! Trả `{"ok": true, "result": ...}` hoặc `{"ok": false, "error": {"code": "...", "message": "..."}}`.
//! Lỗi và kết quả không bao giờ chứa token, cookie hay secret.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use crate::secrets::SecretStore;

#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: &str, message: &str) -> Self {
        Self { code: code.to_string(), message: message.to_string() }
    }
    pub fn invalid_input(message: &str) -> Self {
        Self::new("invalid-input", message)
    }
    pub fn not_implemented(op: &str) -> Self {
        Self::new("not-implemented", &format!("{op} chưa được triển khai"))
    }
}

pub type RpcResult = Result<Value, RpcError>;

/// Ngữ cảnh dùng chung cho mọi module.
#[derive(Clone)]
pub struct Ctx {
    /// Thư mục trạng thái riêng của dịch vụ (đã tạo, quyền 0700).
    pub state_dir: PathBuf,
    pub http: reqwest::Client,
    pub secrets: Arc<dyn SecretStore>,
}

/// Định tuyến một op tới module sở hữu nó. Mỗi module trả `None` nếu op không thuộc về nó.
pub async fn dispatch(op: &str, input: Value, ctx: &Ctx) -> RpcResult {
    if let Some(r) = crate::gmail::handle(op, input.clone(), ctx).await {
        return r;
    }
    if let Some(r) = crate::messenger::handle(op, input.clone(), ctx).await {
        return r;
    }
    if op == "setup.check" {
        return crate::notify::setup::check(input, ctx).await;
    }
    if let Some(r) = crate::notify::handle(op, input, ctx).await {
        return r;
    }
    Err(RpcError::new("unknown-op", "op không tồn tại"))
}
