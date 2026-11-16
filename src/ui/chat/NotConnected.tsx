import {useState, type ReactNode} from 'react';
import {CookieModal} from './CookieModal';
import type {BrowserLoginResult, ChatChannel, MessengerCookies} from './provider';

export interface NotConnectedProps {
  channel: ChatChannel;
  onLinkQr?: () => void;
  onStartBrowserLogin?: () => void | Promise<BrowserLoginResult | void>;
  onCancelBrowserLogin?: () => void;
  onSubmitCookies?: (cookies: MessengerCookies) => void | Promise<void>;
  /** Nội dung thêm dưới ghi chú, ví dụ danh sách cài đặt của kênh. */
  extra?: ReactNode;
}

const COPY = {
  zalo: {
    title: 'Chưa liên kết Zalo',
    desc: 'Liên kết tài khoản Zalo cá nhân để xem và trả lời tin nhắn tại đây.',
    action: 'Liên kết bằng mã QR',
    steps: ['Mở Zalo trên điện thoại', 'Quét mã QR hiển thị', 'Chọn hội thoại muốn đồng bộ'],
    note: 'Zalo cá nhân là kênh không chính thức, có rủi ro bị khóa tài khoản.',
  },
  messenger: {
    title: 'Chưa kết nối Messenger',
    desc: 'Dùng cookie phiên đăng nhập Facebook của bạn để xem và trả lời tin nhắn Messenger tại đây.',
    action: 'Nhập cookie',
    steps: ['Đăng nhập facebook.com trên trình duyệt', 'Sao chép cookie c_user và xs', 'Dán vào OpenClaw và kiểm tra'],
    note: 'Kênh không chính thức, có rủi ro bị khóa tài khoản. Cookie như mật khẩu, chỉ lưu trên máy này.',
  },
} as const;

const noop = () => {};

export function NotConnected({channel, onLinkQr, onStartBrowserLogin, onCancelBrowserLogin, onSubmitCookies, extra}: NotConnectedProps) {
  const c = COPY[channel];
  const [open, setOpen] = useState(false);
  return (
    <div className="op-chat__empty">
      <div className="op-chat__empty-card">
        <h2>{c.title}</h2>
        <p className="op-chat__muted">{c.desc}</p>
        <div className="op-chat__empty-actions">
          <button type="button" className="op-chat__btn op-chat__btn--primary" onClick={channel === 'zalo' ? onLinkQr : () => setOpen(true)}>{c.action}</button>
        </div>
        <ol className="op-chat__steps op-chat__steps--plain">
          {c.steps.map((s, i) => <li key={s}><span className="op-chat__step-dot">{i + 1}</span>{s}</li>)}
        </ol>
        <p className="op-chat__note">{c.note}</p>
        {extra}
      </div>
      {channel === 'messenger' && open && (
        <CookieModal
          onStartBrowserLogin={onStartBrowserLogin ?? noop}
          onCancelBrowserLogin={onCancelBrowserLogin}
          onSubmitCookies={onSubmitCookies ?? noop}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
