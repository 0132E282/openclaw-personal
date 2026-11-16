/**
 * Kho cookie Messenger. Lưu bằng file bí mật chế độ 0600 (thư mục 0700) qua
 * `openclaw/plugin-sdk/secret-file` (đã xác minh, xem docs/plans/backend-findings.md).
 * Không có API keychain; file KHÔNG được mã hóa. Giá trị cookie không bao giờ đi vào lỗi/log.
 */
export interface StoredCookie {
 name: string;
 value: string;
 domain?: string;
 path?: string;
 expires?: number;
 httpOnly?: boolean;
 secure?: boolean;
}

/** I/O file bí mật tiêm vào; SDK chỉ có create-only nên ghi đè = remove rồi create. */
export interface SecretFileIO {
 read(filePath: string): Promise<string | undefined>;
 create(filePath: string, content: string): Promise<void>;
 remove(filePath: string): Promise<void>;
}

export const REQUIRED_MESSENGER_COOKIES = ['c_user', 'xs'] as const;
/** Chỉ giữ các cookie cần cho phiên; loại phần còn lại để giữ file nhỏ (giới hạn đọc 16 KiB). */
export const KEPT_MESSENGER_COOKIES = ['c_user', 'xs', 'datr', 'fr', 'sb'] as const;
export const MAX_COOKIE_VALUE_LENGTH = 2048;
const ACCOUNT_RE = /^[a-z0-9_-]{1,40}$/;

export type CookieStoreError = 'invalid-account' | 'invalid-cookies' | 'missing-required' | 'io-error';
export type CookieResult<T = undefined> = ({ok: true} & (T extends undefined ? {} : {value: T})) | {ok: false; reason: CookieStoreError};

export interface CookieStatus {
 present: boolean;
 savedAt: number | null;
}

export interface CookieStoreDeps {
 io: SecretFileIO;
 /** Thư mục gốc lưu bí mật của plugin (do wiring cấp, nằm trong state dir của OpenClaw). */
 dir: string;
 now?: () => number;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Chuẩn hóa danh sách cookie đầu vào; trả undefined nếu sai dạng. Không ném, không lộ giá trị. */
export function sanitizeCookies(input: unknown): StoredCookie[] | undefined {
 if (!Array.isArray(input) || input.length > 100) return undefined;
 const out = new Map<string, StoredCookie>();
 for (const raw of input) {
  if (!isRec(raw) || typeof raw.name !== 'string' || typeof raw.value !== 'string') return undefined;
  const {name, value} = raw;
  if (!(KEPT_MESSENGER_COOKIES as readonly string[]).includes(name)) continue;
  if (value.length === 0 || value.length > MAX_COOKIE_VALUE_LENGTH || /[\s;,]/.test(value)) return undefined;
  const cookie: StoredCookie = {name, value};
  if (typeof raw.domain === 'string' && /^\.?([a-z0-9-]+\.)*facebook\.com$/i.test(raw.domain)) cookie.domain = raw.domain;
  if (typeof raw.path === 'string' && raw.path.startsWith('/')) cookie.path = raw.path;
  if (typeof raw.expires === 'number' && Number.isFinite(raw.expires)) cookie.expires = raw.expires;
  if (typeof raw.httpOnly === 'boolean') cookie.httpOnly = raw.httpOnly;
  if (typeof raw.secure === 'boolean') cookie.secure = raw.secure;
  out.set(name, cookie);
 }
 return [...out.values()];
}

export function createCookieStore(deps: CookieStoreDeps) {
 const now = deps.now ?? Date.now;
 const fileFor = (account: string) => `${deps.dir.replace(/\/+$/, '')}/messenger-${account}.json`;

 async function save(account: string, cookies: unknown): Promise<CookieResult> {
  if (!ACCOUNT_RE.test(account)) return {ok: false, reason: 'invalid-account'};
  const clean = sanitizeCookies(cookies);
  if (!clean) return {ok: false, reason: 'invalid-cookies'};
  if (!REQUIRED_MESSENGER_COOKIES.every((n) => clean.some((c) => c.name === n))) return {ok: false, reason: 'missing-required'};
  const file = fileFor(account);
  try {
   await deps.io.remove(file);
   await deps.io.create(file, JSON.stringify({savedAt: now(), cookies: clean}));
   return {ok: true};
  } catch {
   return {ok: false, reason: 'io-error'};
  }
 }

 async function readRecord(account: string): Promise<{savedAt: number; cookies: StoredCookie[]} | undefined> {
  const text = await deps.io.read(fileFor(account));
  if (!text) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!isRec(parsed) || typeof parsed.savedAt !== 'number') return undefined;
  const cookies = sanitizeCookies(parsed.cookies);
  return cookies ? {savedAt: parsed.savedAt, cookies} : undefined;
 }

 /** Chỉ metadata, an toàn để trả ra UI. */
 async function status(account: string): Promise<CookieStatus> {
  if (!ACCOUNT_RE.test(account)) return {present: false, savedAt: null};
  try {
   const rec = await readRecord(account);
   return rec ? {present: true, savedAt: rec.savedAt} : {present: false, savedAt: null};
  } catch {
   return {present: false, savedAt: null};
  }
 }

 /** Chỉ dùng phía backend (không đưa vào operation output). */
 async function load(account: string): Promise<StoredCookie[] | undefined> {
  if (!ACCOUNT_RE.test(account)) return undefined;
  try {
   return (await readRecord(account))?.cookies;
  } catch {
   return undefined;
  }
 }

 async function clear(account: string): Promise<CookieResult> {
  if (!ACCOUNT_RE.test(account)) return {ok: false, reason: 'invalid-account'};
  try {
   await deps.io.remove(fileFor(account));
   return {ok: true};
  } catch {
   return {ok: false, reason: 'io-error'};
  }
 }

 return {save, status, load, clear};
}

export type CookieStore = ReturnType<typeof createCookieStore>;

/**
 * Adapter thật: nạp `openclaw/plugin-sdk/secret-file` động (chỉ có trong Gateway) và dùng fs để xóa.
 * Chưa kiểm chứng chạy thật trong test (cần Gateway); wiring phải thử trên máy thật trước khi bật.
 */
export async function createSdkSecretFileIO(rootDir: string, fsp: {unlink(p: string): Promise<void>} ): Promise<SecretFileIO> {
 const spec = 'openclaw/plugin-sdk/secret-file';
 const sdk = (await import(/* @vite-ignore */ spec)) as {
  createSecretFileAtomic(p: {rootDir: string; filePath: string; content: string}): Promise<void>;
  tryReadSecretFileSync(filePath: string, label: string, o?: {maxBytes?: number}): string | undefined;
 };
 return {
  read: async (filePath) => sdk.tryReadSecretFileSync(filePath, 'messenger cookies'),
  create: (filePath, content) => sdk.createSecretFileAtomic({rootDir, filePath, content}),
  remove: async (filePath) => {
   try {
    await fsp.unlink(filePath);
   } catch (e) {
    if ((e as {code?: string}).code !== 'ENOENT') throw e;
   }
  },
 };
}
