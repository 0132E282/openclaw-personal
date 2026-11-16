import { useState } from 'react';

export type SetupStatus = 'ok' | 'warn' | 'todo';
/** install: cần chạy lệnh (có xác nhận); connect: liên kết tài khoản; check: kiểm tra lại. */
export type SetupActionKind = 'install' | 'connect' | 'check' | 'recheck-all';

export interface SetupItem {
  id: string;
  title: string;
  description: string;
  status: SetupStatus;
  statusLabel: string;
  actionLabel?: string;
  actionKind?: SetupActionKind;
  /** Lệnh sẽ chạy khi cài; chỉ lấy từ props, component không tự bịa. */
  command?: string;
}

export interface SetupGuideProps {
  items: SetupItem[];
  onAction(id: string, kind: SetupActionKind): void;
  /** Gọi duy nhất sau khi người dùng bấm xác nhận. Component không tự chạy lệnh. */
  onConfirmInstall(id: string, command: string): void;
  /** Dạng gọn nằm trong ô của từng kênh: chỉ danh sách thành phần, không tiêu đề và cột các bước. */
  inline?: boolean;
}

const STEPS: Array<[string, string]> = [
  ['Cài thành phần còn thiếu', 'Bấm Cài đặt ở từng dòng bên trái.'],
  ['Kết nối từng kênh', 'Gmail đăng nhập Google, Zalo quét QR, Messenger đăng nhập trình duyệt.'],
  ['Bật thông báo', 'Cho phép thông báo hệ điều hành khi được hỏi.'],
  ['Kiểm tra', 'Gửi thử một tin để xem thông báo và trạng thái xanh.']
];

const defaultKind = (s: SetupStatus): SetupActionKind => (s === 'ok' ? 'check' : s === 'warn' ? 'connect' : 'install');
const defaultLabel = (k: SetupActionKind) => (k === 'check' ? 'Kiểm tra lại' : k === 'connect' ? 'Liên kết' : 'Cài đặt');

export function SetupGuide({ items, onAction, onConfirmInstall, inline }: SetupGuideProps) {
  const [pending, setPending] = useState<SetupItem[] | null>(null);
  const missing = items.filter((i) => i.status === 'todo' && (i.actionKind ?? 'install') === 'install');
  const todoCount = items.filter((i) => i.status !== 'ok').length;

  const click = (it: SetupItem) => {
    const kind = it.actionKind ?? defaultKind(it.status);
    if (kind === 'install') setPending([it]);
    else onAction(it.id, kind);
  };
  const confirm = () => {
    const list = pending ?? [];
    setPending(null);
    for (const it of list) if (it.command) onConfirmInstall(it.id, it.command);
  };

  return (
    <section className={`op-setup${inline ? ' op-setup--inline' : ''}`} aria-label="Hướng dẫn cài đặt" lang="vi">
      <div className="op-setup__main">
        {!inline && <div className="op-setup__summary" role="status">
          <span className={`op-setup__dot op-setup__dot--${todoCount ? 'warn' : 'ok'}`} aria-hidden="true" />
          {todoCount ? `${todoCount} mục cần làm trước khi dùng đầy đủ` : 'Đã sẵn sàng'}
        </div>}
        {!inline && <h2 className="op-setup__title">Hướng dẫn cài đặt</h2>}
        {!inline && <p className="op-setup__lead">Cài các thành phần cần thiết cho từng kênh. Mỗi lần cài đều hiện lệnh sẽ chạy và hỏi xác nhận trước.</p>}
        <div className="op-setup__group">{inline ? 'CẦN CÀI TRƯỚC KHI DÙNG' : 'THÀNH PHẦN CẦN THIẾT'}</div>
        <ul className="op-setup__list">
          {items.map((it) => {
            const kind = it.actionKind ?? defaultKind(it.status);
            return (
              <li key={it.id} className="op-setup__row" data-status={it.status}>
                <div className="op-setup__row-text">
                  <div className="op-setup__row-title">{it.title}</div>
                  <div className="op-setup__row-desc">{it.description}</div>
                </div>
                <span className={`op-setup__chip op-setup__chip--${it.status}`}>
                  <span className={`op-setup__dot op-setup__dot--${it.status}`} aria-hidden="true" />
                  {it.statusLabel}
                </span>
                <button
                  type="button"
                  className={`op-setup__btn${it.status === 'ok' ? '' : ' op-setup__btn--primary'}`}
                  onClick={() => click(it)}
                  aria-label={`${it.actionLabel ?? defaultLabel(kind)} — ${it.title}`}
                >
                  {it.actionLabel ?? defaultLabel(kind)}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="op-setup__actions">
          {(!inline || missing.length > 0) && (
            <button type="button" className="op-setup__btn op-setup__btn--primary" disabled={!missing.length} onClick={() => setPending(missing)}>
              Cài tất cả còn thiếu
            </button>
          )}
          <button type="button" className="op-setup__btn" onClick={() => onAction('all', 'recheck-all')}>
            Kiểm tra lại tất cả
          </button>
        </div>
      </div>

      {!inline && <aside className="op-setup__side">
        <div className="op-setup__group">CÁC BƯỚC</div>
        <ol className="op-setup__steps">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="op-setup__step">
              <span className="op-setup__step-n" aria-hidden="true">{i + 1}</span>
              <div>
                <div className="op-setup__step-title">{t}</div>
                <div className="op-setup__step-desc">{d}</div>
              </div>
            </li>
          ))}
        </ol>
        <p className="op-setup__warn">
          Zalo và Messenger cá nhân là kênh không chính thức, có rủi ro khóa tài khoản. Cookie và token chỉ lưu trên máy này.
        </p>
      </aside>}

      {pending && (
        <div className="op-setup__overlay">
          <div className="op-setup__dialog" role="dialog" aria-modal="true" aria-labelledby="op-setup-confirm-title">
            <h3 id="op-setup-confirm-title">Xác nhận cài đặt</h3>
            <p className="op-setup__dialog-lead">Các lệnh sau sẽ được chạy trên máy này. Chỉ chạy khi bạn bấm Xác nhận.</p>
            {pending.map((it) => (
              <div key={it.id} className="op-setup__cmd">
                <div className="op-setup__cmd-name">{it.title}</div>
                {it.command ? <code>{it.command}</code> : <em>Chưa có lệnh cài đặt cho mục này.</em>}
              </div>
            ))}
            <div className="op-setup__dialog-actions">
              <button type="button" className="op-setup__btn" onClick={() => setPending(null)}>Hủy</button>
              <button type="button" className="op-setup__btn op-setup__btn--primary" disabled={!pending.some((i) => i.command)} onClick={confirm}>
                Xác nhận cài đặt
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
