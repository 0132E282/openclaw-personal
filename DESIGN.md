# OpenClaw Personal – UI Design

Hiện tại plugin chỉ là launcher (Gmail, Outlook, Zalo Web, Messenger), chưa đồng bộ hộp thư, chưa lưu thông tin đăng nhập, không gửi tự động.

## Mục lục

- Kiến trúc hệ thống (HLD): [VERIFICATION.md](VERIFICATION.md) — connector, dữ liệu, luồng đồng bộ/gửi, bảo mật, lộ trình.
- Thiết kế UI: file này.
- Ràng buộc: [README.md](README.md).

---

Trạng thái: mô tả UI hiện có (`src/control-ui.js`, `src/control-ui.css`) và định hướng mở rộng. Không đổi hành vi hiện tại.

## 1. Nguyên tắc

- Trung thực: UI luôn nói rõ "chỉ mở nhanh", chưa đồng bộ, chưa gửi tự động.
- Kế thừa theme host: dùng biến CSS của OpenClaw (`--text`, `--border`, `--card`, `--bg-accent`, `--bg-hover`), có fallback trung tính.
- Mọi class có tiền tố `openclaw-personal__` để không ảnh hưởng host.
- Văn bản dựng bằng `textContent`, liên kết ngoài luôn `target=_blank` + `rel=noopener noreferrer`.

## 2. Cấu trúc trang (page `inbox`, nav "Personal", icon `mail`)

```text
┌──────────────────────────────────────────┐
│ EYEBROW · H1 "Personal" · intro          │  header
├──────────────────────────────────────────┤
│ aside: "Bản đầu: trung tâm mở nhanh"     │  notice
├────────────┬────────────┬────────────────┤
│ Email      │ Zalo       │ Messenger      │  grid 3 cột
│ [status]   │ [status]   │ [status]       │  (card)
│ mô tả      │ mô tả      │ mô tả          │
│ [Gmail][Outlook] [Zalo]  │ [Messenger]    │
│ ghi chú    │ ghi chú    │ ghi chú        │
├────────────┴────────────┴────────────────┤
│ footer: "Kết nối sâu hơn"                │
└──────────────────────────────────────────┘
```

Responsive: ≤ 960px chuyển lưới về 1 cột, padding card 24 → 20px.

## 3. Design tokens

Layout
- Khung tối đa 1160px, căn giữa, padding `clamp(20px, 4vw, 48px)`.
- Khoảng cách: grid gap 18px; notice margin 28px; links gap 10px, margin 22px.
- Bo góc: card 18px, notice 14px, icon/nút 12px/10px, chip trạng thái 20px.

Typography (kế thừa font host, line-height 1.6)
- H1: `clamp(28px, 4vw, 38px)`, line-height 1.2, letter-spacing -0.035em.
- H2: 20px. Mô tả/notice: 14px. Ghi chú: 12px. Eyebrow: 11px, đậm, letter-spacing 0.16em.
- Độ mờ chữ phụ: intro 0.8, mô tả 0.85, ghi chú 0.8, eyebrow 0.7.

Màu
- Viền: `var(--border, #7776)`; nền card: `var(--card, var(--bg, transparent))`; notice: `var(--bg-accent, transparent)`; hover nút: `var(--bg-hover, #8882)`.
- Không dùng màu cố định ngoài fallback, để hợp theme sáng/tối của host.

## 4. Thành phần

- **Card dịch vụ**: icon 42×42 (aria-hidden), chip trạng thái, H2, mô tả, nhóm nút, ghi chú đẩy xuống đáy (`margin-top:auto`) để các card thẳng hàng.
- **Chip trạng thái**: hiện "Chưa kết nối vào trang" cho Email/Messenger (và Zalo khi không có host). Thẻ Zalo thay bằng chip động theo kênh `zalouser` (Chưa liên kết, Đang hoạt động, Có lỗi, Không đọc được trạng thái...), kèm gợi ý lệnh CLI, nút Làm mới/Thử lại (≥ 44px), cảnh báo rủi ro khóa tài khoản và ghi chú Zalo OA/Bot khác tài khoản cá nhân.
- **Chip trạng thái Messenger**: thẻ Messenger hiện chip theo kênh `fb-messenger` (Chưa cài, Đã cài, Đã cấu hình chưa chạy, Đang hoạt động, Không xác định + nút Thử lại) và luôn ghi chú đây là Facebook Page/Instagram, không phải Messenger cá nhân.
- **Khối trạng thái Email**: 3 dòng chỉ đọc (Gmail PubSub, IMAP, Outlook) dưới mô tả thẻ Email; Outlook luôn là launcher.
- **Nút liên kết**: cao tối thiểu 44px, viền, đậm 600, hậu tố "↗", `aria-label` "<tên> — mở trang ngoài".
- **Notice**: nêu giới hạn (không nhúng, không đồng bộ, không tự gửi).

Trạng thái nút: mặc định, hover (nền `--bg-hover`), focus-visible (outline 3px `currentColor`, offset 3px).

## 5. Truy cập (a11y)

- `section` có `aria-label="Personal"`, `lang="vi"`; mỗi card `aria-labelledby` trỏ tới H2.
- Mục tiêu bấm ≥ 44px; focus nhìn thấy rõ; icon trang trí ẩn khỏi trình đọc màn hình.
- Không truyền đạt thông tin chỉ bằng màu.
- Cần kiểm tra thêm: độ tương phản thực tế với theme host (chữ mờ 0.7–0.85).

## 6. Định hướng mở rộng (khi có connector, xem [VERIFICATION.md](VERIFICATION.md))

Bố cục 2 vùng khi có tài khoản kết nối:

```text
┌ Tài khoản/bộ lọc ┬ Danh sách hội thoại ┬ Khung đọc/soạn ┐
│ Gmail  (3)       │ ● Người gửi · giờ   │ Tiêu đề        │
│ Outlook (0)      │   Tiêu đề · snippet │ Nội dung       │
│ + Kết nối        │                     │ [Soạn] [Gửi]   │
└──────────────────┴─────────────────────┴────────────────┘
```

- Mobile: một cột, chuyển màn hình danh sách → chi tiết.
- Trạng thái cần thiết kế: đang đồng bộ, lỗi đồng bộ (có nút thử lại), hết phiên cần đăng nhập lại, danh sách trống.
- Gửi luôn qua bước xem trước và nút "Gửi" xác nhận; không có gửi ngầm.
- Zalo/Messenger cá nhân giữ dạng thẻ launcher trong cùng trang.
- Chặn ảnh từ xa trong thư theo mặc định, có nút "Hiện ảnh".

## 7. Chưa xác minh

- Hiển thị trên desktop bản đổi tên chưa được kiểm tra (xem `VERIFICATION.md`).
- Chưa có ảnh chụp màn hình làm bằng chứng.
