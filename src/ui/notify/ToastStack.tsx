import type { Channel } from './policy';

export interface ToastItem {
  id: string;
  channel: Channel;
  /** Nhãn ứng dụng, ví dụ "Zalo", "Email · katri@gmail.com". */
  app: string;
  title: string;
  body: string;
  time: string;
}

export interface ToastStackProps {
  toasts: ToastItem[];
  onOpen(id: string): void;
  onRead(id: string): void;
  onDismiss?(id: string): void;
}

export function ToastStack({ toasts, onOpen, onRead, onDismiss }: ToastStackProps) {
  if (!toasts.length) return null;
  return (
    <div className="op-notify__stack" role="region" aria-live="polite" aria-label="Thông báo mới">
      {toasts.map((t) => (
        <div key={t.id} className="op-notify__toast" data-channel={t.channel}>
          <div className="op-notify__toast-head">
            <span className="op-notify__toast-app">{t.app}</span>
            <span className="op-notify__toast-time">{t.time}</span>
            {onDismiss && (
              <button type="button" className="op-notify__x" aria-label="Đóng thông báo" onClick={() => onDismiss(t.id)}>×</button>
            )}
          </div>
          <div className="op-notify__toast-title">{t.title}</div>
          <div className="op-notify__toast-body">{t.body}</div>
          <div className="op-notify__toast-actions">
            <button type="button" className="op-notify__btn op-notify__btn--primary" onClick={() => onOpen(t.id)}>Mở</button>
            <button type="button" className="op-notify__btn" onClick={() => onRead(t.id)}>Đã đọc</button>
          </div>
        </div>
      ))}
    </div>
  );
}
