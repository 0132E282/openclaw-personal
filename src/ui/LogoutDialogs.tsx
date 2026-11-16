import {useEffect, useRef, useState} from 'react';

export interface LogoutAccount {
 id: string;
 address: string;
}

/** Hộp thoại đăng xuất Email: liệt kê từng tài khoản Gmail, mỗi tài khoản có nút xác nhận riêng. */
export function EmailLogoutDialog({load, remove, onChanged, onClose}: {
 load(): Promise<readonly LogoutAccount[]>;
 remove(accountId: string): Promise<void>;
 /** Gọi sau mỗi lần xóa thành công để shell làm mới trạng thái kết nối. */
 onChanged(): void;
 onClose(): void;
}) {
 const [accounts, setAccounts] = useState<readonly LogoutAccount[] | null>(null);
 const [busy, setBusy] = useState<string | null>(null);
 const [error, setError] = useState('');
 const alive = useRef(true);
 useEffect(() => {
  alive.current = true;
  load().then(a => { if (alive.current) setAccounts(a); }, () => { if (alive.current) { setAccounts([]); setError('Không đọc được danh sách tài khoản.'); } });
  return () => { alive.current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 const out = async (a: LogoutAccount) => {
  setBusy(a.id); setError('');
  try {
   await remove(a.id);
   if (!alive.current) return;
   const rest = (accounts ?? []).filter(x => x.id !== a.id);
   setAccounts(rest);
   onChanged();
   if (rest.length === 0) onClose();
  } catch {
   if (alive.current) setError(`Không đăng xuất được ${a.address}. Thử lại sau.`);
  } finally {
   if (alive.current) setBusy(null);
  }
 };

 return (
  <div className="op-email__overlay">
   <div className="op-email__dialog" role="dialog" aria-modal="true" aria-labelledby="op-logout-email-title">
    <h3 id="op-logout-email-title">Đăng xuất Email</h3>
    <p className="op-email__muted">Hộp thư chỉ xóa mã truy cập (token) lưu trên máy này; thư trong Gmail không bị ảnh hưởng. Để thu hồi hẳn quyền của ứng dụng, vào <b>myaccount.google.com/permissions</b>.</p>
    {accounts === null && <p className="op-email__muted" role="status">Đang tải…</p>}
    {accounts?.length === 0 && !error && <p className="op-email__muted">Không còn tài khoản Gmail nào đang kết nối.</p>}
    {accounts?.map(a => (
     <div key={a.id} className="op-email__row op-email__logout-row">
      <span className="op-email__logout-addr">{a.address}</span>
      <button type="button" className="op-email__btn op-email__btn--primary" disabled={busy !== null} aria-label={`Đăng xuất ${a.address}`} onClick={() => void out(a)}>{busy === a.id ? 'Đang xóa…' : 'Đăng xuất'}</button>
     </div>
    ))}
    {error && <p className="op-email__error" role="alert">{error}</p>}
    <div className="op-email__row op-email__row--end">
     <button type="button" className="op-email__btn" onClick={onClose}>Hủy</button>
    </div>
   </div>
  </div>
 );
}

export interface ZaloLogoutAccount {
 accountId: string;
 name: string;
}

/**
 * Hộp thoại đăng xuất Zalo: luôn xác nhận; lỗi từ Gateway hiện ngay trong hộp thoại.
 * Một tài khoản: nút xác nhận duy nhất. Nhiều tài khoản: mỗi tài khoản một nút riêng, chỉ đăng xuất tài khoản được bấm.
 */
export function ZaloLogoutDialog({accounts = [], logout, onDone, onClose}: {accounts?: readonly ZaloLogoutAccount[]; logout(accountId?: string): Promise<unknown>; onDone(): void; onClose(): void}) {
 const [busy, setBusy] = useState<string | null>(null);
 const [error, setError] = useState('');
 const [rest, setRest] = useState<readonly ZaloLogoutAccount[]>(accounts);
 const alive = useRef(true);
 useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
 const multi = accounts.length > 1;
 const go = async (a?: ZaloLogoutAccount) => {
  setBusy(a?.accountId ?? ''); setError('');
  try {
   await logout(a?.accountId);
   if (!alive.current) return;
   onDone();
   const left = rest.filter(x => x.accountId !== a?.accountId);
   if (!multi || left.length === 0) { onClose(); return; }
   setRest(left); setBusy(null);
  } catch (e) {
   if (alive.current) { setError(`Không đăng xuất được ${a?.name ?? 'Zalo'} (${e instanceof Error ? e.message.slice(0, 80) : 'lỗi'}). Kiểm tra Gateway rồi thử lại.`); setBusy(null); }
  }
 };
 return (
  <div className="op-chat__overlay">
   <div className="op-chat__modal" role="dialog" aria-modal="true" aria-labelledby="op-logout-zalo-title">
    <h3 id="op-logout-zalo-title">Đăng xuất Zalo</h3>
    <p className="op-chat__muted">{multi ? 'Chọn tài khoản cần đăng xuất. ' : ''}Phiên Zalo trên máy này sẽ bị xóa khỏi OpenClaw. Sau khi đăng xuất, bạn cần quét lại mã QR để liên kết. Tin nhắn Hộp thư đã lưu cục bộ không bị xóa.</p>
    {multi && rest.map(a => (
     <div key={a.accountId} className="op-chat__logout-row">
      <span className="op-chat__logout-name">{a.name}</span>
      <button type="button" className="op-chat__btn op-chat__btn--primary" disabled={busy !== null} aria-label={`Đăng xuất ${a.name}`} onClick={() => void go(a)}>{busy === a.accountId ? 'Đang đăng xuất…' : 'Đăng xuất'}</button>
     </div>
    ))}
    {error && <p className="op-chat__error" role="alert">{error}</p>}
    <div className="op-chat__empty-actions">
     <button type="button" className="op-chat__btn" disabled={busy !== null} onClick={onClose}>{multi ? 'Đóng' : 'Hủy'}</button>
     {!multi && <button type="button" className="op-chat__btn op-chat__btn--primary" disabled={busy !== null} onClick={() => void go(accounts[0])}>{busy !== null ? 'Đang đăng xuất…' : 'Đăng xuất'}</button>}
    </div>
   </div>
  </div>
 );
}

/** Hộp thoại đăng xuất Messenger: luôn xác nhận; chỉ xóa cookie và phiên trình duyệt nền trên máy này. */
export function MessengerLogoutDialog({logout, onDone, onClose}: {logout(): Promise<unknown>; onDone(): void; onClose(): void}) {
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState('');
 const alive = useRef(true);
 useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
 const go = async () => {
  setBusy(true); setError('');
  try {
   await logout();
   if (!alive.current) return;
   onDone();
   onClose();
  } catch {
   if (alive.current) { setError('Không đăng xuất được Messenger. Thử lại sau.'); setBusy(false); }
  }
 };
 return (
  <div className="op-chat__overlay">
   <div className="op-chat__modal" role="dialog" aria-modal="true" aria-labelledby="op-logout-messenger-title">
    <h3 id="op-logout-messenger-title">Đăng xuất Messenger</h3>
    <p className="op-chat__muted">Hộp thư sẽ xóa cookie Facebook và phiên trình duyệt nền lưu trên máy này. Phiên Facebook ở trình duyệt hay thiết bị khác không bị ảnh hưởng. Sau khi đăng xuất, bạn cần kết nối lại để đọc và nhắn tin.</p>
    {error && <p className="op-chat__error" role="alert">{error}</p>}
    <div className="op-chat__empty-actions">
     <button type="button" className="op-chat__btn" disabled={busy} onClick={onClose}>Hủy</button>
     <button type="button" className="op-chat__btn op-chat__btn--primary" disabled={busy} onClick={() => void go()}>{busy ? 'Đang đăng xuất…' : 'Đăng xuất'}</button>
    </div>
   </div>
  </div>
 );
}
