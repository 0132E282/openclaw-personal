import {requestWithTimeout, type PluginHost} from '../host';

export const ZALO_PERSONAL_CHANNEL = 'zalouser';
/** Phương thức Gateway duy nhất mà thẻ Zalo được gọi (chỉ đọc, không probe). */
export const ZALO_STATUS_METHOD = 'channels.status';

export type ZaloState = 'not-installed' | 'disabled' | 'not-configured' | 'not-linked' | 'error' | 'running' | 'stopped' | 'unknown';
export type ZaloViewState = ZaloState | 'loading' | 'load-failed';

export interface ZaloStatus {
 state: ZaloState;
 accountId: string;
 otherAccountCount: number;
}

export const ZALO_STATE_COPY: Readonly<Record<ZaloViewState, {label: string; hint: string}>> = Object.freeze({
 loading: {label: 'Đang kiểm tra…', hint: 'Đang đọc trạng thái kênh Zalo Personal từ OpenClaw.'},
 'not-installed': {label: 'Chưa cài kênh Zalo Personal', hint: 'Cài kênh bằng lệnh: openclaw plugins install @openclaw/zalouser'},
 disabled: {label: 'Đã tắt', hint: 'Kênh Zalo Personal đang tắt trong cấu hình OpenClaw. Bật lại rồi kiểm tra bằng: openclaw channels status'},
 'not-configured': {label: 'Chưa cấu hình', hint: 'Cấu hình kênh Zalo Personal trong OpenClaw rồi kiểm tra bằng: openclaw channels status'},
 'not-linked': {label: 'Chưa liên kết', hint: 'Đăng nhập (quét QR) bằng lệnh: openclaw channels login --channel zalouser'},
 error: {label: 'Có lỗi', hint: 'Kênh báo lỗi. Xem chi tiết bằng lệnh: openclaw channels status'},
 running: {label: 'Đang hoạt động', hint: 'Kênh Zalo Personal đang chạy trong OpenClaw. Trang này không đọc hay gửi tin nhắn.'},
 stopped: {label: 'Đã liên kết, đang dừng', hint: 'Đã liên kết nhưng kênh đang dừng. Kiểm tra bằng lệnh: openclaw channels status'},
 unknown: {label: 'Không xác định', hint: 'Không hiểu kết quả trạng thái. Kiểm tra bằng lệnh: openclaw channels status'},
 'load-failed': {label: 'Không đọc được trạng thái', hint: 'Không kết nối được Gateway hoặc thiếu quyền đọc trạng thái kênh.'},
});

export const RISK_NOTICE = 'Cảnh báo: Zalo Personal là tích hợp không chính thức, có thể khiến tài khoản bị hạn chế hoặc khóa. Trang này không tự đăng nhập, không bật kênh và không gửi tin.';
export const OFFICIAL_ACCOUNT_NOTICE = 'Zalo OA và Zalo Bot là sản phẩm khác, không thay thế tài khoản cá nhân.';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Phân loại trạng thái từ kết quả channels.status. Hàm thuần, chỉ trả state/accountId/số tài khoản khác;
 * không chép allowFrom, lastError hay trường nhạy cảm nào.
 * Kiểm tra `linked === false` trước lỗi: Gateway thật báo statusIssues kind 'auth' cho tài khoản chưa liên kết.
 */
export function deriveZaloStatus(result: unknown): ZaloStatus {
 const unknown: ZaloStatus = {state: 'unknown', accountId: '', otherAccountCount: 0};
 if (!isRec(result) || !isRec(result.channelAccounts)) return unknown;
 const accounts = result.channelAccounts[ZALO_PERSONAL_CHANNEL];
 if (!Array.isArray(accounts) || accounts.length === 0) return {state: 'not-installed', accountId: '', otherAccountCount: 0};
 const defaults = isRec(result.channelDefaultAccountId) ? result.channelDefaultAccountId[ZALO_PERSONAL_CHANNEL] : undefined;
 const wanted = typeof defaults === 'string' ? defaults : 'default';
 const list = accounts.filter(isRec);
 const account = list.find(a => a.accountId === wanted) ?? list[0];
 if (!account) return unknown;
 const accountId = typeof account.accountId === 'string' ? account.accountId : wanted;
 const otherAccountCount = list.length - 1;
 const done = (state: ZaloState): ZaloStatus => ({state, accountId, otherAccountCount});
 const issues = Array.isArray(result.statusIssues) ? result.statusIssues : [];
 const hasIssue = issues.some(i => isRec(i) && i.channel === ZALO_PERSONAL_CHANNEL);
 const hasError = typeof account.lastError === 'string' && account.lastError !== '';
 if (account.enabled === false) return done('disabled');
 if (account.configured === false) return done('not-configured');
 if (account.linked === false) return done('not-linked');
 if (hasError || hasIssue) return done('error');
 if (account.running === true && account.connected !== false) return done('running');
 if (account.linked === true && account.running !== true) return done('stopped');
 return done('unknown');
}

/** Đọc trạng thái một lần bằng đúng một RPC chỉ đọc; ném lỗi khi quá hạn hoặc bị từ chối. */
export async function loadZaloStatus(host: PluginHost): Promise<ZaloStatus> {
 return deriveZaloStatus(await requestWithTimeout(host, ZALO_STATUS_METHOD, {}));
}

/** Tài khoản Zalo đã liên kết, rút gọn từ channels.status để chọn trong sidebar và hộp thoại đăng xuất. */
export interface ZaloAccountInfo {
 accountId: string;
 /** Tên hiển thị (profile.displayName), thiếu thì dùng accountId. */
 name: string;
 /** URL ảnh đại diện https tới CDN Zalo (đã lọc), nếu có. */
 avatar?: string;
}

const AVATAR_HOSTS = ['zadn.vn', 'zdn.vn', 'zaloapp.com'];
/** Chỉ nhận ảnh https của CDN Zalo; mọi giá trị khác bị bỏ. */
export function safeZaloAvatarUrl(v: unknown): string | undefined {
 if (typeof v !== 'string' || v.length > 600) return undefined;
 try {
  const u = new URL(v);
  return u.protocol === 'https:' && AVATAR_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`)) ? v : undefined;
 } catch {
  return undefined;
 }
}

/** Danh sách tài khoản Zalo đã liên kết (default trước). Phần tử không có accountId được coi là 'default'. */
export function deriveZaloAccounts(result: unknown): ZaloAccountInfo[] {
 if (!isRec(result) || !isRec(result.channelAccounts)) return [];
 const accounts = result.channelAccounts[ZALO_PERSONAL_CHANNEL];
 if (!Array.isArray(accounts)) return [];
 const out: ZaloAccountInfo[] = [];
 for (const a of accounts) {
  if (!isRec(a) || a.enabled === false || a.configured === false) continue;
  const linked = a.linked === true || (a.linked !== false && a.running === true && a.connected !== false);
  if (!linked) continue;
  const accountId = typeof a.accountId === 'string' && a.accountId ? a.accountId : 'default';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(accountId) || out.some(x => x.accountId === accountId)) continue;
  const profile = isRec(a.profile) ? a.profile : {};
  const name = typeof profile.displayName === 'string' && profile.displayName.trim() ? profile.displayName.trim().slice(0, 60) : accountId === 'default' ? 'Zalo' : accountId;
  const avatar = safeZaloAvatarUrl(profile.avatar);
  out.push({accountId, name, ...(avatar ? {avatar} : {})});
 }
 return out.sort((x, y) => Number(y.accountId === 'default') - Number(x.accountId === 'default'));
}

export async function loadZaloAccounts(host: PluginHost): Promise<ZaloAccountInfo[]> {
 return deriveZaloAccounts(await requestWithTimeout(host, ZALO_STATUS_METHOD, {}));
}
