/**
 * Ảnh đại diện Zalo: tải một lần từ URL CDN trong `openclaw directory`, lưu cục bộ (thư mục 0700, file 0600)
 * thành file ảnh thật (`<id>.jpg|png|webp|gif`) để giao diện không phụ thuộc URL ký tên hết hạn hay chính sách tải ảnh ngoài.
 */
import {chmod, mkdir, readdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export interface FetchedImage {
 type: string;
 bytes: Uint8Array;
}
export type ImageFetcher = (url: string) => Promise<FetchedImage | undefined>;

/** Giới hạn nhỏ để mỗi phản hồi `zalo.avatar` nằm trong ngưỡng JSON của host. */
const MAX_BYTES = 60_000;
const HOSTS = ['zadn.vn', 'zdn.vn', 'zaloapp.com'];
const MIME_RE = /^image\/(jpe?g|png|webp|gif)$/;
const FILE_RE = /^([0-9A-Za-z_-]{1,64})\.(jpg|png|webp|gif)$/;
const LEGACY_RE = /^([0-9A-Za-z_-]{1,64})\.txt$/;
const DATA_URI_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
const EXT: Record<string, string> = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'};
const TYPE_OF: Record<string, string> = {jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif'};

export interface StoredAvatar {
 type: string;
 /** Base64 thuần (không có tiền tố data:) để trả trong JSON có giới hạn của host. */
 base64: string;
}

/** Chỉ https tới CDN của Zalo: tránh biến plugin thành công cụ gọi URL tùy ý. */
export function isZaloImageUrl(raw: string): boolean {
 try {
  const u = new URL(raw);
  return u.protocol === 'https:' && HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
 } catch {
  return false;
 }
}

export const fetchImage: ImageFetcher = async (url) => {
 if (!isZaloImageUrl(url)) return undefined;
 try {
  const res = await fetch(url, {signal: AbortSignal.timeout(10_000), redirect: 'error'});
  const raw = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const type = raw === 'image/jpg' ? 'image/jpeg' : raw; // CDN Zalo trả 'image/jpg'
  if (!res.ok || !MIME_RE.test(type)) return undefined;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length > 0 && bytes.length <= MAX_BYTES ? {type, bytes} : undefined;
 } catch {
  return undefined;
 }
};

const idOf = (id: string) => id.replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 64);

export function createAvatarStore(deps: {dir: string; fetchImage?: ImageFetcher}) {
 const fetcher = deps.fetchImage ?? fetchImage;
 const items = new Map<string, StoredAvatar>();
 let loaded: Promise<void> | undefined;
 let running: Promise<void> | undefined;
 /** Tăng mỗi lần xóa: lượt tải đang chạy của tài khoản cũ không được ghi ảnh sau khi đã xóa. */
 let gen = 0;

 /** Ghi nguyên tử file ảnh nhị phân (0600) và xóa bản cũ khác đuôi của cùng id. */
 async function writeImage(key: string, type: string, bytes: Uint8Array): Promise<void> {
  await mkdir(deps.dir, {recursive: true, mode: 0o700});
  const file = join(deps.dir, `${key}.${EXT[type]}`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes, {mode: 0o600});
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  for (const ext of Object.values(EXT)) if (`${key}.${ext}` !== `${key}.${EXT[type]}`) await unlink(join(deps.dir, `${key}.${ext}`)).catch(() => undefined);
  items.set(key, {type, base64: Buffer.from(bytes).toString('base64')});
 }

 /** Đọc ảnh đã lưu một lần; file `.txt` (data URI) bản cũ được đổi thành file ảnh rồi xóa. */
 function ready(): Promise<void> {
  loaded ??= (async () => {
   let names: string[] = [];
   try {
    names = await readdir(deps.dir);
   } catch {
    return;
   }
   for (const n of names) {
    const m = FILE_RE.exec(n);
    if (!m) continue;
    try {
     const bytes = await readFile(join(deps.dir, n));
     if (bytes.length > 0 && bytes.length <= MAX_BYTES) items.set(m[1], {type: TYPE_OF[m[2]], base64: bytes.toString('base64')});
    } catch {
     // bỏ qua file hỏng
    }
   }
   for (const n of names) {
    const m = LEGACY_RE.exec(n);
    if (!m) continue;
    const path = join(deps.dir, n);
    try {
     const uri = DATA_URI_RE.exec(await readFile(path, 'utf8'));
     if (uri && !items.has(m[1])) {
      const bytes = Buffer.from(uri[2], 'base64');
      if (bytes.length > 0 && bytes.length <= MAX_BYTES) await writeImage(m[1], uri[1], bytes);
     }
     await unlink(path);
    } catch {
     // giữ nguyên file cũ nếu chưa chuyển được
    }
   }
  })();
  return loaded;
 }

 async function save(id: string, img: FetchedImage): Promise<void> {
  await writeImage(idOf(id), img.type, img.bytes);
 }

 /** Tải các ảnh còn thiếu (song song 4), chạy nền; gọi chồng thì dùng lại lượt đang chạy. */
 function ensure(entries: ReadonlyArray<{id: string; avatarUrl?: string}>): Promise<void> {
  running ??= (async () => {
   await ready();
   const myGen = gen;
   const todo = entries.filter((e) => e.avatarUrl && !items.has(idOf(e.id)));
   let next = 0;
   const worker = async () => {
    while (next < todo.length) {
     const e = todo[next++];
     const img = await fetcher(e.avatarUrl!);
     if (img && myGen === gen) await save(e.id, img).catch(() => undefined);
    }
   };
   await Promise.all(Array.from({length: Math.min(4, todo.length)}, worker));
  })().finally(() => { running = undefined; });
  return running;
 }

 /** Xóa toàn bộ ảnh đã lưu (đổi tài khoản Zalo). */
 async function clear(): Promise<void> {
  gen++;
  await ready();
  items.clear();
  let names: string[] = [];
  try {
   names = await readdir(deps.dir);
  } catch {
   return;
  }
  for (const n of names) if (FILE_RE.test(n) || LEGACY_RE.test(n)) await unlink(join(deps.dir, n)).catch(() => undefined);
 }

 return {ready, ensure, clear, get: (id: string) => items.get(idOf(id))};
}
export type AvatarStore = ReturnType<typeof createAvatarStore>;
