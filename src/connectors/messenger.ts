import {requestWithTimeout, type PluginHost} from '../host';

export const MESSENGER_CHANNEL_ID = 'fb-messenger';
export const MESSENGER_SCOPE = 'facebook-page';
export const MESSENGER_STATUS_METHOD = 'channels.status';
export const MESSENGER_DISCLAIMER = 'Kênh Facebook Page/Instagram (plugin bên thứ ba), không phải Messenger cá nhân.';
export const MESSENGER_TIMEOUT_MS = 8000;

export type MessengerState = 'unavailable' | 'installed' | 'configured' | 'running' | 'unknown';

/** Chỉ các khóa này được phép ra khỏi connector; không có token, lỗi thô hay nội dung tin nhắn. */
export interface MessengerStatus {
 channelId: typeof MESSENGER_CHANNEL_ID;
 scope: typeof MESSENGER_SCOPE;
 state: MessengerState;
 accountCount: number;
 runningCount: number;
 reason: string | null;
 label: string;
 disclaimer: string;
}

export const MESSENGER_STATE_LABEL: Readonly<Record<MessengerState, string>> = Object.freeze({
 unavailable: 'Chưa cài kênh Facebook Messenger (Page/Instagram)',
 installed: 'Đã cài, chưa có tài khoản',
 configured: 'Đã cấu hình, chưa chạy',
 running: 'Đang hoạt động',
 unknown: 'Không xác định',
});

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function build(state: MessengerState, accountCount = 0, runningCount = 0, reason: string | null = null): MessengerStatus {
 return {channelId: MESSENGER_CHANNEL_ID, scope: MESSENGER_SCOPE, state, accountCount, runningCount, reason, label: MESSENGER_STATE_LABEL[state], disclaimer: MESSENGER_DISCLAIMER};
}

/** Hàm thuần: chuẩn hóa kết quả channels.status cho kênh 'fb-messenger' (không dò alias 'messenger'). */
export function normalizeMessengerStatus(raw: unknown): MessengerStatus {
 if (!isRec(raw) || !isRec(raw.channelAccounts)) return build('unknown', 0, 0, 'Kết quả trạng thái không đúng dạng.');
 const accounts = raw.channelAccounts[MESSENGER_CHANNEL_ID];
 const listed = Array.isArray(raw.channelOrder) && raw.channelOrder.includes(MESSENGER_CHANNEL_ID);
 if (!Array.isArray(accounts)) return listed ? build('installed') : build('unavailable');
 const list = accounts.filter(isRec);
 if (list.length === 0) return build('installed');
 const runningCount = list.filter(a => a.running === true).length;
 return build(runningCount > 0 ? 'running' : 'configured', list.length, runningCount);
}

/** Đọc trạng thái một lần bằng đúng một RPC chỉ đọc; mọi lỗi thành 'unknown' với lý do ngắn. */
export async function readMessengerStatus(host: Partial<PluginHost> | undefined, options: {signal?: AbortSignal; timeoutMs?: number} = {}): Promise<MessengerStatus> {
 if (typeof host?.request !== 'function') return build('unknown', 0, 0, 'Trang không có kết nối tới Gateway.');
 try {
  options.signal?.throwIfAborted();
  const raw = await requestWithTimeout(host as PluginHost, MESSENGER_STATUS_METHOD, {}, options.timeoutMs ?? MESSENGER_TIMEOUT_MS);
  options.signal?.throwIfAborted();
  return normalizeMessengerStatus(raw);
 } catch (error) {
  if (options.signal?.aborted) throw error;
  return build('unknown', 0, 0, 'Không đọc được trạng thái kênh.');
 }
}
