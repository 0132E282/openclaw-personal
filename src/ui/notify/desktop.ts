/** Bọc mỏng Notification API của trình duyệt; không bao giờ ném lỗi. */
export type DesktopPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export interface NotificationLike {
  onclick: ((ev: unknown) => void) | null;
  close(): void;
}
export interface NotificationCtor {
  new (title: string, options?: { body?: string; tag?: string; silent?: boolean }): NotificationLike;
  permission: string;
  requestPermission(): Promise<string> | string;
}

export interface DesktopNotifier {
  permission(): DesktopPermission;
  request(): Promise<DesktopPermission>;
  show(title: string, body: string, opts?: { tag?: string; silent?: boolean; onClick?: () => void }): boolean;
}

function normalize(p: unknown): DesktopPermission {
  return p === 'granted' || p === 'denied' || p === 'default' ? p : 'default';
}

/** `ctor` có thể tiêm (test); mặc định lấy globalThis.Notification nếu có. */
export function createDesktopNotifier(ctor?: NotificationCtor | null): DesktopNotifier {
  const get = (): NotificationCtor | undefined =>
    ctor === null ? undefined : ctor ?? (globalThis as { Notification?: NotificationCtor }).Notification;
  return {
    permission() {
      const N = get();
      return N ? normalize(N.permission) : 'unsupported';
    },
    async request() {
      const N = get();
      if (!N) return 'unsupported';
      try { return normalize(await N.requestPermission()); } catch { return this.permission(); }
    },
    show(title, body, opts = {}) {
      const N = get();
      if (!N || normalize(N.permission) !== 'granted') return false;
      try {
        const n = new N(title, { body, tag: opts.tag, silent: opts.silent });
        if (opts.onClick) n.onclick = () => { try { opts.onClick?.(); } finally { n.close(); } };
        return true;
      } catch { return false; }
    }
  };
}
