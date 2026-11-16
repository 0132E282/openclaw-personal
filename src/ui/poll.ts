import {useEffect, useRef} from 'react';

/**
 * Làm mới định kỳ (host chỉ có request, không có push nên "realtime" = polling nhẹ).
 * Chỉ chạy khi tab hiển thị, bỏ lượt nếu lượt trước chưa xong, dừng khi unmount; `ms <= 0` hoặc `enabled=false` thì tắt.
 * `task` nhận `isLive()` để bỏ kết quả đến muộn sau khi dừng.
 */
export function usePoll(task: (isLive: () => boolean) => Promise<unknown>, ms: number, enabled: boolean): void {
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    if (!enabled || !(ms > 0)) return;
    let live = true;
    let busy = false;
    const visible = () => document.visibilityState === 'visible';
    const run = () => {
      if (!live || busy || !visible()) return;
      busy = true;
      latest.current(() => live).catch(() => { /* lượt sau thử lại, không làm phiền người dùng */ }).finally(() => { busy = false; });
    };
    const timer = setInterval(run, ms);
    document.addEventListener('visibilitychange', run);
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', run); };
  }, [ms, enabled]);
}
