import {useEffect, useRef, useState} from 'react';

export interface QrLoginStep {
  qrDataUrl?: string;
  message?: string;
  connected?: boolean;
  sessionKey?: string;
}

export interface ZaloQrProps {
  start(): Promise<QrLoginStep>;
  wait(current: {qrDataUrl?: string; sessionKey?: string}): Promise<QrLoginStep>;
  onLinked(): void;
  onClose(): void;
  /** Kiểm tra kênh đã liên kết chưa (đọc trạng thái thật); dùng khi lệnh chờ lỗi/hết hạn nhưng người dùng đã quét xong. */
  check?(): Promise<boolean>;
  /** Khoảng nghỉ giữa các lần chờ lỗi (ms); mặc định 1500, test đặt nhỏ. */
  retryMs?: number;
}

/** Chỉ nhận ảnh nhúng dạng data URL; mọi giá trị khác bị bỏ để không nạp URL lạ. */
export const safeQr = (v: unknown): string | undefined => (typeof v === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : undefined);

/** Hộp thoại liên kết Zalo bằng mã QR do Gateway cấp; không đọc hay lưu thông tin đăng nhập. */
export function ZaloQr({start, wait, onLinked, onClose, check, retryMs = 1500}: ZaloQrProps) {
  const [qr, setQr] = useState<string | undefined>();
  const [msg, setMsg] = useState('Đang tạo mã QR…');
  const [state, setState] = useState<'loading' | 'scan' | 'done' | 'failed'>('loading');
  const alive = useRef(true);

  const run = async () => {
    setState('loading'); setMsg('Đang tạo mã QR…'); setQr(undefined);
    try {
      let step = await start();
      let current = safeQr(step.qrDataUrl);
      if (!alive.current) return;
      setQr(current); setState('scan'); setMsg(step.message ?? 'Quét mã QR bằng ứng dụng Zalo.');
      let linked = !!step.connected;
      const deadline = Date.now() + 150_000;
      while (alive.current && !linked && Date.now() < deadline) {
        try {
          step = await wait({qrDataUrl: current, sessionKey: step.sessionKey});
        } catch {
          // Lệnh chờ có thể lỗi/hết hạn dù người dùng đã quét xong: đọc trạng thái thật rồi mới chờ tiếp.
          if (!alive.current) return;
          if (await check?.().catch(() => false)) { linked = true; break; }
          await new Promise(r => setTimeout(r, retryMs));
          continue;
        }
        if (!alive.current) return;
        const next = safeQr(step.qrDataUrl);
        if (next) { current = next; setQr(next); }
        if (step.message) setMsg(step.message);
        linked = !!step.connected || (!step.connected && !!(await check?.().catch(() => false)));
      }
      if (!alive.current) return;
      if (!linked && (await check?.().catch(() => false))) linked = true;
      if (linked) { setState('done'); setQr(undefined); setMsg('Đã liên kết Zalo.'); onLinked(); } else { setState('failed'); setMsg('Hết thời gian chờ quét mã.'); }
    } catch {
      if (alive.current) { setState('failed'); setMsg('Không tạo được mã QR. Kiểm tra kênh zalouser đã bật chưa.'); }
    }
  };

  useEffect(() => { void run(); return () => { alive.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="op-chat__overlay">
      <div className="op-chat__modal" role="dialog" aria-modal="true" aria-labelledby="op-zalo-qr-title">
        <h3 id="op-zalo-qr-title">Liên kết Zalo</h3>
        {qr && <img className="op-chat__qr" src={qr} alt="Mã QR đăng nhập Zalo" width="220" height="220" />}
        <p className="op-chat__muted" role="status">{msg}</p>
        <div className="op-chat__empty-actions">
          {state === 'failed' && <button type="button" className="op-chat__btn op-chat__btn--primary" onClick={() => { alive.current = true; void run(); }}>Thử lại</button>}
          <button type="button" className="op-chat__btn" onClick={onClose}>{state === 'done' ? 'Đóng' : 'Hủy'}</button>
        </div>
      </div>
    </div>
  );
}
