import {useEffect, useRef, useState} from 'react';

export type AuthState = {state: 'idle' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'; reason: string | null};

export interface ConnectGmailProps {
  initialClientId?: string;
  /** Đã lưu Client ID: bỏ qua form, mở trình duyệt đăng nhập ngay. */
  auto?: boolean;
  start(clientId: string | undefined, clientSecret?: string): Promise<AuthState>;
  status(): Promise<AuthState>;
  cancel(): Promise<unknown>;
  onDone(): void;
  onClose(): void;
}

const REASONS: Record<string, string> = {
  'invalid-input': 'Client ID không hợp lệ.',
  'browser-failed': 'Không mở được trình duyệt.',
  timeout: 'Hết thời gian chờ đăng nhập. Hãy thử lại.',
  'access-denied': 'Bạn đã từ chối cấp quyền.',
  'exchange-failed': 'Google từ chối đổi mã đăng nhập. Kiểm tra Client ID và loại ứng dụng (Desktop app).',
  'auth-failed': 'Không lấy được thông tin tài khoản Gmail.',
};

/** Hộp thoại kết nối Gmail: nhập Client ID, mở trình duyệt, chờ kết quả. Không lưu hay hiển thị token. */
export function ConnectGmail({initialClientId = '', auto = false, start, status, cancel, onDone, onClose}: ConnectGmailProps) {
  const [clientId, setClientId] = useState(initialClientId);
  const [secret, setSecret] = useState('');
  const [phase, setPhase] = useState<'form' | 'waiting' | 'failed'>(auto ? 'waiting' : 'form');
  const [error, setError] = useState('');
  const [, setUseSaved] = useState(auto);
  const savedRef = useRef(auto);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const fail = (reason: string | null) => {
    if (savedRef.current && reason === 'invalid-input') { savedRef.current = false; setUseSaved(false); }
    setPhase('failed'); setError(REASONS[reason ?? ''] ?? 'Kết nối không thành công.'); };

  const go = async () => {
    setError('');
    setPhase('waiting');
    try {
      const first = await start(savedRef.current ? undefined : clientId.trim(), secret.trim() || undefined);
      if (first.state === 'failed') return fail(first.reason ?? 'invalid-input');
      for (let i = 0; i < 200 && alive.current; i++) {
        await new Promise(r => setTimeout(r, 1500));
        if (!alive.current) return;
        const s = await status();
        if (s.state === 'succeeded') return onDone();
        if (s.state === 'failed') return fail(s.reason);
        if (s.state === 'cancelled') return setPhase('form');
      }
      fail('timeout');
    } catch {
      if (alive.current) fail(null);
    }
  };

  useEffect(() => { if (auto) void go(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { if (phase === 'waiting') void cancel(); onClose(); };

  return (
    <div className="op-email__overlay">
      <div className="op-email__dialog" role="dialog" aria-modal="true" aria-labelledby="op-gmail-title">
        <h3 id="op-gmail-title">Kết nối Gmail</h3>
        {phase === 'waiting' ? (
          <p className="op-email__muted">Đang chờ bạn đăng nhập và cho phép trong trình duyệt vừa mở…</p>
        ) : (
          <>
            <p className="op-email__muted">Dùng OAuth client loại <b>Desktop app</b> tạo trên Google Cloud Console (bật Gmail API, thêm email của bạn vào Test users).</p>
            <label className="op-email__field">Client ID
              <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" autoComplete="off" spellCheck={false} />
            </label>
            <label className="op-email__field">Client secret (nếu có)
              <input type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off" />
            </label>
          </>
        )}
        {error && <p className="op-email__error" role="alert">{error}</p>}
        <div className="op-email__row op-email__row--end">
          <button type="button" className="op-email__btn" onClick={close}>Hủy</button>
          {phase !== 'waiting' && <button type="button" className="op-email__btn op-email__btn--primary" disabled={clientId.trim().length < 8} onClick={() => void go()}>Mở trình duyệt để đăng nhập</button>}
        </div>
      </div>
    </div>
  );
}
