/**
 * ĐỀ XUẤT operation cho contract (chưa đăng ký trong src/index.js). Kiểu theo defineFeatureContract:
 * { kind: 'query'|'action', description, input, output } với TypeBox; input/output là JSON có giới hạn.
 * Cookie chỉ đi vào (messenger.cookies.set) và không bao giờ có trong output.
 */
import {Type} from 'typebox';

const strict = {additionalProperties: false} as const;
const accountId = Type.String({pattern: '^[a-z0-9_-]{1,40}$', maxLength: 40});
const Empty = Type.Object({}, strict);

const loginPhase = Type.Union([Type.Literal('idle'), Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled')]);
const loginReason = Type.Union([Type.Literal('browser-missing'), Type.Literal('launch-failed'), Type.Literal('timeout'), Type.Literal('save-failed'), Type.Null()]);
const LoginStatus = Type.Object({phase: loginPhase, reason: loginReason}, strict);

const cookie = Type.Object(
 {
  name: Type.String({maxLength: 32}),
  value: Type.String({minLength: 1, maxLength: 2048}),
  domain: Type.Optional(Type.String({maxLength: 64})),
  path: Type.Optional(Type.String({maxLength: 64})),
  expires: Type.Optional(Type.Number()),
  httpOnly: Type.Optional(Type.Boolean()),
  secure: Type.Optional(Type.Boolean()),
 },
 strict,
);

/** Lý do không đọc/gửi được; `not-logged-in` và `checkpoint` nghĩa là phải đăng nhập lại. */
const chatReason = Type.Union([
 Type.Literal('not-logged-in'),
 Type.Literal('checkpoint'),
 Type.Literal('e2ee-locked'),
 Type.Literal('selector-broken'),
 Type.Literal('browser-missing'),
 Type.Literal('timeout'),
 Type.Literal('launch-failed'),
 Type.Literal('rate-limited'),
 Type.Literal('invalid-input'),
]);
const folder = Type.Union([Type.Literal('all'), Type.Literal('unread'), Type.Literal('group'), Type.Literal('stranger'), Type.Literal('blocked'), Type.Literal('spam')]);
const conversationId = Type.String({pattern: '^[0-9]{1,30}$', maxLength: 30});
const conversation = Type.Object(
 {
  id: conversationId,
  title: Type.String({maxLength: 120}),
  snippet: Type.String({maxLength: 200}),
  /** Nhãn thời gian đúng như Facebook hiển thị, không phải ISO. */
  time: Type.String({maxLength: 40}),
  unread: Type.Boolean(),
  isGroup: Type.Boolean(),
 },
 strict,
);
const chatMessage = Type.Object(
 {
  id: Type.String({maxLength: 64}),
  from: Type.Union([Type.Literal('me'), Type.Literal('them')]),
  senderName: Type.String({maxLength: 120}),
  text: Type.String({maxLength: 4000}),
  time: Type.String({maxLength: 40}),
 },
 strict,
);

export const BACKEND_OPERATION_IDS = {
 setupCheck: 'setup.check',
 notifySend: 'notify.send',
 messengerLoginStart: 'messenger.login.start',
 messengerLoginStatus: 'messenger.login.status',
 messengerLoginCancel: 'messenger.login.cancel',
 messengerCookiesSet: 'messenger.cookies.set',
 messengerCookiesClear: 'messenger.cookies.clear',
 messengerStatus: 'messenger.status',
 messengerConversations: 'messenger.conversations',
 messengerMessages: 'messenger.messages',
 messengerSend: 'messenger.send',
} as const;

export const backendOperations = {
 [BACKEND_OPERATION_IDS.setupCheck]: {
  kind: 'query',
  description: 'Kiểm tra điều kiện thiết lập backend (Playwright, thông báo OS, cookie Messenger); chỉ trả boolean/enum.',
  input: Empty,
  output: Type.Object(
   {
    browser: Type.Union([Type.Literal('available'), Type.Literal('missing')]),
    desktopNotify: Type.Union([Type.Literal('supported'), Type.Literal('unsupported-platform')]),
    messengerCookies: Type.Object({present: Type.Boolean(), savedAt: Type.Union([Type.Integer({minimum: 0}), Type.Null()])}, strict),
   },
   strict,
  ),
 },
 [BACKEND_OPERATION_IDS.notifySend]: {
  kind: 'action',
  description: 'Gửi thông báo desktop (macOS) với tiêu đề và nội dung ngắn.',
  input: Type.Object({title: Type.String({minLength: 1, maxLength: 80}), body: Type.String({maxLength: 240})}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(Type.Union([Type.Literal('unsupported-platform'), Type.Literal('invalid-input'), Type.Literal('failed')]))}, strict),
 },
 [BACKEND_OPERATION_IDS.messengerLoginStart]: {
  kind: 'action',
  description: 'Mở trình duyệt để người dùng tự đăng nhập Facebook; cookie lưu vào kho bí mật, không trả về.',
  input: Type.Object({account: Type.Optional(accountId)}, strict),
  output: LoginStatus,
 },
 [BACKEND_OPERATION_IDS.messengerLoginStatus]: {
  kind: 'query',
  description: 'Trạng thái phiên đăng nhập Messenger đang chạy.',
  input: Empty,
  output: LoginStatus,
 },
 [BACKEND_OPERATION_IDS.messengerLoginCancel]: {
  kind: 'action',
  description: 'Hủy phiên đăng nhập Messenger đang chạy.',
  input: Empty,
  output: LoginStatus,
 },
 [BACKEND_OPERATION_IDS.messengerCookiesSet]: {
  kind: 'action',
  description: 'Nhập cookie Messenger thủ công (c_user và xs bắt buộc). Chỉ ghi, không bao giờ đọc ngược giá trị.',
  input: Type.Object({account: Type.Optional(accountId), cookies: Type.Array(cookie, {minItems: 2, maxItems: 100})}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(Type.Union([Type.Literal('invalid-account'), Type.Literal('invalid-cookies'), Type.Literal('missing-required'), Type.Literal('io-error')]))}, strict),
 },
 [BACKEND_OPERATION_IDS.messengerCookiesClear]: {
  kind: 'action',
  description: 'Đăng xuất Messenger trên máy này: xóa cookie đã lưu khỏi kho bí mật (không đăng xuất phía Facebook).',
  input: Type.Object({account: Type.Optional(accountId)}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(Type.Union([Type.Literal('invalid-account'), Type.Literal('io-error')]))}, strict),
 },
 [BACKEND_OPERATION_IDS.messengerStatus]: {
  kind: 'query',
  description: 'Trạng thái kết nối Messenger: connected (có cookie, chưa thấy hết hạn), expired (cookie hết hạn/checkpoint) hoặc no-cookies. Không mở trình duyệt.',
  input: Empty,
  output: Type.Object({state: Type.Union([Type.Literal('connected'), Type.Literal('expired'), Type.Literal('no-cookies')]), reason: Type.Union([chatReason, Type.Null()])}, strict),
 },
 [BACKEND_OPERATION_IDS.messengerConversations]: {
  kind: 'query',
  description: 'Danh sách hội thoại Messenger (đọc qua trình duyệt ẩn, có cache và giới hạn tần suất). Chat mã hóa đầu-cuối bị ẩn và chỉ được đếm trong e2eeHidden.',
  input: Type.Object({folder: Type.Optional(folder)}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(chatReason), conversations: Type.Array(conversation, {maxItems: 100}), e2eeHidden: Type.Integer({minimum: 0})}, strict),
 },
 [BACKEND_OPERATION_IDS.messengerMessages]: {
  kind: 'query',
  description: 'Tin nhắn gần nhất (tối đa 100, cũ đến mới) của một hội thoại Messenger.',
  input: Type.Object({conversationId}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(chatReason), messages: Type.Array(chatMessage, {maxItems: 100})}, strict),
 },
 [BACKEND_OPERATION_IDS.messengerSend]: {
  kind: 'action',
  description: 'Gửi một tin văn bản vào hội thoại Messenger bằng cách gõ vào ô soạn như người dùng (có trần tốc độ, không dùng để gửi hàng loạt).',
  input: Type.Object({conversationId, text: Type.String({minLength: 1, maxLength: 4000})}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(chatReason)}, strict),
 },
} as const;

