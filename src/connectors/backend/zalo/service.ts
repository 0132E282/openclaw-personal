/**
 * Nối cli + store thành handler cho operation `zalo.*` và bộ ghi tin đến từ hook `message_received`.
 * Danh bạ lấy từ CLI chậm nên được cache ngắn; tin đến/đi lưu cục bộ vì CLI không đọc được lịch sử zalouser.
 */
import type {ZaloCli, DirectoryEntry} from './cli';
import {ZALO_ACCOUNT_ID_PATTERN, ZALO_CHANNEL, ZALO_CONVERSATION_ACCESS_COMMAND, ZALO_OPERATION_IDS as ID, ZALO_SUPPORTED_FOLDERS} from './contract';
import type {AvatarStore} from './avatars';
import {DEFAULT_ZALO_ACCESS, DEFAULT_ZALO_ACCOUNT, type AccessStore, type StoredMessage, type ZaloAccess, type ZaloStore} from './store';

export type HistoryAccess = 'enabled' | 'disabled' | 'unknown';
const PLUGIN_ID = 'openclaw-personal';
/** Sau khi tải lỗi toàn bộ, đợi chừng này mới thử lại để không treo CLI nặng liên tục. */
const RETRY_AFTER_FAIL_MS = 30_000;
const DIRECTORY_TTL_MS = 10 * 60_000;
const ID_RE = /^(group:)?[0-9A-Za-z_-]{1,64}$/;
const ACCOUNT_RE = new RegExp(ZALO_ACCOUNT_ID_PATTERN);
const ACCESS_VALUES: readonly string[] = ['write', 'read', 'none'];
/** Tin người dùng tự gửi từ Hộp thư được hook message_sending cho qua trong khoảng này sau khi báo trước. */
const SEND_GRANT_MS = 30_000;
const MAX_SEND_GRANTS = 50;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);

/** Đọc cờ quyền hội thoại của plugin từ cấu hình OpenClaw (chỉ đọc). Không có cấu hình thì 'unknown'. */
export function detectHistoryAccess(config: unknown): HistoryAccess {
 if (!isRec(config)) return 'unknown';
 const plugins = isRec(config.plugins) ? config.plugins : undefined;
 const entries = plugins && isRec(plugins.entries) ? plugins.entries : undefined;
 const entry = entries && isRec(entries[PLUGIN_ID]) ? (entries[PLUGIN_ID] as Record<string, unknown>) : undefined;
 const hooks = entry && isRec(entry.hooks) ? entry.hooks : undefined;
 return hooks?.allowConversationAccess === true ? 'enabled' : 'disabled';
}

export interface RecordedMessage {
 /** Tài khoản Zalo nhận/gửi tin (ctx.accountId của hook; thiếu thì 'default'). */
 accountId: string;
 conversationId: string;
 kind: 'direct' | 'group';
 name?: string;
 message: StoredMessage;
}

function toIso(v: unknown, now: number): string {
 if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
 if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
 return new Date(now).toISOString();
}

/** ctx.accountId của hook; thiếu thì 'default', sai dạng thì undefined (bỏ tin thay vì ghi nhầm tài khoản). */
function accountOfCtx(ctx: Record<string, unknown>): string | undefined {
 if (ctx.accountId === undefined || ctx.accountId === null || ctx.accountId === '') return DEFAULT_ZALO_ACCOUNT;
 const id = str(ctx.accountId);
 return id && ACCOUNT_RE.test(id) ? id : undefined;
}

/**
 * Chuẩn hóa sự kiện message_received của kênh zalouser; trả undefined cho kênh khác hoặc dữ liệu thiếu.
 * Tên trường theo docs hook (threadId, messageId, senderId, content, metadata); chưa kiểm chứng với tin Zalo thật,
 * nên đọc rộng rãi và bỏ qua những gì không nhận ra.
 */
export function normalizeInbound(event: unknown, ctx: unknown, now: number): RecordedMessage | undefined {
 const e = isRec(event) ? event : {};
 const c = isRec(ctx) ? ctx : {};
 const meta = isRec(e.metadata) ? e.metadata : {};
 const channel = str(c.channelId) ?? str(e.channelId) ?? str(c.messageProvider) ?? str(meta.provider) ?? str(meta.surface);
 if (channel !== ZALO_CHANNEL) return undefined;
 const accountId = accountOfCtx(c);
 if (!accountId) return undefined;
 const text = typeof e.content === 'string' ? e.content : '';
 if (!text.trim()) return undefined;
 const strip = (s: string | undefined) => s?.replace(/^zalouser:/i, '');
 const sender = strip(str(e.senderId) ?? str(c.senderId) ?? str(e.from));
 const thread = strip(str(e.threadId) ?? str(c.conversationId) ?? str(meta.threadId));
 const isGroup = thread?.startsWith('group:') === true || meta.isGroup === true || meta.chatType === 'group';
 let conversationId = isGroup ? (thread ?? '') : (sender ?? thread ?? '');
 if (isGroup && !conversationId.startsWith('group:')) conversationId = `group:${conversationId}`;
 if (!ID_RE.test(conversationId)) return undefined;
 const senderName = str(meta.senderName) ?? str(meta.pushName) ?? str(meta.displayName);
 const at = toIso(e.timestamp ?? meta.timestamp, now);
 const id = (str(e.messageId) ?? str(c.messageId) ?? `in-${Date.parse(at)}-${text.length}`).slice(0, 80);
 return {
  accountId,
  conversationId,
  kind: isGroup ? 'group' : 'direct',
  ...(!isGroup && senderName ? {name: senderName} : {}),
  message: {id, at, text, fromMe: false, ...(isGroup ? {author: senderName ?? sender} : {})},
 };
}

/** Tin gửi đi (hook message_sent): tên trường chưa có trong tài liệu nên đọc rộng, chỉ nhận khi gửi thành công. */
export function normalizeOutbound(event: unknown, ctx: unknown, now: number): RecordedMessage | undefined {
 const e = isRec(event) ? event : {};
 const c = isRec(ctx) ? ctx : {};
 const meta = isRec(e.metadata) ? e.metadata : {};
 const channel = str(c.channelId) ?? str(e.channelId) ?? str(meta.provider) ?? str(meta.surface);
 if (channel !== ZALO_CHANNEL || e.success === false) return undefined;
 const accountId = accountOfCtx(c);
 if (!accountId) return undefined;
 const text = [e.content, e.text, e.message].find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? '';
 if (!text) return undefined;
 const strip = (v: string | undefined) => v?.replace(/^zalouser:/i, '');
 const target = strip(str(e.to) ?? str(e.target) ?? str(e.threadId) ?? str(c.conversationId) ?? str(meta.threadId));
 if (!target || !ID_RE.test(target)) return undefined;
 const ids = Array.isArray(e.messageIds) ? e.messageIds : [];
 const id = (str(e.messageId) ?? str(ids[0]) ?? `out-${now}-${text.length}`).slice(0, 80);
 return {accountId, conversationId: target, kind: target.startsWith('group:') ? 'group' : 'direct', message: {id, at: toIso(e.timestamp ?? meta.timestamp, now), text, fromMe: true}};
}

/** Đích gửi/hội thoại từ hook: bỏ tiền tố kênh, tiền tố 'user:'; trả undefined nếu không phải id hợp lệ. */
const cleanTarget = (v: string | undefined): string | undefined => {
 const t = v?.replace(/^zalouser:/i, '').replace(/^user:/i, '');
 return t && ID_RE.test(t) ? t : undefined;
};

/**
 * Hội thoại + tài khoản của sự kiện before_dispatch (event {channel,isGroup,senderId}, ctx {channelId,accountId,conversationId,senderId});
 * undefined nếu không phải zalouser hoặc không suy ra được. Tin riêng: id hội thoại là người gửi (khớp normalizeInbound).
 */
export function conversationOfDispatch(event: unknown, ctx: unknown): {accountId: string; conversationId: string} | undefined {
 const e = isRec(event) ? event : {};
 const c = isRec(ctx) ? ctx : {};
 if ((str(c.channelId) ?? str(e.channel)) !== ZALO_CHANNEL) return undefined;
 const accountId = accountOfCtx(c);
 if (!accountId) return undefined;
 const thread = str(c.conversationId)?.replace(/^zalouser:/i, '');
 const isGroup = e.isGroup === true || thread?.startsWith('group:') === true;
 let id = isGroup ? thread : (str(e.senderId) ?? str(c.senderId) ?? thread);
 id = id?.replace(/^zalouser:/i, '').replace(/^user:/i, '');
 if (id && isGroup && !id.startsWith('group:')) id = `group:${id}`;
 const conversationId = cleanTarget(id);
 return conversationId ? {accountId, conversationId} : undefined;
}

/** Hội thoại + tài khoản của sự kiện message_sending (event {to,content}, ctx {channelId,accountId,conversationId}). */
export function conversationOfSending(event: unknown, ctx: unknown): {accountId: string; conversationId: string; content: string} | undefined {
 const e = isRec(event) ? event : {};
 const c = isRec(ctx) ? ctx : {};
 const meta = isRec(e.metadata) ? e.metadata : {};
 if ((str(c.channelId) ?? str(meta.channel)) !== ZALO_CHANNEL) return undefined;
 const accountId = accountOfCtx(c);
 const conversationId = cleanTarget(str(e.to) ?? str(c.conversationId));
 return accountId && conversationId ? {accountId, conversationId, content: typeof e.content === 'string' ? e.content : ''} : undefined;
}

export interface ZaloAccountData {
 store: ZaloStore;
 /** Quyền của trợ lý AI theo hội thoại. */
 access?: AccessStore;
 /** Lưu avatar/danh bạ riêng của tài khoản (thư mục con theo account). */
 avatars?: AvatarStore;
 /** userId Zalo mà dữ liệu cục bộ của tài khoản này thuộc về; khác userId đang đăng nhập thì xóa sạch dữ liệu tài khoản đó. */
 account?: {load(): Promise<string | undefined>; save(userId: string): Promise<void>};
 /** Lưu danh bạ lần tải gần nhất để mở lại không phải chờ CLI chậm. */
 snapshot?: {load(): Promise<DirectoryEntry[] | undefined>; save(entries: DirectoryEntry[]): Promise<void>};
}

export interface ZaloServiceDeps extends Partial<ZaloAccountData> {
 cli: ZaloCli;
 /** Cấu hình OpenClaw hiện tại (hoặc undefined nếu không đọc được). */
 getConfig: () => unknown;
 now?: () => number;
 /**
  * Bộ dữ liệu riêng của từng tài khoản (gọi một lần cho mỗi id). Bỏ qua thì store/avatars/account/snapshot ở trên
  * được dùng cho mọi tài khoản (chỉ hợp lý khi chỉ có 'default').
  */
 forAccount?: (accountId: string) => ZaloAccountData;
}

const reasonOf = (e: unknown): 'cli-missing' | 'timeout' | 'failed' => {
 const code = (e as {code?: unknown} | null)?.code;
 return code === 'cli-missing' || code === 'timeout' ? code : 'failed';
};

/** Trạng thái chạy (cache danh bạ, làm mới nền) của riêng một tài khoản. */
interface AccountRuntime {
 data: ZaloAccountData;
 cache?: {entries: DirectoryEntry[]; at: number};
 loaded: boolean;
 refreshing?: Promise<void>;
 failedAt: number;
 gen: number;
 lastReason?: 'cli-missing' | 'timeout' | 'failed';
}

export function createZaloService(deps: ZaloServiceDeps) {
 const now = deps.now ?? Date.now;
 const runtimes = new Map<string, AccountRuntime>();
 let seq = 0;
 let lastAddBase = '';
 let addSeq = 0;

 const access = (): HistoryAccess => detectHistoryAccess(deps.getConfig());
 /** accountId trong input: bỏ qua = 'default'; sai dạng = undefined (handler từ chối thay vì dùng nhầm tài khoản). */
 const accountIn = (input: unknown): string | undefined => {
  const v = isRec(input) ? input.accountId : undefined;
  if (v === undefined) return DEFAULT_ZALO_ACCOUNT;
  return typeof v === 'string' && ACCOUNT_RE.test(v) ? v : undefined;
 };
 const rt = (id: string): AccountRuntime => {
  let r = runtimes.get(id);
  if (!r) {
   const data: ZaloAccountData = deps.forAccount ? deps.forAccount(id) : {store: deps.store!, access: deps.access, avatars: deps.avatars, account: deps.account, snapshot: deps.snapshot};
   runtimes.set(id, (r = {data, loaded: false, failedAt: 0, gen: 0}));
  }
  return r;
 };
 /** Tham số CLI: tài khoản mặc định không truyền để CLI tự chọn. */
 const cliAccount = (id: string) => (id === DEFAULT_ZALO_ACCOUNT ? undefined : id);

 /** Nhóm trước (nhanh hơn), rồi liên hệ; mỗi nhánh xong là cập nhật cache ngay để UI thấy sớm. Chạy nền, không chặn UI. */
 function refresh(id: string): Promise<void> {
  const a = rt(id);
  a.refreshing ??= (async () => {
   const g = a.gen;
   const parts: Record<'direct' | 'group', DirectoryEntry[] | undefined> = {direct: undefined, group: undefined};
   a.lastReason = undefined;
   for (const kind of ['group', 'direct'] as const) {
    try {
     parts[kind] = await deps.cli.list(kind, cliAccount(id));
    } catch (e) {
     a.lastReason = reasonOf(e);
    }
    if (g !== a.gen) return; // đã đổi userId của tài khoản này: bỏ kết quả cũ
    const prev = a.cache?.entries ?? [];
    const keep = (k: 'direct' | 'group') => parts[k] ?? prev.filter((x) => x.kind === k);
    if (parts.direct || parts.group) a.cache = {entries: [...keep('direct'), ...keep('group')], at: now()};
   }
   if (a.cache && (parts.direct || parts.group)) await a.data.snapshot?.save(a.cache.entries).catch(() => undefined);
   if (a.cache) void a.data.avatars?.ensure(a.cache.entries);
  })().finally(() => { a.refreshing = undefined; if (!a.cache) a.failedAt = now(); });
  return a.refreshing;
 }

 async function directory(id: string): Promise<{entries: DirectoryEntry[]; reason?: 'cli-missing' | 'timeout' | 'failed' | 'loading'}> {
  const a = rt(id);
  if (!a.loaded) {
   a.loaded = true;
   await a.data.avatars?.ready();
   const saved = await a.data.snapshot?.load().catch(() => undefined);
   if (saved?.length) {
    a.cache = {entries: saved, at: 0};
    void a.data.avatars?.ensure(saved); // snapshot đã có URL ảnh: tải ngay, không đợi CLI chậm
   }
  }
  const retryOk = !a.cache && (!a.failedAt || now() - a.failedAt >= RETRY_AFTER_FAIL_MS);
  if (retryOk || (a.cache && now() - a.cache.at >= DIRECTORY_TTL_MS)) void refresh(id);
  if (a.cache) return {entries: a.cache.entries};
  return {entries: [], reason: a.refreshing || !a.lastReason ? 'loading' : a.lastReason};
 }

 /** Gọi với userId Zalo đang đăng nhập của tài khoản; khác lần trước (hoặc chưa biết) thì xóa danh bạ, ảnh và lịch sử của CHÍNH tài khoản đó. */
 async function syncAccount(input: unknown) {
  const id = accountIn(input);
  const userId = isRec(input) ? String(input.userId) : '';
  if (!id || !ID_RE.test(userId)) return {ok: false, reset: false};
  const a = rt(id);
  if ((await a.data.account?.load()) === userId) return {ok: true, reset: false};
  a.gen++;
  a.cache = undefined;
  a.refreshing = undefined;
  a.failedAt = 0;
  a.lastReason = undefined;
  a.loaded = true; // không nạp lại snapshot cũ
  await Promise.all([a.data.snapshot?.save([]).catch(() => undefined), a.data.avatars?.clear(), a.data.store.clear()]);
  await a.data.account?.save(userId);
  return {ok: true, reset: true};
 }

 async function status() {
  return {historyAccess: access(), enableCommand: ZALO_CONVERSATION_ACCESS_COMMAND};
 }

 async function conversations(input: unknown) {
  const folder = isRec(input) ? String(input.folder) : 'all';
  const acc = accountIn(input);
  if (!acc || !ZALO_SUPPORTED_FOLDERS.includes(folder)) return {conversations: [], supported: false};
  const {data} = rt(acc);
  const [{entries, reason}, stored] = await Promise.all([directory(acc), data.store.summaries()]);
  const byId = new Map(stored.map((s) => [s.id, s]));
  const rows = entries.map((d) => {
   const s = byId.get(d.id);
   byId.delete(d.id);
   return {id: d.id, name: d.name, kind: d.kind, preview: s?.preview ?? '', lastAt: s?.lastAt ?? '', ...(data.avatars?.get(d.id) ? {hasAvatar: true} : {}), ...(d.memberCount !== undefined ? {subtitle: `${d.memberCount} thành viên`} : {})};
  });
  // Hội thoại đã có tin lưu nhưng không nằm trong danh bạ (ví dụ người chưa kết bạn).
  for (const s of byId.values()) rows.push({id: s.id, name: s.name ?? s.id, kind: s.kind, preview: s.preview, lastAt: s.lastAt, ...(data.avatars?.get(s.id) ? {hasAvatar: true} : {})});
  const shown = folder === 'group' ? rows.filter((r) => r.kind === 'group') : rows;
  shown.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '') || a.name.localeCompare(b.name, 'vi'));
  return {conversations: shown.slice(0, 1000), supported: true, ...(reason ? {reason} : {})};
 }

 async function messages(input: unknown) {
  const id = isRec(input) ? String(input.conversationId) : '';
  const acc = accountIn(input);
  const list = acc ? await rt(acc).data.store.messages(id) : [];
  const out = list.map((m) => ({id: m.id, at: m.at, text: m.text, fromMe: m.fromMe, ...(m.author ? {author: m.author} : {})}));
  return {messages: out, unavailable: access() === 'enabled' ? null : ('conversation-access-disabled' as const)};
 }

 async function send(input: unknown) {
  const id = isRec(input) && typeof input.conversationId === 'string' ? input.conversationId : '';
  const text = isRec(input) && typeof input.text === 'string' ? input.text : '';
  const acc = accountIn(input);
  if (!acc || !ID_RE.test(id) || !text.trim() || text.length > 2000) return {ok: false, reason: 'invalid-input' as const};
  try {
   await deps.cli.send(id, text, cliAccount(acc));
  } catch (e) {
   return {ok: false, reason: reasonOf(e)};
  }
  // Lưu tin đã gửi; lỗi ghi file không làm hỏng kết quả gửi.
  const t = now();
  await rt(acc).data.store.append({conversationId: id, kind: id.startsWith('group:') ? 'group' : 'direct', message: {id: `out-${t}-${seq++}`, at: new Date(t).toISOString(), text, fromMe: true}}).catch(() => false);
  return {ok: true};
 }

 /** Gọi từ hook message_received; không bao giờ ném. Trả về nơi tin được lưu để phát sự kiện. */
 async function record(event: unknown, ctx: unknown): Promise<{conversationId: string; accountId: string} | undefined> {
  try {
   const r = normalizeInbound(event, ctx, now());
   if (r && (await rt(r.accountId).data.store.append(r))) return {conversationId: r.conversationId, accountId: r.accountId};
  } catch {
   // không chặn luồng xử lý tin của OpenClaw
  }
  return undefined;
 }

 /** Tin gửi đi có thể đến từ app (messageRecord) và từ hook message_sent: bỏ bản trùng cùng nội dung trong 60 giây. */
 async function appendOutbound(r: RecordedMessage): Promise<boolean> {
  const {store} = rt(r.accountId).data;
  const recent = (await store.messages(r.conversationId)).slice(-10);
  const t = Date.parse(r.message.at);
  if (recent.some((m) => m.fromMe && m.text === r.message.text.slice(0, 4000) && Math.abs(Date.parse(m.at) - t) < 60_000)) return false;
  return store.append(r);
 }

 async function recordSent(event: unknown, ctx: unknown): Promise<{conversationId: string; accountId: string} | undefined> {
  try {
   const r = normalizeOutbound(event, ctx, now());
   if (r && (await appendOutbound(r))) return {conversationId: r.conversationId, accountId: r.accountId};
  } catch {
   // không chặn luồng gửi tin của OpenClaw
  }
  return undefined;
 }

 async function messageRecord(input: unknown) {
  const id = isRec(input) && typeof input.conversationId === 'string' ? input.conversationId : '';
  const text = isRec(input) && typeof input.text === 'string' ? input.text : '';
  const acc = accountIn(input);
  if (!acc || !ID_RE.test(id) || !text.trim() || text.length > 2000) return {ok: false};
  const t = now();
  const stored = await appendOutbound({accountId: acc, conversationId: id, kind: id.startsWith('group:') ? 'group' : 'direct', message: {id: `out-${t}-${seq++}`, at: new Date(t).toISOString(), text, fromMe: true}}).catch(() => false);
  return {ok: stored};
 }

 /** Quyền hiện tại; lỗi đọc store (hoặc không có store) thì fail-open về 'write', không bao giờ ném. */
 async function accessOf(accountId: string, conversationId: string): Promise<ZaloAccess> {
  try {
   return (await rt(accountId).data.access?.get(conversationId)) ?? DEFAULT_ZALO_ACCESS;
  } catch {
   return DEFAULT_ZALO_ACCESS;
  }
 }

 async function accessGet(input: unknown) {
  const id = isRec(input) && typeof input.conversationId === 'string' ? input.conversationId : '';
  const acc = accountIn(input);
  return {access: acc && ID_RE.test(id) ? await accessOf(acc, id) : DEFAULT_ZALO_ACCESS};
 }

 async function accessSet(input: unknown) {
  const id = isRec(input) && typeof input.conversationId === 'string' ? input.conversationId : '';
  const value = isRec(input) && typeof input.access === 'string' ? input.access : '';
  const acc = accountIn(input);
  if (!acc || !ID_RE.test(id) || !ACCESS_VALUES.includes(value)) return {ok: false};
  const store = rt(acc).data.access;
  if (!store) return {ok: false};
  try {
   await store.set(id, value as ZaloAccess);
   return {ok: true};
  } catch {
   return {ok: false};
  }
 }

 /** Tin người dùng tự gửi từ Hộp thư: key `tài khoản|hội thoại` -> các lần cho phép còn hạn. */
 const grants = new Map<string, {text: string; until: number}[]>();
 async function sendAllow(input: unknown) {
  const id = isRec(input) && typeof input.conversationId === 'string' ? input.conversationId : '';
  const text = isRec(input) && typeof input.text === 'string' ? input.text.trim() : '';
  const acc = accountIn(input);
  if (!acc || !ID_RE.test(id)) return {ok: false};
  const t = now();
  for (const [k, list] of grants) {
   const live = list.filter((g) => g.until > t);
   if (live.length) grants.set(k, live);
   else grants.delete(k);
  }
  const key = `${acc}|${id}`;
  grants.set(key, [...(grants.get(key) ?? []), {text, until: t + SEND_GRANT_MS}].slice(-MAX_SEND_GRANTS));
  return {ok: true};
 }
 /** Tin trong content khớp một lần báo trước còn hạn (báo trước không kèm chữ thì khớp mọi nội dung, ví dụ tệp không chú thích). */
 const hasGrant = (acc: string, id: string, content: string): boolean => (grants.get(`${acc}|${id}`) ?? []).some((g) => g.until > now() && (!g.text || g.text === content.trim()));

 /** Hook before_dispatch: quyền 'none' thì bỏ qua agent (không phản hồi). Không bao giờ ném. */
 async function beforeDispatch(event: unknown, ctx: unknown): Promise<{handled: true} | undefined> {
  try {
   const t = conversationOfDispatch(event, ctx);
   if (t && (await accessOf(t.accountId, t.conversationId)) === 'none') return {handled: true};
  } catch {
   // fail-open
  }
  return undefined;
 }

 /** Hook message_sending: quyền khác 'write' thì chặn gửi, trừ tin người dùng tự gửi từ Hộp thư. Không bao giờ ném. */
 async function messageSending(event: unknown, ctx: unknown): Promise<{cancel: true; cancelReason: string} | undefined> {
  try {
   const t = conversationOfSending(event, ctx);
   if (!t || (await accessOf(t.accountId, t.conversationId)) === 'write') return undefined;
   if (hasGrant(t.accountId, t.conversationId, t.content)) return undefined;
   return {cancel: true, cancelReason: 'openclaw-personal: trợ lý AI không có quyền viết ở hội thoại này'};
  } catch {
   // fail-open
  }
  return undefined;
 }

 async function avatar(input: unknown) {
  const id = isRec(input) ? String(input.conversationId) : '';
  const acc = accountIn(input);
  const avatars = acc ? rt(acc).data.avatars : undefined;
  await avatars?.ready();
  const a = ID_RE.test(id) ? avatars?.get(id) : undefined;
  return a ? {avatar: a.base64, type: a.type} : {avatar: null};
 }

 async function enableHistory() {
  try {
   await deps.cli.enableHistory();
   return {ok: true};
  } catch (e) {
   return {ok: false, reason: reasonOf(e)};
  }
 }

 /** Tạo id `acc-<base36 thời gian>` (thêm hậu tố đếm nếu trùng trong cùng mili giây) rồi ghi cấu hình tài khoản. */
 async function addAccount() {
  const base = `acc-${now().toString(36)}`;
  const id = base === lastAddBase ? `${base}-${++addSeq}` : base;
  lastAddBase = base;
  try {
   await deps.cli.addAccount(id);
   return {ok: true, accountId: id};
  } catch (e) {
   return {ok: false, reason: reasonOf(e)};
  }
 }

 async function removeAccount(input: unknown) {
  const id = isRec(input) && typeof input.accountId === 'string' ? input.accountId : '';
  if (!ACCOUNT_RE.test(id) || id === DEFAULT_ZALO_ACCOUNT) return {ok: false, reason: 'invalid-input' as const};
  try {
   await deps.cli.removeAccount(id);
   return {ok: true};
  } catch (e) {
   return {ok: false, reason: reasonOf(e)};
  }
 }

 return {record, recordSent, beforeDispatch, messageSending, handlers: {[ID.accessGet]: accessGet, [ID.accessSet]: accessSet, [ID.sendAllow]: sendAllow, [ID.messageRecord]: messageRecord, [ID.accountSync]: syncAccount, [ID.enableHistory]: enableHistory, [ID.avatar]: avatar, [ID.status]: status, [ID.conversations]: conversations, [ID.messages]: messages, [ID.send]: send, [ID.accountAdd]: addAccount, [ID.accountRemove]: removeAccount}};
}
export type ZaloService = ReturnType<typeof createZaloService>;
