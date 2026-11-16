/** Phần của context.host mà trang Personal dùng; chữ ký xác minh theo feature-contract.js. */
export interface PluginHost {
 request(method: string, params?: unknown): Promise<unknown>;
 signal?: AbortSignal;
 /** Sự kiện đẩy từ Gateway (ví dụ `plugin.<id>.<event>`); trả hàm hủy đăng ký. Có thể không có ở host cũ. */
 onEvent?(name: string, listener: (payload: unknown) => void): () => void;
}

export interface ViewContext {
 host?: PluginHost;
 signal?: AbortSignal;
}

export const REQUEST_TIMEOUT_MS = 10_000;

/** Gọi host.request với timeout; reject khi quá hạn hoặc signal đã hủy. */
export async function requestWithTimeout(host: PluginHost, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 const timeout = new Promise<never>((_, reject) => {
  timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
 });
 try {
  return await Promise.race([host.request(method, params), timeout]);
 } finally {
  clearTimeout(timer);
 }
}
