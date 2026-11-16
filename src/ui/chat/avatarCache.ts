import type {AvatarData} from './provider';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Base64 thuần -> Blob ảnh; null nếu mime lạ hoặc base64 hỏng. */
export function avatarBlob({base64, type}: AvatarData): Blob | null {
  if (!IMAGE_TYPES.has(type)) return null;
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], {type});
  } catch {
    return null;
  }
}

/** Nhớ blob URL theo id trong một phiên; `dispose` thu hồi toàn bộ URL khi không còn dùng. */
export function createAvatarCache(fetchAvatar?: (id: string) => Promise<AvatarData | undefined>) {
  const urls = new Map<string, string | null>();
  const pending = new Map<string, Promise<string | null>>();
  let disposed = false;
  return {
    peek: (id: string) => urls.get(id),
    has: (id: string) => urls.has(id),
    load(id: string): Promise<string | null> {
      if (urls.has(id)) return Promise.resolve(urls.get(id) ?? null);
      if (!fetchAvatar) return Promise.resolve(null);
      let p = pending.get(id);
      if (!p) {
        p = fetchAvatar(id).then(data => {
          const blob = data ? avatarBlob(data) : null;
          if (disposed) return null;
          const url = blob ? URL.createObjectURL(blob) : null;
          urls.set(id, url);
          return url;
        }, () => null).finally(() => pending.delete(id));
        pending.set(id, p);
      }
      return p;
    },
    dispose() {
      disposed = true;
      for (const url of urls.values()) if (url) URL.revokeObjectURL(url);
      urls.clear();
      pending.clear();
    },
  };
}
export type AvatarCache = ReturnType<typeof createAvatarCache>;
