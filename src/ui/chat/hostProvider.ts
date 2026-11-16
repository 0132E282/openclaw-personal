import {requestWithTimeout, type PluginHost} from '../../host';
import {callOp} from '../email/hostProvider';
import {ChatError, type ChatAccess, type ChatConversation, type ChatFile, type ChatFolder, type ChatMessage, type ChatProvider, type HistoryNotice} from './provider';

const ACCOUNT = {id: 'zalo', name: 'Zalo'};
const unsupported = (): Promise<never> => Promise.reject(new Error('unsupported'));
const UNSUPPORTED_TEXT = 'Zalo chưa cung cấp dữ liệu này cho Hộp thư nên chưa hiển thị được ở bản này.';

interface RemoteConversation {id: string; name: string; kind: 'direct' | 'group'; preview: string; lastAt: string; subtitle?: string}

const DEFAULT_ACCOUNT = 'default';
/** Thông tin đăng nhập của một tài khoản Zalo (từ channels.status, không thăm dò); undefined nếu chưa biết. */
async function currentZaloUserId(host: PluginHost, accountId: string): Promise<string | undefined> {
 try {
  const res = (await requestWithTimeout(host, 'channels.status', {}, 10_000)) as {channelAccounts?: {zalouser?: Array<{accountId?: unknown; profile?: {userId?: unknown}}>}} | null;
  const list = res?.channelAccounts?.zalouser ?? [];
  const entry = list.find(a => a.accountId === accountId) ?? (accountId === DEFAULT_ACCOUNT ? list.find(a => a.accountId === undefined) : undefined);
  const id = entry?.profile?.userId;
  return typeof id === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(id) ? id : undefined;
 } catch {
  return undefined;
 }
}

const ZALO_EVENT = 'plugin.openclaw-personal.zalo-message';
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Gửi qua Gateway đang chạy (dùng phiên Zalo sẵn có, nhanh và hỗ trợ tệp); không dựng CLI mới. */
async function gatewaySend(host: PluginHost, channel: string, conversationId: string, params: Record<string, unknown>, accountId: string): Promise<void> {
 try {
  await requestWithTimeout(host, 'send', {channel, to: conversationId, ...(accountId !== DEFAULT_ACCOUNT ? {accountId} : {}), idempotencyKey: newKey(), ...params}, 60_000);
 } catch (e) {
  throw new Error(e instanceof Error && e.message === 'timeout' ? 'Hết thời gian chờ khi gửi.' : 'Gateway không gửi được tin.');
 }
}

/**
 * Provider Zalo thật cho MỘT tài khoản Hộp thư (`accountId`, mặc định 'default'): mọi operation đều theo tài khoản đó.
 * Tài khoản 'default' không gửi accountId để giữ nguyên hành vi/payload cũ.
 */
export function createHostZaloProvider(host: PluginHost, accountId: string = DEFAULT_ACCOUNT): ChatProvider {
 let synced: string | undefined;
 const acc = accountId !== DEFAULT_ACCOUNT ? {accountId} : {};
 /** Đồng bộ userId trước khi đọc dữ liệu: đăng nhập Zalo khác trong cùng tài khoản thì dữ liệu cũ của tài khoản đó bị xóa. */
 const syncAccount = async () => {
  const userId = await currentZaloUserId(host, accountId);
  if (userId && userId !== synced) {
   await callOp(host, 'zalo.account.sync', {...acc, userId});
   synced = userId;
  }
 };
 /** Báo trước tin người dùng tự gửi để hook chặn quyền của trợ lý AI không chặn nhầm; lỗi thì vẫn gửi. */
 const allowSend = (conversationId: string, text: string) => callOp(host, 'zalo.send.allow', {conversationId, ...(text ? {text} : {}), ...acc}).catch(() => undefined);
 return {
  folderEmptyText: {
   unread: `Thư mục “Chưa đọc” chưa được hỗ trợ: ${UNSUPPORTED_TEXT}`,
   stranger: `Thư mục “Người lạ” chưa được hỗ trợ: ${UNSUPPORTED_TEXT}`,
   blocked: `Thư mục “Đã chặn” chưa được hỗ trợ: ${UNSUPPORTED_TEXT}`,
   spam: `Thư mục “Spam” chưa được hỗ trợ: ${UNSUPPORTED_TEXT}`,
   group: 'Chưa có nhóm Zalo nào trong danh bạ.',
   all: 'Chưa có liên hệ hoặc nhóm Zalo nào trong danh bạ.',
  },
  emptyHistoryText: 'Chưa có tin nhắn nào được lưu cho hội thoại này. Hộp thư chỉ lưu tin đến sau khi bật quyền và tin bạn gửi từ đây; bạn vẫn có thể gửi tin mới.',
  async getHistoryNotice(): Promise<HistoryNotice | null> {
   const r = await callOp<{historyAccess: 'enabled' | 'disabled' | 'unknown'; enableCommand: string}>(host, 'zalo.status');
   if (r.historyAccess === 'enabled') return null;
   return {
    text: 'Chưa lưu được lịch sử tin đến: cần bật quyền truy cập hội thoại cho plugin. Bấm Bật để Hộp thư tự bật, rồi nhắn thử một tin để bắt đầu lưu. Hoặc tự chạy lệnh:',
    command: r.enableCommand,
   };
  },
  async enableHistory() {
   const r = await callOp<{ok: boolean; reason?: string}>(host, 'zalo.history.enable');
   if (!r.ok) throw new Error(r.reason === 'timeout' ? 'Hết thời gian chờ khi bật quyền. Thử lại sau.' : 'Không bật được quyền. Chạy lệnh bên dưới trong terminal.');
  },
  async getAvatar(conversationId: string) {
   const r = await callOp<{avatar: string | null; type?: string}>(host, 'zalo.avatar', {conversationId, ...acc});
   return r.avatar && r.type ? {base64: r.avatar, type: r.type} : undefined;
  },
  async listAccounts() {
   return [ACCOUNT];
  },
  async listConversations({folder}: {folder: ChatFolder}): Promise<ChatConversation[]> {
   if (folder !== 'all' && folder !== 'group') return [];
   await syncAccount();
   const r = await callOp<{conversations: RemoteConversation[]; reason?: string}>(host, 'zalo.conversations', {folder, ...acc});
   if (r.reason === 'loading' && r.conversations.length === 0) throw new Error('Đang tải danh bạ Zalo lần đầu, có thể mất vài phút. Bấm tải lại sau ít phút.');
   if (r.reason && r.conversations.length === 0) throw new Error(r.reason);
   return r.conversations.map(c => ({...c, accountId: ACCOUNT.id, unread: 0}));
  },
  async getMessages(conversationId: string): Promise<ChatMessage[]> {
   const r = await callOp<{messages: ChatMessage[]}>(host, 'zalo.messages', {conversationId, ...acc});
   return r.messages;
  },
  async getAccess(conversationId: string): Promise<ChatAccess> {
   const r = await callOp<{access: ChatAccess}>(host, 'zalo.access.get', {conversationId, ...acc});
   return r.access;
  },
  async setAccess(conversationId: string, access: ChatAccess) {
   const r = await callOp<{ok: boolean}>(host, 'zalo.access.set', {conversationId, access, ...acc});
   if (!r.ok) throw new Error('Không lưu được quyền của trợ lý AI.');
  },
  async send(conversationId: string, text: string) {
   await allowSend(conversationId, text);
   await gatewaySend(host, 'zalouser', conversationId, {message: text}, accountId);
   await callOp(host, 'zalo.message.record', {conversationId, text, ...acc}).catch(() => undefined);
  },
  async sendFile(conversationId: string, file: ChatFile, caption: string) {
   await allowSend(conversationId, caption);
   await gatewaySend(host, 'zalouser', conversationId, {...(caption ? {message: caption} : {}), buffer: file.base64, filename: file.name, contentType: file.type || 'application/octet-stream'}, accountId);
   await callOp(host, 'zalo.message.record', {conversationId, text: `📎 ${file.name}${caption ? ` — ${caption}` : ''}`.slice(0, 2000), ...acc}).catch(() => undefined);
  },
  onNewMessage(listener: () => void) {
   // Sự kiện của tài khoản khác không làm tải lại; thiếu accountId được coi là 'default'.
   return host.onEvent?.(ZALO_EVENT, p => { const a = (p as {accountId?: unknown} | null)?.accountId; if ((typeof a === 'string' ? a : DEFAULT_ACCOUNT) === accountId) listener(); }) ?? (() => undefined);
  },
  acceptStranger: unsupported,
  block: unsupported,
  unblock: unsupported,
  markSpam: unsupported,
  notSpam: unsupported,
  deleteConversation: unsupported,
 };
}

// ---- Messenger ----

const MESSENGER_ACCOUNT = {id: 'messenger', name: 'Messenger'};
const MESSENGER_REASON_TEXT: Record<string, string> = {
 'not-logged-in': 'Phiên đăng nhập Facebook đã hết hạn. Hãy kết nối lại Messenger.',
 checkpoint: 'Facebook đang yêu cầu xác minh bảo mật (checkpoint). Xác minh trên Facebook rồi kết nối lại Messenger.',
 'e2ee-locked': 'Cuộc trò chuyện mã hóa đầu-cuối cần mã PIN nên Hộp thư chưa đọc được.',
 'selector-broken': 'Facebook có vẻ đã đổi giao diện nên Hộp thư chưa đọc được tin. Cần cập nhật plugin.',
 'browser-missing': 'Không tìm thấy Google Chrome/Chromium để đọc Messenger.',
 timeout: 'Facebook phản hồi quá chậm. Thử lại sau.',
 'launch-failed': 'Không khởi động được trình duyệt nền để đọc Messenger.',
 'rate-limited': 'Bạn đã gửi quá nhiều tin trong thời gian ngắn. Chờ một lát rồi thử lại.',
 'invalid-input': 'Nội dung hoặc hội thoại không hợp lệ.',
};
/** Lý do mà cookie không còn dùng được: UI phải quay lại màn hình kết nối. */
const MESSENGER_AUTH_LOST = ['not-logged-in', 'checkpoint'];
const UNSUPPORTED_MESSENGER = 'Hộp thư chưa đọc được mục này của Messenger ở bản này.';

/**
 * Đổi nhãn thời gian Facebook hiển thị ("5 phút", "2 giờ", "12:30", "3 ngày"...) thành ISO; không hiểu thì ''.
 * Nhãn chỉ là xấp xỉ nên kết quả cũng xấp xỉ (dùng để hiển thị giờ/ngày trong danh sách).
 */
export function messengerTimeToIso(label: string, now: Date = new Date()): string {
 const t = label.trim().toLowerCase();
 const clock = /^(\d{1,2}):(\d{2})$/.exec(t);
 if (clock) {
  const d = new Date(now);
  d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
  return d > now ? new Date(d.getTime() - 86_400_000).toISOString() : d.toISOString();
 }
 const rel = /^(\d{1,3})\s*(m|min|mins|phút|h|hr|hrs|giờ|d|ngày|w|tuần)$/.exec(t);
 if (!rel) return '';
 const unit = rel[2];
 const ms = /^(m|min|mins|phút)$/.test(unit) ? 60_000 : /^(h|hr|hrs|giờ)$/.test(unit) ? 3_600_000 : /^(d|ngày)$/.test(unit) ? 86_400_000 : 604_800_000;
 return new Date(now.getTime() - Number(rel[1]) * ms).toISOString();
}

interface MessengerResult {ok: boolean; reason?: string}

/**
 * Provider Messenger thật: đọc/gửi qua các operation `messenger.*` (trình duyệt ẩn trong dịch vụ Rust).
 * Chỉ hỗ trợ văn bản; chưa có ảnh/tệp, chat mã hóa đầu-cuối, tin chờ/đã chặn/spam.
 * `onAuthLost` được gọi khi Facebook báo cookie hết hạn/checkpoint để shell kiểm tra lại trạng thái kết nối.
 */
export function createHostMessengerProvider(host: PluginHost, opts: {onAuthLost?: () => void} = {}): ChatProvider {
 const check = (r: MessengerResult): void => {
  if (r.ok) return;
  const reason = r.reason ?? 'launch-failed';
  if (MESSENGER_AUTH_LOST.includes(reason)) opts.onAuthLost?.();
  throw new ChatError(reason, MESSENGER_REASON_TEXT[reason] ?? 'Không đọc được Messenger.');
 };
 return {
  folderEmptyText: {
   stranger: `Tin nhắn chờ chưa được hỗ trợ: ${UNSUPPORTED_MESSENGER}`,
   blocked: `Tin nhắn đã chặn chưa được hỗ trợ: ${UNSUPPORTED_MESSENGER}`,
   spam: `Tin nhắn spam chưa được hỗ trợ: ${UNSUPPORTED_MESSENGER}`,
   unread: 'Không có hội thoại Messenger nào chưa đọc.',
   group: 'Không thấy nhóm Messenger nào trong danh sách gần đây.',
   all: 'Không thấy hội thoại Messenger nào. Chat mã hóa đầu-cuối không hiển thị ở đây.',
  },
  emptyHistoryText: 'Chưa đọc được tin nào trong hội thoại này. Bạn vẫn có thể gửi tin mới.',
  async listAccounts() {
   return [MESSENGER_ACCOUNT];
  },
  async listConversations({folder}: {folder: ChatFolder}): Promise<ChatConversation[]> {
   const r = await callOp<MessengerResult & {conversations: Array<{id: string; title: string; snippet: string; time: string; unread: boolean; isGroup: boolean}>}>(host, 'messenger.conversations', {folder});
   check(r);
   return r.conversations.map(c => ({id: c.id, accountId: MESSENGER_ACCOUNT.id, name: c.title, kind: c.isGroup ? 'group' : 'direct', preview: c.snippet, lastAt: messengerTimeToIso(c.time), unread: c.unread ? 1 : 0}));
  },
  async getMessages(conversationId: string): Promise<ChatMessage[]> {
   const r = await callOp<MessengerResult & {messages: Array<{id: string; from: 'me' | 'them'; senderName: string; text: string; time: string}>}>(host, 'messenger.messages', {conversationId});
   check(r);
   return r.messages.map(m => ({id: m.id, at: messengerTimeToIso(m.time), text: m.text, fromMe: m.from === 'me', ...(m.senderName ? {author: m.senderName} : {})}));
  },
  async send(conversationId: string, text: string) {
   check(await callOp<MessengerResult>(host, 'messenger.send', {conversationId, text}));
  },
  acceptStranger: unsupported,
  block: unsupported,
  unblock: unsupported,
  markSpam: unsupported,
  notSpam: unsupported,
  deleteConversation: unsupported,
 };
}
