import { useId } from 'react';
import type { Channel, NotifySettings } from './policy';

export interface NotificationSettingsProps {
  settings: NotifySettings;
  onChange(next: NotifySettings): void;
  onClose?(): void;
  /** Ghi chú phụ theo kênh, ví dụ "2 tài khoản đang bật". */
  channelNotes?: Partial<Record<Channel, string>>;
}

function Toggle({ label, sub, on, onToggle }: { label: string; sub?: string; on: boolean; onToggle(v: boolean): void }) {
  const id = useId();
  return (
    <div className="op-notify__row">
      <div className="op-notify__row-text">
        <label htmlFor={id} className="op-notify__row-label">{label}</label>
        {sub && <div className="op-notify__row-sub">{sub}</div>}
      </div>
      <button id={id} type="button" role="switch" aria-checked={on} className="op-notify__switch" data-on={on} onClick={() => onToggle(!on)} />
    </div>
  );
}

export function NotificationSettings({ settings: s, onChange, onClose, channelNotes = {} }: NotificationSettingsProps) {
  const flag = (k: Exclude<keyof NotifySettings, 'channels'>) => (v: boolean) => onChange({ ...s, [k]: v });
  const ch = (c: Channel) => (v: boolean) => onChange({ ...s, channels: { ...s.channels, [c]: v } });
  const note = (c: Channel) => (s.channels[c] ? channelNotes[c] : 'Đang tắt');
  return (
    <section className="op-notify__panel" aria-label="Cài đặt thông báo" lang="vi">
      <div className="op-notify__panel-head">
        <h3>Thông báo</h3>
        {onClose && <button type="button" className="op-notify__x" aria-label="Đóng" onClick={onClose}>×</button>}
      </div>
      <div className="op-notify__group">THEO KÊNH</div>
      <Toggle label="Email (Gmail)" sub={note('email')} on={s.channels.email} onToggle={ch('email')} />
      <Toggle label="Zalo" sub={note('zalo')} on={s.channels.zalo} onToggle={ch('zalo')} />
      <Toggle label="Messenger" sub={note('messenger')} on={s.channels.messenger} onToggle={ch('messenger')} />
      <div className="op-notify__group">CÁCH HIỂN THỊ</div>
      <Toggle label="Thông báo trong app" on={s.inApp} onToggle={flag('inApp')} />
      <Toggle label="Thông báo trên hệ thống" sub="Cần cho phép trình duyệt" on={s.system} onToggle={flag('system')} />
      <Toggle label="Âm thanh" on={s.sound} onToggle={flag('sound')} />
      <Toggle label="Hiện nội dung tin nhắn" sub={s.showContent ? undefined : 'Tắt: chỉ hiện “Tin nhắn mới”'} on={s.showContent} onToggle={flag('showContent')} />
      <div className="op-notify__group">LỌC</div>
      <Toggle label="Không báo người lạ, spam, đã chặn" on={s.filterUnknown} onToggle={flag('filterUnknown')} />
      <Toggle label="Không làm phiền 22:00 – 07:00" on={s.quietHours} onToggle={flag('quietHours')} />
    </section>
  );
}
