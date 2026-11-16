/**
 * Thông báo OS trên macOS qua osascript. Nội dung truyền bằng argv (AppleScript `on run argv`),
 * KHÔNG nối vào chuỗi script và KHÔNG qua shell (execFile).
 */
export type NotifyFailure = 'unsupported-platform' | 'invalid-input' | 'failed';
export type NotifyResult = {ok: true} | {ok: false; reason: NotifyFailure};

export type Runner = (file: string, args: string[], opts: {timeout: number}) => Promise<unknown>;

export const MAX_TITLE = 80;
export const MAX_BODY = 240;
export const NOTIFY_TIMEOUT_MS = 5000;

export const APPLESCRIPT_LINES = [
 'on run argv',
 'display notification (item 2 of argv) with title (item 1 of argv)',
 'end run',
] as const;

/** Bỏ ký tự điều khiển, gộp khoảng trắng, cắt độ dài; chặn chuỗi bắt đầu bằng '-' bị osascript hiểu là option. */
export function cleanText(input: unknown, max: number): string {
 if (typeof input !== 'string') return '';
 // \s trong bước sau cũng gộp U+2028/U+2029.
 let s = input.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
 if (s.length > max) s = s.slice(0, max - 1) + '…';
 return s.startsWith('-') ? ' ' + s : s;
}

export function buildOsascriptArgs(title: string, body: string): string[] {
 return [...APPLESCRIPT_LINES.flatMap((l) => ['-e', l]), title, body];
}

export interface NotifyDeps {
 run: Runner;
 platform?: string;
}

export function createDesktopNotify(deps: NotifyDeps) {
 const platform = deps.platform ?? (globalThis as {process?: {platform?: string}}).process?.platform ?? '';
 return async function notify(title: unknown, body: unknown): Promise<NotifyResult> {
  if (platform !== 'darwin') return {ok: false, reason: 'unsupported-platform'};
  const t = cleanText(title, MAX_TITLE);
  const b = cleanText(body, MAX_BODY);
  if (!t.trim()) return {ok: false, reason: 'invalid-input'};
  try {
   await deps.run('osascript', buildOsascriptArgs(t, b), {timeout: NOTIFY_TIMEOUT_MS});
   return {ok: true};
  } catch {
   return {ok: false, reason: 'failed'};
  }
 };
}

/** Runner thật dựa trên child_process.execFile (không shell). Wiring truyền vào `execFile` đã promisify. */
export function createExecFileRunner(execFile: (file: string, args: string[], opts: {timeout: number}) => Promise<unknown>): Runner {
 return (file, args, opts) => execFile(file, args, opts);
}
