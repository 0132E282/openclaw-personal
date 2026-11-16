# Backend findings (OpenClaw 2026.11.3)

Nguồn: `~/.openclaw/runtime/2026.11.3-release-847611dcaa3b-2026-11-10T17-02-37.000Z/lib/node_modules/openclaw` (gọi là `$OC`).
Chỉ ghi điều đã đọc được trong docs/mã cài trên máy; chưa chạy thử trong Gateway thật.

## A. Sự thật đã xác minh

| # | Câu hỏi | Kết quả | Bằng chứng |
|---|---|---|---|
| 1 | Plugin có chạy sandbox không? | Không. Native plugin chạy trong tiến trình Gateway, không sandbox; có thể spawn process/fs. | `$OC/docs/plugins/sdk-runtime.md:282`; `architecture.md:680`; `zalouser.md:25` |
| 2 | API keychain cho plugin? | Không có. | grep toàn `docs/plugins` và `dist/plugin-sdk`: không có keychain |
| 3 | Kho bí mật chính thức | SecretRef `store` đọc từ SQLite state dùng chung, phạm vi team; ghi qua `openclaw secrets store set`, Control UI (Settings -> Secrets) hoặc tool `secrets`. Không có API ghi dành cho plugin. | `docs/gateway/secrets/secretref-contract.md:219-224`; `docs/cli/secrets.md:18,45-53` |
| 4 | Ghi file bí mật từ plugin | `openclaw/plugin-sdk/secret-file`: `createSecretFileAtomic` (create-only), `readSecretFile*`, `tryReadSecretFileSync`. File 0600, thư mục 0700, đọc tối đa 16 KiB, từ chối hardlink. Không mã hóa. | `docs/plugins/sdk-subpaths.md:223`; `node_modules/@openclaw/fs-safe/docs/secret-file.md`; `dist/secret-file-B1IW-_m6.mjs:15`; `dist/plugin-sdk/secret-file.js` (không export `writeSecretFileAtomic`, nên ghi đè = xóa rồi tạo) |
| 5 | Plugin-state keyed store | Có (`plugin-state-runtime`) nhưng "Private-local after July 2026" và là SQLite thường, không dành cho bí mật. Không dùng. | `sdk-subpaths.md:459` |
| 6 | Sự kiện tin nhắn đến | Hook `message_received` (Observe: nội dung, người gửi, thread, metadata) và `inbound_claim`; đăng ký bằng `api.on("message_received", handler)`. Cần `plugins.entries.<id>.hooks.allowConversationAccess=true` cho plugin không bundled. Hook tin nhắn chung cho mọi kênh (gồm `zalouser`), lọc theo channel trong event. | `docs/plugins/hooks/reference.md:157-159,205-224`; `docs/plugins/hooks.md:14,126,191` |
| 7 | Push event tới UI | Khai báo `events` trong contract, `emit` qua tham số `events` của `setup(api, events)`; client dùng `feature.on` / `feature.watch`. | `docs/plugins/feature-plugins.md` ("Define operations once") |
| 8 | Thông báo OS | Không có API plugin riêng. Hai đường: (a) Gateway tự `execFile('osascript', ...)` (không sandbox, nên được phép về mặt kỹ thuật); (b) lệnh node `system.notify` của app macOS qua `node.invoke` (đã nêu trong docs, chưa xác minh chữ ký lời gọi từ plugin). | `docs/platforms/mac/xpc.md:23`; `docs/nodes/presence.md:41` |
| 9 | Mở trình duyệt hệ thống / spawn | Không bị chặn bởi sandbox (xem #1). Có `plugin-sdk/process-runtime` (thực thi có giới hạn output) nhưng "Private-local after July 2026", nên dùng `child_process` trực tiếp. | `sdk-subpaths.md:427` |
| 10 | Điều khiển osascript | Đã chạy thử cục bộ: `osascript -e 'on run argv' -e '...' -e 'end run' <a> <b>` nhận argv nguyên văn (dấu `"`, `\`, xuống dòng, `$(id)` không bị diễn giải). Chuỗi bắt đầu bằng `-` bị hiểu là option, nên `cleanText` thêm dấu cách đầu. | thử trực tiếp trên Darwin 25.6 |
| 11 | Native UI | Chạy JS tin cậy trong origin Control UI, cùng quyền Gateway của operator; cần bật Labs -> Custom plugin UI. | `feature-plugins.md:17-29,40-60` |

## B. Đã làm (src/connectors/backend/, chưa nối vào src/index.js)

- `cookieStore.ts`: lưu cookie qua interface `SecretFileIO`; adapter thật `createSdkSecretFileIO` dùng SDK secret-file (nạp động). Chỉ giữ `c_user, xs, datr, fr, sb`; bắt buộc c_user + xs; `status()` chỉ trả `{present, savedAt}`.
- `messengerLogin.ts`: Playwright nạp động; thiếu -> `{ok:false, reason:'playwright-missing'}`. Mở `https://www.facebook.com/` (headful), chờ c_user+xs trên domain facebook.com, timeout 5 phút, hủy được. `createLoginController` giữ trạng thái idle/running/succeeded/failed/cancelled; cookie đi thẳng vào `onCookies`, không có trong status.
- `desktopNotify.ts`: `execFile('osascript', ['-e', ...script, title, body])`, runner tiêm; chỉ darwin.
- `contract.ts`: schema TypeBox cho 6 operation `setup.check`, `notify.send`, `messenger.login.start|status|cancel`, `messenger.cookies.set`. Không output nào chứa cookie.
- Test: `test/backend-*.test.mjs` (14 test, không mạng/process thật).

## C. BLOCKED / cần quyết định của người dùng

1. Cài Playwright + Chromium (~vài trăm MB): chưa cài. Cần cho phép; cách thay thế là người dùng dán cookie thủ công qua `messenger.cookies.set`.
2. Gmail OAuth: cần người dùng tạo OAuth client trong Google Cloud (consent screen, client ID/secret) và chấp nhận scope; không thể tự làm. Refresh token nên lưu qua SecretRef `store` (người dùng chạy `openclaw secrets store set`) vì plugin không có API ghi; hoặc cùng file bí mật như cookie. Chưa triển khai.
3. Wiring (session chính): đăng ký operation trong `src/index.js` (`defineFeatureContract`), khởi tạo `createCookieStore` với `createSdkSecretFileIO` (thư mục dưới state dir của OpenClaw), `execFile` promisify cho `createExecFileRunner`; thử trên Gateway thật vì adapter SDK chưa được chạy ngoài Gateway.
4. Thông báo tin mới: cần `plugins.entries.openclaw-personal.hooks.allowConversationAccess=true` để `message_received` hoạt động; người dùng phải cấp. Quyền thông báo macOS cho tiến trình chạy osascript có thể phải bật trong System Settings.
5. Kho bí mật không mã hóa (chỉ chmod 0600): ai đọc được thư mục state đều lấy được cookie. Không có keychain; Keychain macOS cần `security` CLI (chưa xác minh, chưa làm).

## D. Rủi ro

- Cookie Messenger cá nhân (`c_user`, `xs`) tương đương mật khẩu phiên: lộ là mất tài khoản. Không log, không trả ra UI, không đưa vào prompt agent. Facebook có thể khóa/yêu cầu xác minh khi phiên bị dùng từ môi trường tự động hoặc IP khác; automation Messenger cá nhân vi phạm điều khoản Meta. Đăng nhập thủ công bằng trình duyệt thật giảm nhưng không loại trừ rủi ro.
- Zalo cá nhân: plugin `zalouser` dùng `zca-js` không chính thức; docs cảnh báo "may lead to account suspension or ban" (`zalouser.md:14`). Đừng gửi tin hàng loạt/tự động, chỉ dùng thông báo thụ động.
- Native plugin không sandbox (`sdk-runtime.md:282`): bất kỳ lỗi nào ở đây có quyền Gateway.

## Gmail OAuth

Mã nguồn: `src/connectors/backend/gmail/` (`oauth.ts`, `tokenStore.ts`, `gmailClient.ts`, `contract.ts`), test `test/backend-gmail-*.test.mjs` (không mạng/trình duyệt thật). Chưa đăng ký trong `src/index.js`.

- Luồng: OAuth 2.0 client kiểu *Desktop app*, PKCE S256, redirect `http://127.0.0.1:<cổng ngẫu nhiên>/callback`, `access_type=offline`, `prompt=consent`, scope `gmail.readonly`, `gmail.modify`, `gmail.send`. Loopback chỉ bind 127.0.0.1, kiểm tra `state` và Host, hết giờ 5 phút, đóng server khi xong. `clientId` (và `clientSecret` tùy chọn) chỉ nhận qua tham số, không hardcode.
- Token: file bí mật 0600 như cookieStore (không mã hóa) + chỉ mục `gmail-index.json` không chứa bí mật. Output/lỗi/status không bao giờ chứa token (lỗi chỉ có mã cố định).
- `invalid_grant` -> `reauth-required` (đánh dấu `needsReauth`). App Google ở chế độ Testing: refresh token hết hạn sau 7 ngày, phải đăng nhập lại hoặc chuyển app sang In production (có thể cần xác minh với scope nhạy cảm).
- Client: 401 làm mới token đúng 1 lần; 429/5xx/lỗi mạng retry tối đa 3 lần với backoff (tôn trọng Retry-After, tối đa 10s); liệt kê tối đa 100 thư và 5 trang mỗi lần gọi.
- Giới hạn ánh xạ: `all`=INBOX, `unread`=INBOX+UNREAD, `spam`=SPAM, `trash`=TRASH. `stranger`/`blocked` không có nhãn Gmail: list trả rỗng (`supported:false`), `block/unblock/accept` -> `unsupported` (chặn thật cần filter + scope `gmail.settings.basic`, không xin). `deletePermanent` cần scope `https://mail.google.com/` nên `unsupported`. Đính kèm và hẹn giờ gửi chưa hỗ trợ. Thêm/bớt nhãn SPAM/TRASH qua `batchModify` chưa kiểm chứng trên Gmail thật.
- Wiring cần làm (session chính): đăng ký `gmailOperations` trong `src/index.js` (ánh xạ `markRead`/`markUnread` sang `client.markRead`, các action còn lại sang `moveToFolder`); tạo `createTokenStore` với `createSdkSecretFileIO`, `createAuthController` với `fetch` toàn cục, `createNodeServerFactory()`, `openBrowser` (spawn `open <url>` bằng `execFile`, không qua shell), và `onTokens` (tạo client tạm để `getProfile` rồi `store.save`); adapter `EmailProvider` cho UI ghép nhiều tài khoản và màu. Người dùng phải tự tạo OAuth client Desktop trong Google Cloud.

## Backend Rust

Mã nguồn: `src/connectors/backend/rust/` (`client.ts`, `handlers.ts`), test `test/backend-rust-*.test.mjs` (spawn/fetch giả, không tiến trình thật).

- `createCoreProcess` khởi động lười binary `openclaw-personal-core` với env `OPCORE_TOKEN` (random 64 hex) và `OPCORE_STATE_DIR`, đọc một dòng ready (timeout 10s), health check, tự khởi động lại đúng một lần nếu chết, `call` có timeout 30s, `stop()` gửi SIGTERM. Token chỉ ở env và header `x-opcore-token`; lỗi ném ra là `CoreError{code}` với thông điệp cố định (token bị che nếu core lỡ trả về).
- Tìm binary: `OPENCLAW_PERSONAL_CORE_BIN`, rồi `core/target/release/`, rồi `core/target/debug/`; không có -> `core-missing`. Build: `npm run build:core` (cần `. ~/.cargo/env`).
- `src/index.js` đăng ký `gmailOperations` + `backendOperations` (15 op), handler là proxy Rust. Khi `core-missing`: Gmail dùng handler TS cũ làm dự phòng; messenger/notify/setup trả giá trị an toàn đúng schema (`phase:'failed'`/`reason:'launch-failed'`, `notify {ok:false,reason:'failed'}`, cookies `io-error`, setup `missing`), vì schema không có reason `core-missing`. Lưu ý: kho token của Rust và TS tách biệt (state dir `openclaw-personal-core` vs `openclaw-personal`), tài khoản Gmail kết nối bằng TS không tự xuất hiện ở Rust.
- Dừng tiến trình con: đã xác minh `api.registerService({id,start,stop})` trong docs SDK (`sdk-runtime/gateway-and-nodes.md`) và `feature-plugin.js` dùng đúng dạng này; plugin đăng ký service `openclaw-personal:core` với `stop()` gọi `core.stop()`.
