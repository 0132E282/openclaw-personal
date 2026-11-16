# openclaw-personal-core

Dịch vụ backend cục bộ (Rust) của plugin OpenClaw Personal: Gmail, Messenger, thông báo desktop, kiểm tra môi trường. Plugin JS khởi động tiến trình này và gọi qua HTTP loopback.

## Build và test

```
cargo build --release   # nhị phân: target/release/openclaw-personal-core
cargo test
```

## Biến môi trường

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `OPCORE_TOKEN` | có | Token xác thực, tối thiểu 32 ký tự. Thiếu/ngắn -> thoát mã 2. |
| `OPCORE_STATE_DIR` | có | Thư mục trạng thái (tự tạo, quyền 0700); bí mật nằm ở `<dir>/secrets`. |
| `OPCORE_OP_TIMEOUT_SECS` | không | Timeout mỗi op, mặc định 30. |
| `OPCORE_EXIT_ON_STDIN_CLOSE` | không | `1` = tự thoát khi stdin đóng (plugin cha chết). Mặc định tắt để chạy tay với `</dev/null` không bị thoát. |
| `OPCORE_CHROME_PATH` | không | Đường dẫn Chrome/Chromium bổ sung cho `setup.check`. |

## Giao thức

Khởi động xong, tiến trình in đúng một dòng ra stdout: `{"ready":true,"port":N}`. Log chỉ ra stderr, không chứa bí mật.

- `GET /health` với header `x-opcore-token` -> `{"ok":true,"version":"..."}`.
- `POST /rpc` với header `x-opcore-token`, thân `{"op":"...","input":{...}}`.
  - Thành công: `{"ok":true,"result":...}` (HTTP 200).
  - Lỗi op: `{"ok":false,"error":{"code","message"}}` (HTTP 200). Mã gồm `unknown-op`, `invalid-input`, `not-implemented`, `timeout`.
  - 401 `unauthorized` khi thiếu/sai token; 400 `invalid-request` khi JSON hỏng; 413 khi thân > 2MB.

Op của module notify:

- `notify.send` `{title<=80, body<=240}` -> `{ok, reason?}` với `reason` là `unsupported-platform | invalid-input | failed`. Chỉ macOS (osascript).
- `setup.check` -> `{browser: "available"|"missing", desktopNotify: "supported"|"unsupported-platform", messengerCookies: {present, savedAt}}`.

## Mô hình bảo mật

- Chỉ bind `127.0.0.1`, cổng ngẫu nhiên.
- Token so sánh thời gian hằng số; xác thực trước khi parse thân yêu cầu.
- Thân tối đa 2MB; mỗi op có timeout (trả `timeout`, future bị hủy).
- Bí mật (token OAuth, cookie) chỉ đi qua `SecretStore`: file quyền 0600 trong thư mục 0700, ghi nguyên tử (file tạm duy nhất + rename), khóa chỉ gồm `[A-Za-z0-9._-]`, không bắt đầu bằng `.` (chặn path traversal). Không bao giờ ra log hay RPC; `setup.check` chỉ lộ cookie có hay không và `savedAt`.
- `notify.send` truyền nội dung qua argv của osascript, không nối vào script, không qua shell; chuỗi bắt đầu bằng `-` được vá bằng khoảng trắng để không thành option.
- Tắt êm khi nhận SIGTERM/SIGINT (hoặc stdin đóng nếu bật). Lúc khởi động có tự kiểm tra kho bí mật bằng khóa thử, không in giá trị nào.
