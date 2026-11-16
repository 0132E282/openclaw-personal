import type { DesktopPermission } from './desktop';

export interface PermissionBarProps {
  permission: DesktopPermission;
  onAllow(): void;
  onLater(): void;
}

/** Thanh xin quyền thông báo desktop; chỉ hiện khi quyền còn 'default'. */
export function PermissionBar({ permission, onAllow, onLater }: PermissionBarProps) {
  if (permission !== 'default') return null;
  return (
    <div className="op-notify__perm" role="region" aria-label="Bật thông báo desktop">
      <div className="op-notify__perm-text">
        <div className="op-notify__perm-title">Bật thông báo desktop</div>
        <div className="op-notify__perm-sub">Nhận báo khi có email, Zalo, Messenger mới kể cả lúc đang ở tab khác.</div>
      </div>
      <button type="button" className="op-notify__btn" onClick={onLater}>Để sau</button>
      <button type="button" className="op-notify__btn op-notify__btn--primary" onClick={onAllow}>Cho phép</button>
    </div>
  );
}
