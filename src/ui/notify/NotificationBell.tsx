export function NotificationBell({ count, onClick }: { count: number; onClick?: () => void }) {
  const n = Math.max(0, Math.floor(count) || 0);
  return (
    <button type="button" className="op-notify__bell" onClick={onClick} aria-label={n ? `Thông báo, ${n} chưa đọc` : 'Thông báo'}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0" />
      </svg>
      {n > 0 && <span className="op-notify__badge">{n > 99 ? '99+' : n}</span>}
    </button>
  );
}
