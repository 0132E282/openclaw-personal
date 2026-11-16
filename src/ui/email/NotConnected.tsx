import type {ReactNode} from 'react';
import {GMAIL_ICON} from './gmailIcon';
interface Props {
 extra?: ReactNode;
 onConnect?: () => void;
 onLearnMore?: () => void;
}
const STEPS = ['Đăng nhập tài khoản Google', 'Cho phép đọc và gửi thư', 'Chọn tài khoản muốn hiển thị'];

export function NotConnected({onConnect, onLearnMore, extra}: Props) {
 return (
  <section className="op-email__empty" aria-label="Chưa kết nối Gmail">
   <div className="op-email__empty-logo" aria-hidden="true">
    <img src={GMAIL_ICON} width="32" height="32" alt="" />
   </div>
   <h2>Chưa kết nối Gmail</h2>
   <p>Đăng nhập Google để đọc, gửi và nhận thư ngay trong OpenClaw. Có thể thêm nhiều tài khoản.</p>
   <div className="op-email__row">
    <button type="button" className="op-email__btn op-email__btn--primary" disabled={!onConnect} onClick={onConnect}>Kết nối Gmail</button>
    <button type="button" className="op-email__btn" disabled={!onLearnMore} onClick={onLearnMore}>Tìm hiểu thêm</button>
   </div>
   <ol className="op-email__steps">{STEPS.map((s, i) => <li key={s}><span>{i + 1}</span>{s}</li>)}</ol>
   <small>Chỉ đọc, gửi và sắp xếp thư. OpenClaw không xem mật khẩu của bạn.</small>
   {extra}
  </section>
 );
}
