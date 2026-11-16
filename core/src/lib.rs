//! openclaw-personal-core: dịch vụ backend cục bộ cho plugin OpenClaw Personal.
//!
//! `build_router` dựng router axum (xác thực token, giới hạn thân 2MB, timeout theo op);
//! `main.rs` chỉ lo khởi động, tắt êm và tự kiểm tra.

pub mod gmail;
pub mod messenger;
pub mod notify;
pub mod rpc;
pub mod secrets;
pub mod sqlite_store;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use subtle::ConstantTimeEq;

use rpc::{Ctx, RpcError, RpcResult};

pub const MAX_BODY: usize = 2 * 1024 * 1024;
pub const MIN_TOKEN_LEN: usize = 32;
pub const DEFAULT_OP_TIMEOUT: Duration = Duration::from_secs(30);

pub type DispatchFuture = Pin<Box<dyn Future<Output = RpcResult> + Send>>;
/// Hàm xử lý op; mặc định là `rpc::dispatch`, test có thể thay bằng op chậm.
pub type Dispatcher = Arc<dyn Fn(String, Value, Ctx) -> DispatchFuture + Send + Sync>;

#[derive(Clone)]
struct App {
    token: Arc<String>,
    ctx: Ctx,
    timeout: Duration,
    dispatcher: Dispatcher,
}

#[derive(Deserialize)]
struct Req {
    op: String,
    #[serde(default)]
    input: Value,
}

/// Token hợp lệ khi đủ dài (chống token yếu/đoán được).
pub fn token_ok(token: &str) -> bool {
    token.len() >= MIN_TOKEN_LEN
}

fn authorized(app: &App, headers: &HeaderMap) -> bool {
    let given = headers.get("x-opcore-token").map(|v| v.as_bytes()).unwrap_or(b"");
    // ct_eq so độ dài trước rồi mới so byte; chỉ lộ độ dài token (cố định, không bí mật).
    given.ct_eq(app.token.as_bytes()).into()
}

fn unauthorized() -> (StatusCode, Json<Value>) {
    (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": {"code": "unauthorized", "message": "token không hợp lệ"}})))
}

async fn health(State(app): State<App>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    (StatusCode::OK, Json(json!({"ok": true, "version": env!("CARGO_PKG_VERSION")})))
}

async fn rpc_endpoint(State(app): State<App>, headers: HeaderMap, body: Bytes) -> (StatusCode, Json<Value>) {
    // Xác thực trước khi parse thân.
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    let req: Req = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": {"code": "invalid-request", "message": "thân yêu cầu không phải JSON hợp lệ"}})))
        }
    };
    let fut = (app.dispatcher)(req.op, req.input, app.ctx.clone());
    match tokio::time::timeout(app.timeout, fut).await {
        Err(_) => (StatusCode::OK, Json(json!({"ok": false, "error": {"code": "timeout", "message": "thao tác quá thời gian cho phép"}}))),
        Ok(Ok(result)) => (StatusCode::OK, Json(json!({"ok": true, "result": result}))),
        Ok(Err(RpcError { code, message })) => (StatusCode::OK, Json(json!({"ok": false, "error": {"code": code, "message": message}}))),
    }
}

/// Router mặc định: dispatch thật, timeout 30s.
pub fn build_router(token: String, ctx: Ctx) -> Router {
    build_router_with(token, ctx, DEFAULT_OP_TIMEOUT, Arc::new(|op, input, ctx| Box::pin(async move { rpc::dispatch(&op, input, &ctx).await })))
}

pub fn build_router_with(token: String, ctx: Ctx, timeout: Duration, dispatcher: Dispatcher) -> Router {
    let app = App { token: Arc::new(token), ctx, timeout, dispatcher };
    Router::new()
        .route("/health", get(health))
        .route("/rpc", post(rpc_endpoint))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(app)
}

/// Future hoàn tất khi nhận SIGTERM/SIGINT, hoặc (nếu `watch_stdin`) khi stdin đóng.
pub async fn shutdown_signal(watch_stdin: bool) {
    let term = async {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            match signal(SignalKind::terminate()) {
                Ok(mut s) => {
                    s.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        }
        #[cfg(not(unix))]
        std::future::pending::<()>().await
    };
    let int = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let stdin = async {
        if !watch_stdin {
            return std::future::pending::<()>().await;
        }
        use tokio::io::AsyncReadExt;
        let mut sink = [0u8; 256];
        let mut si = tokio::io::stdin();
        while matches!(si.read(&mut sink).await, Ok(n) if n > 0) {}
    };
    tokio::select! { _ = term => {}, _ = int => {}, _ = stdin => {} }
}
