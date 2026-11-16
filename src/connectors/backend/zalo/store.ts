/**
 * Kho tin Zalo cục bộ: một file JSON (0600, thư mục 0700), ghi nguyên tử (tmp + rename), có giới hạn kích thước.
 * Chứa nội dung tin nhắn: không được log hay đưa vào lỗi.
 */
import {chmod, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export interface StoredMessage {
 id: string;
 at: string;
 text: string;
 fromMe: boolean;
 author?: string;
}
export interface StoredConversation {
 name?: string;
 kind: 'direct' | 'group';
 messages: StoredMessage[];
}
interface Snapshot {
 v: 1;
 conversations: Record<string, StoredConversation>;
}

export interface StoreIO {
 read(path: string): Promise<string | undefined>;
 /** Ghi nguyên tử, quyền 0600. */
 write(path: string, content: string): Promise<void>;
}

export const MAX_MESSAGES_PER_CONVERSATION = 200;
export const MAX_CONVERSATIONS = 500;
export const MAX_TEXT = 4000;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validAt = (s: unknown): s is string => typeof s === 'string' && !Number.isNaN(Date.parse(s));

function cleanMessage(raw: unknown): StoredMessage | undefined {
 if (!isRec(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string' || !validAt(raw.at)) return undefined;
 const m: StoredMessage = {id: raw.id.slice(0, 80), at: raw.at, text: raw.text.slice(0, MAX_TEXT), fromMe: raw.fromMe === true};
 if (typeof raw.author === 'string' && raw.author) m.author = raw.author.slice(0, 120);
 return m;
}

function parseSnapshot(text: string | undefined): Snapshot {
 const empty: Snapshot = {v: 1, conversations: {}};
 if (!text) return empty;
 try {
  const j: unknown = JSON.parse(text);
  if (!isRec(j) || !isRec(j.conversations)) return empty;
  for (const [id, c] of Object.entries(j.conversations)) {
   if (!isRec(c) || !Array.isArray(c.messages)) continue;
   const messages = c.messages.map(cleanMessage).filter((m): m is StoredMessage => !!m).slice(-MAX_MESSAGES_PER_CONVERSATION);
   empty.conversations[id] = {kind: c.kind === 'group' ? 'group' : 'direct', ...(typeof c.name === 'string' && c.name ? {name: c.name.slice(0, 200)} : {}), messages};
  }
  return empty;
 } catch {
  return empty;
 }
}

export interface AppendInput {
 conversationId: string;
 kind: 'direct' | 'group';
 name?: string;
 message: StoredMessage;
}

export interface ConversationSummary {
 id: string;
 name?: string;
 kind: 'direct' | 'group';
 lastAt: string;
 preview: string;
}

export function createZaloStore(deps: {io: StoreIO; file: string}) {
 let snap: Promise<Snapshot> | undefined;
 let chain: Promise<unknown> = Promise.resolve();
 const load = (): Promise<Snapshot> => (snap ??= deps.io.read(deps.file).then(parseSnapshot, (): Snapshot => ({v: 1, conversations: {}})));

 /** Tuần tự hóa mọi thay đổi để ghi file không giẫm nhau. */
 function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
 }

 async function persist(s: Snapshot): Promise<void> {
  const ids = Object.keys(s.conversations);
  if (ids.length > MAX_CONVERSATIONS) {
   const last = (id: string) => s.conversations[id].messages.at(-1)?.at ?? '';
   for (const id of ids.sort((a, b) => last(a).localeCompare(last(b))).slice(0, ids.length - MAX_CONVERSATIONS)) delete s.conversations[id];
  }
  await deps.io.write(deps.file, JSON.stringify(s));
 }

 function append(input: AppendInput): Promise<boolean> {
  const text = input.message.text.slice(0, MAX_TEXT);
  if (!text.trim() || !validAt(input.message.at)) return Promise.resolve(false);
  return enqueue(async () => {
   const s = await load();
   const conv = (s.conversations[input.conversationId] ??= {kind: input.kind, messages: []});
   if (input.name) conv.name = input.name.slice(0, 200);
   if (conv.messages.some((m) => m.id === input.message.id)) return false;
   conv.messages.push({...input.message, text});
   conv.messages.sort((a, b) => a.at.localeCompare(b.at));
   if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) conv.messages.splice(0, conv.messages.length - MAX_MESSAGES_PER_CONVERSATION);
   await persist(s);
   return true;
  });
 }

 async function messages(conversationId: string): Promise<StoredMessage[]> {
  return [...((await load()).conversations[conversationId]?.messages ?? [])];
 }

 async function summaries(): Promise<ConversationSummary[]> {
  const s = await load();
  return Object.entries(s.conversations).map(([id, c]) => {
   const last = c.messages.at(-1);
   return {id, ...(c.name ? {name: c.name} : {}), kind: c.kind, lastAt: last?.at ?? '', preview: (last?.text ?? '').replace(/\s+/g, ' ').slice(0, 120)};
  });
 }

 /** Xóa toàn bộ lịch sử đã lưu (đổi tài khoản Zalo). */
 function clear(): Promise<void> {
  return enqueue(async () => {
   snap = Promise.resolve({v: 1, conversations: {}} as Snapshot);
   await deps.io.write(deps.file, JSON.stringify({v: 1, conversations: {}}));
  });
 }

 return {append, messages, summaries, clear};
}
export type ZaloStore = ReturnType<typeof createZaloStore>;

/** Ghi nhớ tài khoản Zalo mà dữ liệu cục bộ thuộc về; file hỏng coi như chưa biết. */
export function createAccountMarker(file: string, io: StoreIO = nodeStoreIO) {
 return {
  async load(): Promise<string | undefined> {
   try {
    const v = JSON.parse((await io.read(file)) ?? 'null');
    return v && typeof v.accountId === 'string' ? v.accountId : undefined;
   } catch {
    return undefined;
   }
  },
  async save(accountId: string): Promise<void> {
   await io.write(file, JSON.stringify({accountId}));
  },
 };
}

/** Snapshot danh bạ (JSON) để mở lại tức thì; file hỏng coi như chưa có. */
export function createDirectorySnapshot(file: string, io: StoreIO = nodeStoreIO) {
 return {
  async load(): Promise<{id: string; name: string; kind: 'direct' | 'group'; memberCount?: number}[] | undefined> {
   try {
    const raw = await io.read(file);
    const v = raw ? JSON.parse(raw) : undefined;
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && (x.kind === 'direct' || x.kind === 'group')) : undefined;
   } catch {
    return undefined;
   }
  },
  async save(entries: unknown[]): Promise<void> {
   await io.write(file, JSON.stringify(entries));
  },
 };
}

export type ZaloAccess = 'write' | 'read' | 'none';
export const DEFAULT_ZALO_ACCESS: ZaloAccess = 'write';
const isAccess = (v: unknown): v is ZaloAccess => v === 'write' || v === 'read' || v === 'none';

/**
 * Quyền của trợ lý AI theo hội thoại (file JSON nhỏ, ghi nguyên tử). Chỉ lưu giá trị khác mặc định 'write'.
 * Lỗi đọc file (không phải thiếu file) được ném ra và KHÔNG cache để lần sau thử lại; file hỏng coi như rỗng.
 */
export function createAccessStore(file: string, io: StoreIO = nodeStoreIO) {
 let cache: Record<string, ZaloAccess> | undefined;
 let chain: Promise<unknown> = Promise.resolve();
 async function load(): Promise<Record<string, ZaloAccess>> {
  if (cache) return cache;
  const raw = await io.read(file);
  const out: Record<string, ZaloAccess> = {};
  try {
   const j: unknown = raw ? JSON.parse(raw) : undefined;
   const a = isRec(j) && isRec(j.access) ? j.access : {};
   for (const [id, v] of Object.entries(a)) if (isAccess(v) && v !== DEFAULT_ZALO_ACCESS) out[id] = v;
  } catch {
   // file hỏng: bắt đầu lại từ mặc định
  }
  return (cache = out);
 }
 return {
  async get(conversationId: string): Promise<ZaloAccess> {
   return (await load())[conversationId] ?? DEFAULT_ZALO_ACCESS;
  },
  /** Đặt quyền; về mặc định thì xóa bản ghi. Ghi lỗi thì cache giữ nguyên giá trị cũ. */
  set(conversationId: string, access: ZaloAccess): Promise<void> {
   const next = chain.then(async () => {
    const cur = await load();
    const draft = {...cur};
    if (access === DEFAULT_ZALO_ACCESS) delete draft[conversationId];
    else draft[conversationId] = access;
    await io.write(file, JSON.stringify({v: 1, access: draft}));
    cache = draft;
   });
   chain = next.catch(() => undefined);
   return next;
  },
 };
}
export type AccessStore = ReturnType<typeof createAccessStore>;

/** I/O thật: thư mục 0700, ghi tmp 0600 rồi rename. */
export const nodeStoreIO: StoreIO = {
 async read(path) {
  try {
   return await readFile(path, 'utf8');
  } catch (e) {
   if ((e as {code?: string}).code === 'ENOENT') return undefined;
   throw e;
  }
 },
 async write(path, content) {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, {mode: 0o600});
  await chmod(tmp, 0o600);
  await rename(tmp, path);
 },
};

export const DEFAULT_ZALO_ACCOUNT = 'default';
const ACCOUNT_DIR_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Đường dẫn dữ liệu Zalo theo tài khoản. 'default' giữ nguyên file cũ (`zalo/history.json`...) để không mất dữ liệu;
 * tài khoản khác nằm riêng trong `zalo/accounts/<id>/`. Id sai dạng bị từ chối để không thoát khỏi thư mục dữ liệu.
 */
export function zaloAccountPaths(rootDir: string, accountId: string = DEFAULT_ZALO_ACCOUNT) {
 if (!ACCOUNT_DIR_RE.test(accountId)) throw new Error('invalid-account');
 const dir = accountId === DEFAULT_ZALO_ACCOUNT ? join(rootDir, 'zalo') : join(rootDir, 'zalo', 'accounts', accountId);
 return {dir, history: join(dir, 'history.json'), marker: join(dir, 'account.json'), snapshot: join(dir, 'directory.json'), avatars: join(dir, 'avatars'), access: join(dir, 'access.json')};
}
