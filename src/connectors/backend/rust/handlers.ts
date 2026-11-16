/**
 * Handler proxy: chuyển nguyên input của mọi operation sang core Rust và trả result. Schema TypeBox của
 * contract do SDK kiểm tra ở biên (input trước handler, output sau handler). Khi thiếu binary ('core-missing')
 * dùng handler TS dự phòng (chỉ Gmail) hoặc giá trị an toàn đúng schema cho messenger/notify/setup.
 */
import {GMAIL_OPERATION_IDS} from '../gmail/contract';
import {BACKEND_OPERATION_IDS} from '../contract';
import type {CoreProcess} from './client';

export const RUST_OPERATION_IDS: readonly string[] = [...Object.values(GMAIL_OPERATION_IDS), ...Object.values(BACKEND_OPERATION_IDS)];

type Handler = (input: unknown, ...rest: unknown[]) => Promise<unknown>;

const loginUnavailable = {phase: 'failed', reason: 'launch-failed'};

/** Kết quả an toàn (đúng schema) khi không có core và không có handler TS dự phòng. */
const MISSING_CORE_RESULTS: Record<string, unknown> = {
 [BACKEND_OPERATION_IDS.setupCheck]: {browser: 'missing', desktopNotify: 'unsupported-platform', messengerCookies: {present: false, savedAt: null}},
 [BACKEND_OPERATION_IDS.notifySend]: {ok: false, reason: 'failed'},
 [BACKEND_OPERATION_IDS.messengerLoginStart]: loginUnavailable,
 [BACKEND_OPERATION_IDS.messengerLoginStatus]: loginUnavailable,
 [BACKEND_OPERATION_IDS.messengerLoginCancel]: loginUnavailable,
 [BACKEND_OPERATION_IDS.messengerCookiesSet]: {ok: false, reason: 'io-error'},
 [BACKEND_OPERATION_IDS.messengerCookiesClear]: {ok: false, reason: 'io-error'},
 [BACKEND_OPERATION_IDS.messengerStatus]: {state: 'no-cookies', reason: null},
 [BACKEND_OPERATION_IDS.messengerConversations]: {ok: false, reason: 'launch-failed', conversations: [], e2eeHidden: 0},
 [BACKEND_OPERATION_IDS.messengerMessages]: {ok: false, reason: 'launch-failed', messages: []},
 [BACKEND_OPERATION_IDS.messengerSend]: {ok: false, reason: 'launch-failed'},
};

export function createRustHandlers(opts: {core: CoreProcess; fallback?: Record<string, Handler>}): Record<string, Handler> {
 const out: Record<string, Handler> = {};
 for (const op of RUST_OPERATION_IDS) {
  out[op] = async (input, ...rest) => {
   try {
    return await opts.core.call(op, input);
   } catch (e) {
    if ((e as {code?: unknown} | null)?.code !== 'core-missing') throw e;
    const fb = opts.fallback?.[op];
    if (fb) return fb(input, ...rest);
    if (op in MISSING_CORE_RESULTS) return structuredClone(MISSING_CORE_RESULTS[op]);
    throw e;
   }
  };
 }
 return out;
}
