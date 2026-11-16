/** Chính sách thông báo thuần (không DOM, không I/O). */
export type Channel = 'email' | 'zalo' | 'messenger';
export type SenderKind = 'known' | 'stranger' | 'spam' | 'blocked';

export interface NotifyEvent {
  id: string;
  channel: Channel;
  /** Người gửi / tiêu đề hiển thị. */
  title: string;
  body: string;
  sender?: SenderKind;
}

export interface NotifySettings {
  channels: Record<Channel, boolean>;
  inApp: boolean;
  system: boolean;
  sound: boolean;
  showContent: boolean;
  filterUnknown: boolean;
  quietHours: boolean;
}

export type SkipReason = 'channel-off' | 'filtered' | 'quiet-hours' | 'all-off';

export interface NotifyDecision {
  notify: boolean;
  reason?: SkipReason;
  title: string;
  body: string;
  inApp: boolean;
  system: boolean;
  sound: boolean;
}

export const HIDDEN_BODY = 'Tin nhắn mới';
export const QUIET_START_MIN = 22 * 60;
export const QUIET_END_MIN = 7 * 60;

export const DEFAULT_SETTINGS: NotifySettings = {
  channels: { email: true, zalo: true, messenger: false },
  inApp: true,
  system: true,
  sound: true,
  showContent: false,
  filterUnknown: true,
  quietHours: true
};

const CHANNELS: Channel[] = ['email', 'zalo', 'messenger'];
const FLAGS = ['inApp', 'system', 'sound', 'showContent', 'filterUnknown', 'quietHours'] as const;

/** 22:00–07:00 tính theo giờ địa phương, vòng qua nửa đêm. 22:00 thuộc giờ yên lặng, 07:00 thì không. */
export function isQuietHour(now: Date | number): boolean {
  const d = typeof now === 'number' ? new Date(now) : now;
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= QUIET_START_MIN || m < QUIET_END_MIN;
}

export function shouldNotify(event: NotifyEvent, settings: NotifySettings, now: Date | number): NotifyDecision {
  const base = {
    title: event.title,
    body: settings.showContent ? event.body : HIDDEN_BODY,
    inApp: settings.inApp,
    system: settings.system,
    sound: settings.sound
  };
  const skip = (reason: SkipReason): NotifyDecision => ({ ...base, notify: false, reason });
  if (!settings.channels[event.channel]) return skip('channel-off');
  if (settings.filterUnknown && event.sender && event.sender !== 'known') return skip('filtered');
  if (settings.quietHours && isQuietHour(now)) return skip('quiet-hours');
  if (!settings.inApp && !settings.system) return skip('all-off');
  return { ...base, notify: true };
}

/** Chuỗi JSON để lưu. */
export function serializeSettings(s: NotifySettings): string {
  return JSON.stringify(s);
}

/** Đọc cài đặt đã lưu; trường sai kiểu/thiếu lấy mặc định, đầu vào hỏng trả mặc định. */
export function parseSettings(raw: unknown): NotifySettings {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return cloneDefaults(); }
  }
  const out = cloneDefaults();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;
  const ch = o.channels;
  if (ch && typeof ch === 'object') {
    for (const c of CHANNELS) {
      const x = (ch as Record<string, unknown>)[c];
      if (typeof x === 'boolean') out.channels[c] = x;
    }
  }
  for (const f of FLAGS) if (typeof o[f] === 'boolean') out[f] = o[f] as boolean;
  return out;
}

function cloneDefaults(): NotifySettings {
  return { ...DEFAULT_SETTINGS, channels: { ...DEFAULT_SETTINGS.channels } };
}

/** Kho lưu được tiêm từ ngoài; module này không tự chạm localStorage. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export const SETTINGS_KEY = 'openclaw-personal.notify';

export function loadSettings(storage?: SettingsStorage): NotifySettings {
  try { return parseSettings(storage?.getItem(SETTINGS_KEY) ?? null); } catch { return cloneDefaults(); }
}
export function saveSettings(s: NotifySettings, storage?: SettingsStorage): void {
  try { storage?.setItem(SETTINGS_KEY, serializeSettings(s)); } catch { /* kho đầy/bị chặn: bỏ qua */ }
}
