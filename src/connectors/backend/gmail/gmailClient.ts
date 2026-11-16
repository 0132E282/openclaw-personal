/**
 * Client REST Gmail mỏng, ánh xạ sang hình dạng EmailProvider của UI. Không dùng thư viện ngoài.
 *
 * Ánh xạ thư mục -> nhãn Gmail:
 *  all -> INBOX; unread -> INBOX + UNREAD; spam -> SPAM; trash -> TRASH.
 *  'stranger' và 'blocked' KHÔNG có nhãn Gmail gốc (Gmail chặn người gửi bằng filter cần scope
 *  gmail.settings.basic, scope này không xin). Lựa chọn: listMessages trả rỗng cho hai thư mục này,
 *  các hành động block/unblock/accept ném GmailError('unsupported'). Không tự bịa nhãn.
 *  deletePermanent cần scope https://mail.google.com/ (không xin) -> 'unsupported'.
 * Thêm/bớt nhãn SPAM/TRASH qua messages.batchModify theo yêu cầu thiết kế; chưa kiểm chứng trên Gmail thật.
 * Lỗi chỉ mang mã + status HTTP, không mang token/nội dung phản hồi.
 */
import type {Box, Folder, Message, MoveAction} from '../../../ui/email/provider';
import {OAuthError, refreshAccessToken, type FetchLike, type FetchResponseLike, type RandomBytes, base64url, defaultRandom} from './oauth';
import {GMAIL_ACCOUNT_RE, type TokenStore} from './tokenStore';

export const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const MAX_LIST = 100;
export const MAX_PAGES = 5;
export const MAX_RAW_BYTES = 4 * 1024 * 1024;
const MAX_RECIPIENTS = 100;
const BATCH_MAX = 1000;
const META_CONCURRENCY = 10;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type GmailErrorCode = 'reauth-required' | 'no-account' | 'invalid-input' | 'unsupported' | 'not-found' | 'forbidden' | 'bad-request' | 'rate-limited' | 'server-error' | 'network' | 'auth-failed' | 'invalid-response';
export class GmailError extends Error {
 constructor(
  readonly code: GmailErrorCode,
  readonly status?: number,
 ) {
  super(code);
  this.name = 'GmailError';
 }
}

export const FOLDER_LABELS: Record<Folder, readonly string[] | undefined> = {
 all: ['INBOX'],
 unread: ['INBOX', 'UNREAD'],
 spam: ['SPAM'],
 trash: ['TRASH'],
 stranger: undefined,
 blocked: undefined,
};

export interface LabelChange {
 add: readonly string[];
 remove: readonly string[];
}
/** null = không hỗ trợ trên Gmail (xem đầu file). */
export const MOVE_LABELS: Record<MoveAction, LabelChange | null> = {
 spam: {add: ['SPAM'], remove: ['INBOX']},
 unspam: {add: ['INBOX'], remove: ['SPAM']},
 trash: {add: ['TRASH'], remove: ['INBOX']},
 restore: {add: ['INBOX'], remove: ['TRASH']},
 block: null,
 unblock: null,
 accept: null,
 deletePermanent: null,
};

/* ---------- mã hóa header / RFC 5322 ---------- */

const CTL_RE = /[\x00-\x08\x0a-\x1f\x7f\u0085\u2028\u2029]/;
/** Chống CRLF injection: từ chối mọi ký tự điều khiển (trừ tab) trong giá trị header. */
export function assertNoCtl(s: string): string {
 if (typeof s !== 'string' || CTL_RE.test(s)) throw new GmailError('invalid-input');
 return s;
}

const utf8 = new TextEncoder();
function b64(bytes: Uint8Array): string {
 let bin = '';
 for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
 return btoa(bin);
}

/** RFC 2047: chia theo ký tự (không cắt giữa code point), mỗi encoded-word <= 75 ký tự. */
export function encodeHeaderWord(value: string): string {
 assertNoCtl(value);
 if (/^[\x20-\x7e]*$/.test(value) && !value.includes('=?')) return value;
 const words: string[] = [];
 let chunk = '';
 let bytes = 0;
 for (const ch of value) {
  const n = utf8.encode(ch).length;
  if (bytes + n > 45) {
   words.push(chunk);
   chunk = '';
   bytes = 0;
  }
  chunk += ch;
  bytes += n;
 }
 if (chunk) words.push(chunk);
 return words.map((w) => `=?UTF-8?B?${b64(utf8.encode(w))}?=`).join('\r\n ');
}

const ADDR_RE = /^[^\s<>,;"@()\\]+@[^\s<>,;"@()\\]+$/;
export function formatAddress(input: string): string {
 const s = assertNoCtl(input).trim();
 if (ADDR_RE.test(s)) return s;
 const m = /^(.*?)\s*<([^<>]+)>$/.exec(s);
 if (!m || !ADDR_RE.test(m[2])) throw new GmailError('invalid-input');
 const name = m[1].replace(/^"(.*)"$/, '$1').trim();
 if (/["\\<>]/.test(name)) throw new GmailError('invalid-input');
 if (!name) return m[2];
 return /^[\x20-\x7e]*$/.test(name) ? `"${name}" <${m[2]}>` : `${encodeHeaderWord(name)} <${m[2]}>`;
}

export interface SendInput {
 to: readonly string[];
 cc?: readonly string[];
 bcc?: readonly string[];
 subject: string;
 text?: string;
 html?: string;
 inReplyTo?: string;
 references?: string;
}
const wrap76 = (b: string) => (b.match(/.{1,76}/g) ?? []).join('\r\n');
const bodyPart = (type: string, content: string) => `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(utf8.encode(content)))}`;

/** Dựng thư RFC 5322 (CRLF). Header From do Gmail tự gán theo tài khoản. */
export function buildRawMessage(m: SendInput, deps: {now: () => number; random?: RandomBytes}): string {
 const to = (m.to ?? []).map(formatAddress);
 const cc = (m.cc ?? []).map(formatAddress);
 const bcc = (m.bcc ?? []).map(formatAddress);
 const total = to.length + cc.length + bcc.length;
 if (to.length + cc.length + bcc.length === 0 || total > MAX_RECIPIENTS) throw new GmailError('invalid-input');
 if (!m.text && !m.html) throw new GmailError('invalid-input');
 const head = ['MIME-Version: 1.0', `Date: ${new Date(deps.now()).toUTCString()}`];
 if (to.length) head.push(`To: ${to.join(', ')}`);
 if (cc.length) head.push(`Cc: ${cc.join(', ')}`);
 if (bcc.length) head.push(`Bcc: ${bcc.join(', ')}`);
 head.push(`Subject: ${encodeHeaderWord(m.subject ?? '')}`);
 if (m.inReplyTo) head.push(`In-Reply-To: ${assertNoCtl(m.inReplyTo)}`);
 if (m.references) head.push(`References: ${assertNoCtl(m.references)}`);
 let body: string;
 if (m.text && m.html) {
  const b = '=_op_' + Array.from((deps.random ?? defaultRandom)(12), (x) => x.toString(16).padStart(2, '0')).join('');
  head.push(`Content-Type: multipart/alternative; boundary="${b}"`);
  body = `\r\n--${b}\r\n${bodyPart('text/plain', m.text)}\r\n--${b}\r\n${bodyPart('text/html', m.html)}\r\n--${b}--\r\n`;
 } else {
  const part = m.html ? bodyPart('text/html', m.html) : bodyPart('text/plain', m.text as string);
  const i = part.indexOf('\r\n\r\n');
  head.push(part.slice(0, i));
  body = part.slice(i) + '\r\n';
 }
 const raw = head.join('\r\n') + '\r\n' + body;
 if (raw.length > MAX_RAW_BYTES) throw new GmailError('invalid-input');
 return raw;
}

/* ---------- phân tích thư Gmail -> Message ---------- */

interface GPart {
 mimeType?: string;
 headers?: {name: string; value: string}[];
 body?: {data?: string};
 parts?: GPart[];
}
interface GMessage {
 id?: string;
 threadId?: string;
 labelIds?: string[];
 snippet?: string;
 internalDate?: string;
 payload?: GPart;
}
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fromB64url(data: string): Uint8Array {
 const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
 return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const decodeText = (data: string) => new TextDecoder('utf-8').decode(fromB64url(data));

/** Giải mã encoded-word RFC 2047 (B/Q, UTF-8). */
export function decodeMimeWords(s: string): string {
 return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, cs: string, enc: string, txt: string) => {
  try {
   const bytes = enc.toLowerCase() === 'b' ? Uint8Array.from(atob(txt), (c) => c.charCodeAt(0)) : Uint8Array.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), (c) => c.charCodeAt(0));
   return new TextDecoder(cs).decode(bytes);
  } catch {
   return txt;
  }
 });
}
export function parseAddressHeader(h: string): {name: string; address: string} {
 const v = decodeMimeWords(h).trim();
 const m = /^(.*?)\s*<([^<>]+)>$/.exec(v);
 if (m) return {name: m[1].replace(/^"(.*)"$/, '$1').trim(), address: m[2].trim()};
 return {name: '', address: v};
}
const headerOf = (p: GPart | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

function collectBodies(p: GPart | undefined, out: {text?: string; html?: string}) {
 if (!p) return;
 if (p.body?.data) {
  if (p.mimeType === 'text/plain' && out.text === undefined) out.text = decodeText(p.body.data);
  else if (p.mimeType === 'text/html' && out.html === undefined) out.html = decodeText(p.body.data);
 }
 for (const c of p.parts ?? []) collectBodies(c, out);
}
export function boxOf(labels: readonly string[]): Box {
 return labels.includes('TRASH') ? 'trash' : labels.includes('SPAM') ? 'spam' : 'inbox';
}
export function toMessage(accountId: string, g: GMessage, withBody: boolean): Message {
 const labels = g.labelIds ?? [];
 const when = g.internalDate && /^\d+$/.test(g.internalDate) ? new Date(Number(g.internalDate)) : new Date(headerOf(g.payload, 'Date') ?? 0);
 const base = {
  id: String(g.id ?? ''),
  accountId,
  box: boxOf(labels),
  from: parseAddressHeader(headerOf(g.payload, 'From') ?? ''),
  to: (headerOf(g.payload, 'To') ?? '').split(',').map((a) => decodeMimeWords(a).trim()).filter(Boolean),
  subject: decodeMimeWords(headerOf(g.payload, 'Subject') ?? ''),
  snippet: g.snippet ?? '',
  date: Number.isNaN(when.getTime()) ? new Date(0).toISOString() : when.toISOString(),
  unread: labels.includes('UNREAD'),
 };
 if (!withBody) return base;
 const bodies: {text?: string; html?: string} = {};
 collectBodies(g.payload, bodies);
 return {...base, ...bodies};
}

/* ---------- client ---------- */

export interface GmailClientDeps {
 fetch: FetchLike;
 store: TokenStore;
 now?: () => number;
 sleep?: (ms: number) => Promise<void>;
 random?: RandomBytes;
 maxRetries?: number;
 baseDelayMs?: number;
}

export function createGmailClient(deps: GmailClientDeps) {
 const now = deps.now ?? Date.now;
 const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
 const maxRetries = deps.maxRetries ?? 3;
 const baseDelay = deps.baseDelayMs ?? 500;
 const refreshing = new Map<string, Promise<string>>();

 function refresh(id: string): Promise<string> {
  const running = refreshing.get(id);
  if (running) return running;
  const p = (async () => {
   const rec = await deps.store.load(id);
   if (!rec) throw new GmailError('no-account');
   try {
    const t = await refreshAccessToken({fetch: deps.fetch, now, clientId: rec.clientId, clientSecret: rec.clientSecret, refreshToken: rec.refreshToken});
    await deps.store.updateAccess(id, {accessToken: t.accessToken, expiresAt: t.expiresAt, refreshToken: t.refreshToken, scope: t.scope});
    return t.accessToken;
   } catch (e) {
    if (e instanceof OAuthError && e.code === 'reauth-required') {
     await deps.store.markReauth(id);
     throw new GmailError('reauth-required');
    }
    if (e instanceof GmailError) throw e;
    throw new GmailError(e instanceof OAuthError && e.code === 'network' ? 'network' : 'auth-failed');
   }
  })().finally(() => refreshing.delete(id));
  refreshing.set(id, p);
  return p;
 }

 async function token(id: string): Promise<string> {
  if (!GMAIL_ACCOUNT_RE.test(id)) throw new GmailError('no-account');
  const rec = await deps.store.load(id);
  if (!rec) throw new GmailError('no-account');
  if (rec.accessToken && rec.expiresAt && rec.expiresAt - 60_000 > now()) return rec.accessToken;
  return refresh(id);
 }

 async function request(id: string, method: 'GET' | 'POST', path: string, query?: URLSearchParams, body?: unknown): Promise<unknown> {
  const url = `${API_BASE}${path}${query && [...query].length ? `?${query.toString()}` : ''}`;
  let access = await token(id);
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
   let res: FetchResponseLike;
   try {
    res = await deps.fetch(url, {method, headers: {Authorization: `Bearer ${access}`, Accept: 'application/json', ...(body !== undefined ? {'Content-Type': 'application/json'} : {})}, body: body !== undefined ? JSON.stringify(body) : undefined});
   } catch {
    if (attempt < maxRetries) {
     await sleep(baseDelay * 2 ** attempt);
     continue;
    }
    throw new GmailError('network');
   }
   if (res.ok) {
    try {
     return await res.json();
    } catch {
     return undefined;
    }
   }
   if (res.status === 401) {
    if (refreshed) throw new GmailError('reauth-required', 401);
    refreshed = true;
    access = await refresh(id);
    attempt--;
    continue;
   }
   if (res.status === 429 || res.status >= 500) {
    if (attempt >= maxRetries) throw new GmailError(res.status === 429 ? 'rate-limited' : 'server-error', res.status);
    const ra = Number(res.headers?.get('retry-after'));
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : Math.min(baseDelay * 2 ** attempt, 8000));
    continue;
   }
   throw new GmailError(res.status === 404 ? 'not-found' : res.status === 403 ? 'forbidden' : 'bad-request', res.status);
  }
 }

 const msgId = (id: string) => (ID_RE.test(id) ? id : (() => { throw new GmailError('invalid-input'); })());
 const META = ['From', 'To', 'Subject', 'Date'];

 async function getMessage(accountId: string, id: string, full = true): Promise<Message> {
  const q = new URLSearchParams({format: full ? 'full' : 'metadata'});
  if (!full) META.forEach((h) => q.append('metadataHeaders', h));
  const g = await request(accountId, 'GET', `/messages/${msgId(id)}`, q);
  if (!isRec(g)) throw new GmailError('invalid-response');
  return toMessage(accountId, g as GMessage, full);
 }

 async function listMessages(accountId: string, o: {folder: Folder; limit?: number; pageToken?: string}): Promise<{messages: Message[]; nextPageToken: string | null; supported: boolean}> {
  const labels = FOLDER_LABELS[o.folder];
  if (!labels) return {messages: [], nextPageToken: null, supported: false};
  const cap = Math.max(1, Math.min(Math.trunc(o.limit ?? 25) || 25, MAX_LIST));
  const ids: string[] = [];
  let pageToken = o.pageToken;
  for (let pages = 0; pages < MAX_PAGES && ids.length < cap; pages++) {
   const q = new URLSearchParams({maxResults: String(cap - ids.length)});
   labels.forEach((l) => q.append('labelIds', l));
   if (o.folder === 'spam' || o.folder === 'trash') q.set('includeSpamTrash', 'true');
   if (pageToken) q.set('pageToken', pageToken);
   const r = await request(accountId, 'GET', '/messages', q);
   if (!isRec(r)) throw new GmailError('invalid-response');
   for (const m of Array.isArray(r.messages) ? r.messages : []) if (isRec(m) && typeof m.id === 'string' && ids.length < cap) ids.push(m.id);
   pageToken = typeof r.nextPageToken === 'string' ? r.nextPageToken : undefined;
   if (!pageToken) break;
  }
  const messages: Message[] = [];
  for (let i = 0; i < ids.length; i += META_CONCURRENCY) messages.push(...(await Promise.all(ids.slice(i, i + META_CONCURRENCY).map((id) => getMessage(accountId, id, false)))));
  return {messages, nextPageToken: pageToken ?? null, supported: true};
 }

 async function modifyLabels(accountId: string, ids: readonly string[], change: LabelChange): Promise<void> {
  const clean = [...new Set(ids.map(msgId))];
  for (let i = 0; i < clean.length; i += BATCH_MAX) {
   const chunk = clean.slice(i, i + BATCH_MAX);
   if (chunk.length === 1) await request(accountId, 'POST', `/messages/${chunk[0]}/modify`, undefined, {addLabelIds: change.add, removeLabelIds: change.remove});
   else await request(accountId, 'POST', '/messages/batchModify', undefined, {ids: chunk, addLabelIds: change.add, removeLabelIds: change.remove});
  }
 }

 return {
  getProfile: async (accountId: string): Promise<{address: string; messagesTotal: number}> => {
   const r = await request(accountId, 'GET', '/profile');
   if (!isRec(r) || typeof r.emailAddress !== 'string') throw new GmailError('invalid-response');
   return {address: r.emailAddress, messagesTotal: typeof r.messagesTotal === 'number' ? r.messagesTotal : 0};
  },
  listMessages,
  getMessage,
  markRead: (accountId: string, ids: readonly string[], read: boolean) => modifyLabels(accountId, ids, read ? {add: [], remove: ['UNREAD']} : {add: ['UNREAD'], remove: []}),
  moveToFolder: async (accountId: string, ids: readonly string[], action: MoveAction): Promise<void> => {
    const change = MOVE_LABELS[action];
    if (!change) throw new GmailError('unsupported');
    await modifyLabels(accountId, ids, change);
  },
  send: async (accountId: string, input: SendInput & {replyToId?: string}): Promise<{id: string; threadId: string | null}> => {
   let threadId: string | undefined;
   const draft: SendInput = {...input, inReplyTo: undefined, references: undefined};
   if (input.replyToId) {
    const q = new URLSearchParams({format: 'metadata'});
    ['Message-ID', 'References'].forEach((h) => q.append('metadataHeaders', h));
    const g = (await request(accountId, 'GET', `/messages/${msgId(input.replyToId)}`, q)) as GMessage;
    const mid = headerOf(g?.payload, 'Message-ID');
    if (mid) {
     const refs = headerOf(g?.payload, 'References');
     draft.inReplyTo = mid.trim();
     draft.references = (refs ? `${refs.trim()} ` : '') + mid.trim();
    }
    threadId = typeof g?.threadId === 'string' ? g.threadId : undefined;
   }
   const raw = base64url(utf8.encode(buildRawMessage(draft, {now, random: deps.random})));
   const r = await request(accountId, 'POST', '/messages/send', undefined, threadId ? {raw, threadId} : {raw});
   if (!isRec(r) || typeof r.id !== 'string') throw new GmailError('invalid-response');
   return {id: r.id, threadId: typeof r.threadId === 'string' ? r.threadId : null};
  },
 };
}
export type GmailClient = ReturnType<typeof createGmailClient>;
