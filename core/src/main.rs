//! Điểm vào: đọc cấu hình từ môi trường, tự kiểm tra, nghe 127.0.0.1 và tắt êm.
//!
//! Biến môi trường: `OPCORE_TOKEN` (>= 32 ký tự), `OPCORE_STATE_DIR` (bắt buộc),
//! `OPCORE_OP_TIMEOUT_SECS` (mặc định 30), `OPCORE_EXIT_ON_STDIN_CLOSE=1` (thoát khi stdin đóng).
//! In đúng một dòng `{"ready":true,"port":N}` ra stdout; log chỉ ra stderr và không chứa bí mật.

use openclaw_personal_core::{build_router_with, rpc::Ctx, shutdown_signal, token_ok, DEFAULT_OP_TIMEOUT, MIN_TOKEN_LEN};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2);
}

/// Tự kiểm tra lúc khởi động: ghi/đọc/xóa một khóa thử trong kho bí mật. Không in giá trị nào.
async fn self_check(ctx: &Ctx) -> Result<(), &'static str> {
    let key = "selfcheck-probe";
    ctx.secrets.set(key, "ok").await.map_err(|_| "kho bí mật không ghi được")?;
    let back = ctx.secrets.get(key).await.map_err(|_| "kho bí mật không đọc được")?;
    ctx.secrets.delete(key).await.map_err(|_| "kho bí mật không xóa được")?;
    if back.as_deref() != Some("ok") {
        return Err("kho bí mật trả giá trị sai");
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let token = std::env::var("OPCORE_TOKEN").unwrap_or_default();
    let state_dir = std::env::var("OPCORE_STATE_DIR").unwrap_or_default();
    if !token_ok(&token) || state_dir.is_empty() {
        die(&format!("thiếu OPCORE_TOKEN (>= {MIN_TOKEN_LEN} ký tự) hoặc OPCORE_STATE_DIR"));
    }
    let timeout = match std::env::var("OPCORE_OP_TIMEOUT_SECS") {
        Ok(v) => match v.parse::<u64>() {
            Ok(s) if s > 0 => Duration::from_secs(s),
            _ => die("OPCORE_OP_TIMEOUT_SECS phải là số nguyên dương"),
        },
        Err(_) => DEFAULT_OP_TIMEOUT,
    };
    let watch_stdin = std::env::var("OPCORE_EXIT_ON_STDIN_CLOSE").map(|v| v == "1").unwrap_or(false);
    let state_dir = std::path::PathBuf::from(state_dir);
    if tokio::fs::create_dir_all(&state_dir).await.is_err() {
        die("không tạo được thư mục trạng thái");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700)).await;
    }
    let store = openclaw_personal_core::sqlite_store::SqliteSecretStore::open(&state_dir).unwrap_or_else(|_| die("không mở được core.db"));
    let ctx = Ctx { state_dir: state_dir.clone(), http: reqwest::Client::new(), secrets: Arc::new(store) };
    if let Err(m) = self_check(&ctx).await {
        die(m);
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap_or_else(|_| die("không bind được 127.0.0.1"));
    let port = listener.local_addr().unwrap_or_else(|_| die("không đọc được cổng")).port();
    println!("{}", json!({"ready": true, "port": port}));
    let router = build_router_with(token, ctx, timeout, Arc::new(|op, input, ctx| Box::pin(async move { openclaw_personal_core::rpc::dispatch(&op, input, &ctx).await })));
    let _ = axum::serve(listener, router).with_graceful_shutdown(shutdown_signal(watch_stdin)).await;
}
