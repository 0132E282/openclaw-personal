import {useEffect, useRef, useState} from 'react';
import type {BrowserLoginResult, MessengerCookies} from './provider';

export interface CookieModalProps {
  onStartBrowserLogin: () => void | Promise<BrowserLoginResult | void>;
  onCancelBrowserLogin?: () => void;
  onSubmitCookies: (cookies: MessengerCookies) => void | Promise<void>;
  onClose: () => void;
}

type Tab = 'browser' | 'paste';

/** Hộp thoại kết nối Messenger. Giá trị cookie chỉ nằm trong state cục bộ và bị xóa ngay khi gửi. */
const LOGIN_FAIL: Record<string, string> = {
  'browser-missing': 'Không tìm thấy Chrome trên máy này. Cài Chrome hoặc dán cookie thủ công.',
  'launch-failed': 'Không mở được cửa sổ trình duyệt. Thử lại hoặc dán cookie thủ công.',
  timeout: 'Hết thời gian chờ đăng nhập. Bấm "Mở lại cửa sổ" để thử lại.',
  'save-failed': 'Đăng nhập xong nhưng không lưu được cookie. Thử lại.',
};

export function CookieModal({onStartBrowserLogin, onCancelBrowserLogin, onSubmitCookies, onClose}: CookieModalProps) {
  const [tab, setTab] = useState<Tab>('browser');
  const [cUser, setCUser] = useState('');
  const [xs, setXs] = useState('');
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const [login, setLogin] = useState<'waiting' | 'done' | 'failed' | 'cancelled'>('waiting');
  const [loginError, setLoginError] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  async function start() {
    setLogin('waiting');
    setLoginError('');
    let r: BrowserLoginResult | void;
    try { r = await onStartBrowserLogin(); } catch { r = {phase: 'failed', reason: 'launch-failed'}; }
    if (!alive.current || !r) return;
    if (r.phase === 'succeeded') setLogin('done');
    else if (r.phase === 'cancelled') setLogin('cancelled');
    else { setLogin('failed'); setLoginError(LOGIN_FAIL[r.reason ?? ''] ?? LOGIN_FAIL['launch-failed']); }
  }

  function close() {
    if (login === 'waiting') onCancelBrowserLogin?.();
    onClose();
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, []);

  async function submit() {
    const payload = {cUser: cUser.trim(), xs: xs.trim(), raw: raw.trim()};
    if (!(payload.cUser && payload.xs) && !payload.raw) {
      setError('Cần nhập c_user và xs, hoặc dán toàn bộ cookie.');
      return;
    }
    setCUser('');
    setXs('');
    setRaw('');
    setError('');
    setBusy(true);
    try {
      await onSubmitCookies(payload);
      if (alive.current) onClose();
    } catch {
      setError('Không kết nối được. Kiểm tra lại cookie rồi thử lại.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="op-chat__overlay">
      <div className="op-chat__modal" role="dialog" aria-modal="true" aria-labelledby="op-chat-modal-title">
        <div className="op-chat__modal-head">
          <h3 id="op-chat-modal-title">Kết nối Messenger</h3>
          <button type="button" className="op-chat__icon-btn" aria-label="Đóng" onClick={close}>×</button>
        </div>
        <div className="op-chat__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'browser'} className="op-chat__tab" onClick={() => setTab('browser')}>Đăng nhập bằng trình duyệt</button>
          <button type="button" role="tab" aria-selected={tab === 'paste'} className="op-chat__tab" onClick={() => setTab('paste')}>Dán cookie thủ công</button>
        </div>
        {tab === 'browser' ? (
          <div role="tabpanel">
            <ol className="op-chat__steps">
              <li data-state="done"><span className="op-chat__step-dot">✓</span>OpenClaw mở cửa sổ trình duyệt riêng tới facebook.com</li>
              <li data-state="now"><span className="op-chat__step-dot">2</span>Bạn tự đăng nhập, gồm cả mã xác minh nếu có</li>
              <li><span className="op-chat__step-dot">3</span>OpenClaw tự lấy cookie khi đăng nhập xong và đóng cửa sổ</li>
            </ol>
            {login === 'waiting' && <p className="op-chat__waiting"><span className="op-chat__dot" data-tone="warn" />Đang chờ bạn đăng nhập…</p>}
            {login === 'done' && <p className="op-chat__waiting" role="status"><span className="op-chat__dot" data-tone="ok" />Đã đăng nhập, cookie đã được lưu trên máy này.</p>}
            {login === 'cancelled' && <p className="op-chat__waiting" role="status">Đã hủy đăng nhập.</p>}
            {login === 'failed' && <p className="op-chat__error" role="alert">{loginError}</p>}
            <p className="op-chat__note-box">OpenClaw không nhìn thấy mật khẩu. Chỉ lấy cookie phiên (c_user, xs), lưu trên máy này và có thể xóa bất cứ lúc nào.</p>
            <div className="op-chat__modal-actions">
              <button type="button" className="op-chat__btn" onClick={close}>{login === 'done' ? 'Đóng' : 'Hủy'}</button>
              {login !== 'done' && <button type="button" className="op-chat__btn" onClick={() => void start()}>Mở lại cửa sổ</button>}
            </div>
          </div>
        ) : (
          <div role="tabpanel">
            <label className="op-chat__field">c_user
              <input name="c_user" type="text" autoComplete="off" spellCheck={false} placeholder="61555xxxxxxxxx" value={cUser} onChange={e => setCUser(e.target.value)} />
            </label>
            <label className="op-chat__field">xs
              <input name="xs" type="password" autoComplete="off" spellCheck={false} placeholder="dán giá trị xs tại đây…" value={xs} onChange={e => setXs(e.target.value)} />
            </label>
            <label className="op-chat__field">Hoặc dán toàn bộ cookie (JSON / header)
              <textarea name="raw" className="op-chat__masked" autoComplete="off" spellCheck={false} placeholder={'[{"name":"c_user","value":"…"},{"name":"xs","value":"…"}]'} value={raw} onChange={e => setRaw(e.target.value)} />
            </label>
            {error && <p className="op-chat__error" role="alert">{error}</p>}
            <div className="op-chat__modal-actions">
              <button type="button" className="op-chat__btn" onClick={onClose}>Hủy</button>
              <button type="button" className="op-chat__btn op-chat__btn--primary" disabled={busy} onClick={submit}>{busy ? 'Đang kiểm tra…' : 'Kiểm tra và kết nối'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
