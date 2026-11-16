/**
 * Kho token Gmail theo tài khoản, cùng cách với cookieStore.ts: file bí mật 0600 qua SecretFileIO tiêm vào
 * (SDK chỉ có create-only nên ghi đè = remove rồi create). File KHÔNG mã hóa.
 * Chỉ `load()` (nội bộ backend) trả token; `list()`/`status` chỉ trả metadata.
 * Có file chỉ mục `gmail-index.json` (không chứa bí mật) vì SecretFileIO không liệt kê được thư mục.
 */
import type {SecretFileIO} from '../cookieStore';

export interface GmailRecord {
 address: string;
 clientId: string;
 clientSecret?: string;
 refreshToken: string;
 accessToken?: string;
 /** epoch ms */
 expiresAt?: number;
 scope?: string;
 savedAt: number;
}
export interface GmailAccountStatus {
 id: string;
 address: string;
 savedAt: number;
 needsReauth: boolean;
}
export type TokenStoreError = 'invalid-account' | 'invalid-record' | 'not-found' | 'io-error';
export type TokenResult<T = undefined> = ({ok: true} & (T extends undefined ? {} : T)) | {ok: false; reason: TokenStoreError};

export interface TokenStoreDeps {
 io: SecretFileIO;
 dir: string;
 now?: () => number;
}

export const GMAIL_ACCOUNT_RE = /^g-[0-9a-f]{12}$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** id ổn định từ địa chỉ email (không chứa ký tự lạ, khớp mẫu accountId của contract). */
export async function gmailAccountId(address: string): Promise<string> {
 const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address.trim().toLowerCase())));
 return 'g-' + Array.from(d.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseRecord(text: string): GmailRecord | undefined {
 const v: unknown = JSON.parse(text);
 if (!isRec(v) || typeof v.address !== 'string' || typeof v.clientId !== 'string' || typeof v.refreshToken !== 'string' || typeof v.savedAt !== 'number') return undefined;
 const rec: GmailRecord = {address: v.address, clientId: v.clientId, refreshToken: v.refreshToken, savedAt: v.savedAt};
 if (typeof v.clientSecret === 'string') rec.clientSecret = v.clientSecret;
 if (typeof v.accessToken === 'string') rec.accessToken = v.accessToken;
 if (typeof v.expiresAt === 'number') rec.expiresAt = v.expiresAt;
 if (typeof v.scope === 'string') rec.scope = v.scope;
 return rec;
}

type Index = Record<string, {address: string; savedAt: number; needsReauth: boolean}>;

export function createTokenStore(deps: TokenStoreDeps) {
 const now = deps.now ?? Date.now;
 const base = deps.dir.replace(/\/+$/, '');
 const fileFor = (id: string) => `${base}/gmail-${id}.json`;
 const indexFile = `${base}/gmail-index.json`;
 let chain: Promise<unknown> = Promise.resolve();
 /** Tuần tự hóa mọi thao tác ghi để remove+create không chen nhau. */
 const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
 };

 async function rewrite(file: string, content: string) {
  await deps.io.remove(file);
  await deps.io.create(file, content);
 }
 async function readIndex(): Promise<Index> {
  const text = await deps.io.read(indexFile);
  if (!text) return {};
  const v: unknown = JSON.parse(text);
  const out: Index = {};
  if (isRec(v)) {
   for (const [id, e] of Object.entries(v)) {
    if (GMAIL_ACCOUNT_RE.test(id) && isRec(e) && typeof e.address === 'string' && typeof e.savedAt === 'number') out[id] = {address: e.address, savedAt: e.savedAt, needsReauth: e.needsReauth === true};
   }
  }
  return out;
 }
 const writeIndex = (idx: Index) => rewrite(indexFile, JSON.stringify(idx));

 /** Lưu mới/ghi đè (đăng nhập lại) và xóa cờ needsReauth. Trả id, không trả token. */
 function save(input: Omit<GmailRecord, 'savedAt'>): Promise<TokenResult<{id: string}>> {
  return serial(async () => {
   if (!input.address || !input.clientId || !input.refreshToken) return {ok: false, reason: 'invalid-record'} as const;
   const id = await gmailAccountId(input.address);
   try {
    const rec: GmailRecord = {...input, savedAt: now()};
    await rewrite(fileFor(id), JSON.stringify(rec));
    const idx = await readIndex().catch(() => ({}) as Index);
    idx[id] = {address: input.address, savedAt: rec.savedAt, needsReauth: false};
    await writeIndex(idx);
    return {ok: true, id} as const;
   } catch {
    return {ok: false, reason: 'io-error'} as const;
   }
  });
 }

 /** CHỈ dùng phía backend; không đưa vào operation output. */
 async function load(id: string): Promise<GmailRecord | undefined> {
  if (!GMAIL_ACCOUNT_RE.test(id)) return undefined;
  try {
   const text = await deps.io.read(fileFor(id));
   return text ? parseRecord(text) : undefined;
  } catch {
   return undefined;
  }
 }

 function updateAccess(id: string, t: {accessToken: string; expiresAt: number; refreshToken?: string; scope?: string}): Promise<TokenResult> {
  return serial(async () => {
   if (!GMAIL_ACCOUNT_RE.test(id)) return {ok: false, reason: 'invalid-account'} as const;
   try {
    const rec = await load(id);
    if (!rec) return {ok: false, reason: 'not-found'} as const;
    const next: GmailRecord = {...rec, accessToken: t.accessToken, expiresAt: t.expiresAt, refreshToken: t.refreshToken || rec.refreshToken, scope: t.scope || rec.scope};
    await rewrite(fileFor(id), JSON.stringify(next));
    return {ok: true} as const;
   } catch {
    return {ok: false, reason: 'io-error'} as const;
   }
  });
 }

 function markReauth(id: string): Promise<TokenResult> {
  return serial(async () => {
   if (!GMAIL_ACCOUNT_RE.test(id)) return {ok: false, reason: 'invalid-account'} as const;
   try {
    const idx = await readIndex();
    if (!idx[id]) return {ok: false, reason: 'not-found'} as const;
    idx[id].needsReauth = true;
    await writeIndex(idx);
    return {ok: true} as const;
   } catch {
    return {ok: false, reason: 'io-error'} as const;
   }
  });
 }

 /** Chỉ metadata, an toàn trả ra UI. */
 async function list(): Promise<GmailAccountStatus[]> {
  try {
   const idx = await readIndex();
   return Object.entries(idx).map(([id, e]) => ({id, address: e.address, savedAt: e.savedAt, needsReauth: e.needsReauth}));
  } catch {
   return [];
  }
 }

 function remove(id: string): Promise<TokenResult> {
  return serial(async () => {
   if (!GMAIL_ACCOUNT_RE.test(id)) return {ok: false, reason: 'invalid-account'} as const;
   try {
    await deps.io.remove(fileFor(id));
    const idx = await readIndex().catch(() => ({}) as Index);
    delete idx[id];
    await writeIndex(idx);
    return {ok: true} as const;
   } catch {
    return {ok: false, reason: 'io-error'} as const;
   }
  });
 }

 return {save, load, updateAccess, markReauth, list, remove};
}
export type TokenStore = ReturnType<typeof createTokenStore>;
