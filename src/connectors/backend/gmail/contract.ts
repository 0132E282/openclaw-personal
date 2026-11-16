/**
 * ĐỀ XUẤT operation Gmail cho contract (CHƯA đăng ký trong src/index.js). Cùng kiểu với ../contract.ts:
 * { kind, description, input, output } bằng TypeBox. Không output nào chứa token/clientSecret.
 * 'stranger'/'blocked' không có nhãn Gmail gốc: messages.list trả rỗng + supported:false;
 * messages.move với block/unblock/accept/deletePermanent trả ok:false reason:'unsupported'.
 */
import {Type} from 'typebox';

const strict = {additionalProperties: false} as const;
const accountId = Type.String({pattern: '^g-[0-9a-f]{12}$', maxLength: 14});
const messageId = Type.String({pattern: '^[A-Za-z0-9_-]{1,64}$'});
const Empty = Type.Object({}, strict);
const lit = <T extends string>(...v: T[]) => Type.Union(v.map((x) => Type.Literal(x)));
const nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

const authState = lit('idle', 'waiting', 'succeeded', 'failed', 'cancelled');
const authReason = Type.Union([lit('reauth-required', 'state-mismatch', 'access-denied', 'timeout', 'cancelled', 'bind-failed', 'browser-failed', 'invalid-response', 'no-refresh-token', 'exchange-failed', 'network', 'invalid-input'), Type.Null()]);
const AuthStatus = Type.Object({state: authState, reason: authReason, accountId: nullable(accountId), address: nullable(Type.String({maxLength: 320}))}, strict);

const address = Type.Object({name: Type.String({maxLength: 256}), address: Type.String({maxLength: 320})}, strict);
const message = Type.Object(
 {
  id: messageId,
  accountId,
  box: lit('inbox', 'stranger', 'blocked', 'spam', 'trash'),
  from: address,
  to: Type.Array(Type.String({maxLength: 320}), {maxItems: 100}),
  subject: Type.String({maxLength: 1000}),
  snippet: Type.String({maxLength: 1000}),
  text: Type.Optional(Type.String()),
  html: Type.Optional(Type.String()),
  date: Type.String({maxLength: 40}),
  unread: Type.Boolean(),
 },
 strict,
);
const recipients = Type.Array(Type.String({maxLength: 320}), {maxItems: 100});
const errReason = lit('reauth-required', 'no-account', 'invalid-input', 'unsupported', 'not-found', 'forbidden', 'bad-request', 'rate-limited', 'server-error', 'network', 'auth-failed', 'invalid-response');

export const GMAIL_OPERATION_IDS = {
 authStart: 'gmail.auth.start',
 authStatus: 'gmail.auth.status',
 authCancel: 'gmail.auth.cancel',
 accountsList: 'gmail.accounts.list',
 accountsRemove: 'gmail.accounts.remove',
 messagesList: 'gmail.messages.list',
 messagesGet: 'gmail.messages.get',
 messagesMove: 'gmail.messages.move',
 messagesSend: 'gmail.messages.send',
} as const;

export const gmailOperations = {
 [GMAIL_OPERATION_IDS.authStart]: {
  kind: 'action',
  description: 'Bắt đầu đăng nhập Google (OAuth PKCE, loopback 127.0.0.1) bằng clientId OAuth kiểu Desktop app (bỏ trống clientId thì dùng lại clientId đã lưu của tài khoản có sẵn); mở trình duyệt, trả ngay {state:"waiting"}.',
  input: Type.Object({clientId: Type.Optional(Type.String({minLength: 8, maxLength: 256})), clientSecret: Type.Optional(Type.String({minLength: 1, maxLength: 256}))}, strict),
  output: Type.Object({state: lit('waiting', 'failed')}, strict),
 },
 [GMAIL_OPERATION_IDS.authStatus]: {kind: 'query', description: 'Trạng thái phiên đăng nhập Google đang chạy (không chứa token).', input: Empty, output: AuthStatus},
 [GMAIL_OPERATION_IDS.authCancel]: {kind: 'action', description: 'Hủy phiên đăng nhập Google đang chờ.', input: Empty, output: AuthStatus},
 [GMAIL_OPERATION_IDS.accountsList]: {
  kind: 'query',
  description: 'Danh sách tài khoản Gmail đã kết nối; chỉ metadata. needsReauth=true khi refresh token hết hạn/bị thu hồi (app Testing: 7 ngày).',
  input: Empty,
  output: Type.Object({accounts: Type.Array(Type.Object({id: accountId, address: Type.String({maxLength: 320}), savedAt: Type.Integer({minimum: 0}), needsReauth: Type.Boolean()}, strict), {maxItems: 50})}, strict),
 },
 [GMAIL_OPERATION_IDS.accountsRemove]: {
  kind: 'action',
  description: 'Xóa token của một tài khoản Gmail khỏi kho bí mật cục bộ (không thu hồi quyền phía Google).',
  input: Type.Object({accountId}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(lit('invalid-account', 'io-error'))}, strict),
 },
 [GMAIL_OPERATION_IDS.messagesList]: {
  kind: 'query',
  description: 'Liệt kê thư theo thư mục (all=INBOX, unread=INBOX+UNREAD, spam, trash). stranger/blocked không có nhãn Gmail: trả rỗng, supported:false.',
  input: Type.Object({accountId, folder: lit('all', 'unread', 'stranger', 'blocked', 'spam', 'trash'), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 100})), pageToken: Type.Optional(Type.String({maxLength: 512}))}, strict),
  output: Type.Object({messages: Type.Array(message, {maxItems: 100}), nextPageToken: nullable(Type.String({maxLength: 512})), supported: Type.Boolean()}, strict),
 },
 [GMAIL_OPERATION_IDS.messagesGet]: {kind: 'query', description: 'Lấy một thư đầy đủ (text/html thô; UI phải lọc bằng sanitizeHtml).', input: Type.Object({accountId, id: messageId}, strict), output: message},
 [GMAIL_OPERATION_IDS.messagesMove]: {
  kind: 'action',
  description: 'Đánh dấu đọc/chưa đọc hoặc chuyển thư (spam, unspam, trash, restore) bằng batchModify. block/unblock/accept/deletePermanent: unsupported.',
  input: Type.Object({accountId, ids: Type.Array(messageId, {minItems: 1, maxItems: 1000}), action: lit('spam', 'trash', 'unspam', 'restore', 'block', 'unblock', 'accept', 'deletePermanent', 'markRead', 'markUnread')}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(errReason)}, strict),
 },
 [GMAIL_OPERATION_IDS.messagesSend]: {
  kind: 'action',
  description: 'Gửi thư (RFC 5322, header được mã hóa và chống CRLF injection). Không hỗ trợ đính kèm/hẹn giờ.',
  input: Type.Object({accountId, to: recipients, cc: Type.Optional(recipients), bcc: Type.Optional(recipients), subject: Type.String({maxLength: 998}), text: Type.Optional(Type.String({maxLength: 1_000_000})), html: Type.Optional(Type.String({maxLength: 1_000_000})), replyToId: Type.Optional(messageId)}, strict),
  output: Type.Object({ok: Type.Boolean(), id: Type.Optional(messageId), reason: Type.Optional(errReason)}, strict),
 },
} as const;
