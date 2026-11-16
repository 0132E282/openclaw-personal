/**
 * Operation Zalo cho contract. Nguồn dữ liệu: CLI `openclaw directory` (danh sách), `openclaw message send`
 * (gửi) và kho tin cục bộ do hook `message_received` + tin gửi từ app tạo ra (CLI không đọc được lịch sử zalouser).
 */
import {Type} from 'typebox';

const strict = {additionalProperties: false} as const;
const lit = <T extends string>(...v: T[]) => Type.Union(v.map((x) => Type.Literal(x)));
const Empty = Type.Object({}, strict);
/** Người dùng: id số; nhóm: 'group:<id>' (đúng dạng `openclaw directory` trả về). */
const conversationId = Type.String({pattern: '^(group:)?[0-9A-Za-z_-]{1,64}$', maxLength: 70});
/** Id tài khoản Zalo (profile của OpenClaw); bỏ qua thì là 'default'. Không có dấu chấm/gạch chéo nên an toàn làm tên thư mục và khóa cấu hình. */
export const ZALO_ACCOUNT_ID_PATTERN = '^[A-Za-z0-9_-]{1,40}$';
const accountId = Type.Optional(Type.String({pattern: ZALO_ACCOUNT_ID_PATTERN, maxLength: 40}));

export const ZALO_CHANNEL = 'zalouser';
export const ZALO_OPERATION_IDS = {
 status: 'zalo.status',
 conversations: 'zalo.conversations',
 messages: 'zalo.messages',
 send: 'zalo.send',
 enableHistory: 'zalo.history.enable',
 avatar: 'zalo.avatar',
 accountSync: 'zalo.account.sync',
 messageRecord: 'zalo.message.record',
 accessGet: 'zalo.access.get',
 accessSet: 'zalo.access.set',
 sendAllow: 'zalo.send.allow',
 accountAdd: 'zalo.accounts.add',
 accountRemove: 'zalo.accounts.remove',
} as const;

/** Id do Hộp thư tự sinh cho tài khoản mới. */
export const ZALO_NEW_ACCOUNT_PATTERN = '^[a-z0-9-]{1,40}$';

export const ZALO_FOLDERS = ['all', 'unread', 'group', 'stranger', 'blocked', 'spam'] as const;
/** Chỉ 'all' và 'group' có dữ liệu; các thư mục còn lại trả rỗng + supported:false. */
export const ZALO_SUPPORTED_FOLDERS: readonly string[] = ['all', 'group'];

export const ZALO_CONVERSATION_ACCESS_COMMAND = 'openclaw config set plugins.entries.openclaw-personal.hooks.allowConversationAccess true --strict-json';

const access = lit('write', 'read', 'none');
const unavailable = Type.Union([lit('conversation-access-disabled'), Type.Null()]);

export const zaloOperations = {
 [ZALO_OPERATION_IDS.status]: {
  kind: 'query',
  description: 'Trạng thái lưu lịch sử Zalo: hook message_received đã được cấp quyền hội thoại hay chưa (chỉ đọc cấu hình, không sửa).',
  input: Empty,
  output: Type.Object({historyAccess: lit('enabled', 'disabled', 'unknown'), enableCommand: Type.String({maxLength: 200})}, strict),
 },
 [ZALO_OPERATION_IDS.conversations]: {
  kind: 'query',
  description: 'Liệt kê liên hệ và nhóm Zalo (CLI openclaw directory) kèm tin cuối đã lưu. Thư mục chưa hỗ trợ trả rỗng, supported:false.',
  input: Type.Object({folder: lit(...ZALO_FOLDERS), accountId}, strict),
  output: Type.Object(
   {
    conversations: Type.Array(
     Type.Object({id: conversationId, name: Type.String({maxLength: 200}), kind: lit('direct', 'group'), preview: Type.String({maxLength: 200}), lastAt: Type.String({maxLength: 40}), subtitle: Type.Optional(Type.String({maxLength: 80})), hasAvatar: Type.Optional(Type.Boolean())}, strict),
     {maxItems: 1000},
    ),
    supported: Type.Boolean(),
    reason: Type.Optional(lit('cli-missing', 'timeout', 'failed', 'loading')),
   },
   strict,
  ),
 },
 [ZALO_OPERATION_IDS.messages]: {
  kind: 'query',
  description: 'Tin nhắn Zalo đã lưu cục bộ của một hội thoại. unavailable="conversation-access-disabled" khi người dùng chưa bật quyền hội thoại cho hook.',
  input: Type.Object({conversationId, accountId}, strict),
  output: Type.Object(
   {
    messages: Type.Array(
     Type.Object({id: Type.String({maxLength: 80}), at: Type.String({maxLength: 40}), text: Type.String({maxLength: 4000}), fromMe: Type.Boolean(), author: Type.Optional(Type.String({maxLength: 120}))}, strict),
     {maxItems: 200},
    ),
    unavailable,
   },
   strict,
  ),
 },
 [ZALO_OPERATION_IDS.send]: {
  kind: 'action',
  description: 'Gửi tin nhắn Zalo tới một liên hệ/nhóm bằng CLI `openclaw message send`. Chỉ gọi khi người dùng bấm gửi.',
  input: Type.Object({conversationId, text: Type.String({minLength: 1, maxLength: 2000}), accountId}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(lit('invalid-input', 'cli-missing', 'timeout', 'failed'))}, strict),
 },
 [ZALO_OPERATION_IDS.enableHistory]: {
  kind: 'action',
  description: 'Bật quyền truy cập hội thoại cho plugin (`hooks.allowConversationAccess`) bằng `openclaw config set`. Chỉ gọi khi người dùng bấm Bật.',
  input: Type.Object({}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(lit('cli-missing', 'timeout', 'failed'))}, strict),
 },
 [ZALO_OPERATION_IDS.avatar]: {
  kind: 'query',
  description: 'Ảnh đại diện Zalo đã lưu cục bộ của một liên hệ (base64 thuần kèm mime), hoặc null nếu chưa có.',
  input: Type.Object({conversationId, accountId}, strict),
  output: Type.Object({avatar: Type.Union([Type.String({maxLength: 100_000, pattern: '^[A-Za-z0-9+/=]*$'}), Type.Null()]), type: Type.Optional(lit('image/jpeg', 'image/png', 'image/webp', 'image/gif'))}, strict),
 },
 [ZALO_OPERATION_IDS.accountSync]: {
  kind: 'action',
  description: 'Báo userId Zalo đang đăng nhập của một tài khoản Hộp thư; nếu khác userId của dữ liệu cục bộ tài khoản đó thì chỉ xóa danh bạ, ảnh và lịch sử của tài khoản đó.',
  input: Type.Object({accountId, userId: conversationId}, strict),
  output: Type.Object({ok: Type.Boolean(), reset: Type.Boolean()}, strict),
 },
 [ZALO_OPERATION_IDS.messageRecord]: {
  kind: 'action',
  description: 'Lưu cục bộ tin vừa gửi từ Hộp thư (gửi thật do Gateway thực hiện) để hiện trong hội thoại.',
  input: Type.Object({conversationId, text: Type.String({minLength: 1, maxLength: 2000}), accountId}, strict),
  output: Type.Object({ok: Type.Boolean()}, strict),
 },
 [ZALO_OPERATION_IDS.accessGet]: {
  kind: 'query',
  description: 'Quyền của trợ lý AI với một hội thoại Zalo: write (đọc và viết, mặc định), read (chỉ đọc), none (không truy cập).',
  input: Type.Object({conversationId, accountId}, strict),
  output: Type.Object({access}, strict),
 },
 [ZALO_OPERATION_IDS.accessSet]: {
  kind: 'action',
  description: 'Đặt quyền của trợ lý AI với một hội thoại Zalo (lưu cục bộ theo tài khoản). Chỉ gọi khi người dùng đổi lựa chọn.',
  input: Type.Object({conversationId, access, accountId}, strict),
  output: Type.Object({ok: Type.Boolean()}, strict),
 },
 [ZALO_OPERATION_IDS.sendAllow]: {
  kind: 'action',
  description: 'Báo trước tin người dùng sắp tự gửi từ Hộp thư để hook chặn gửi của trợ lý AI cho phép tin đó đi qua (hiệu lực ngắn).',
  input: Type.Object({conversationId, text: Type.Optional(Type.String({maxLength: 2000})), accountId}, strict),
  output: Type.Object({ok: Type.Boolean()}, strict),
 },
 [ZALO_OPERATION_IDS.accountAdd]: {
  kind: 'action',
  description: 'Tạo tài khoản Zalo mới (id `acc-<base36>`) bằng `openclaw config set channels.zalouser.accounts.<id>` (DM mở). Chỉ gọi khi người dùng bấm Thêm tài khoản.',
  input: Type.Object({}, strict),
  output: Type.Object({ok: Type.Boolean(), accountId: Type.Optional(Type.String({pattern: ZALO_NEW_ACCOUNT_PATTERN, maxLength: 40})), reason: Type.Optional(lit('cli-missing', 'timeout', 'failed'))}, strict),
 },
 [ZALO_OPERATION_IDS.accountRemove]: {
  kind: 'action',
  description: 'Gỡ cấu hình một tài khoản Zalo (không phải default) bằng `openclaw config unset`. Chỉ gọi khi người dùng xác nhận.',
  input: Type.Object({accountId: Type.String({pattern: ZALO_ACCOUNT_ID_PATTERN, maxLength: 40})}, strict),
  output: Type.Object({ok: Type.Boolean(), reason: Type.Optional(lit('invalid-input', 'cli-missing', 'timeout', 'failed'))}, strict),
 },
} as const;

/** Sự kiện đẩy tới giao diện (không chứa nội dung tin): giao diện chỉ cần biết hội thoại nào có tin mới để tải lại. */
export const zaloEvents = {
 'zalo-message': Type.Object({conversationId, accountId}, strict),
} as const;
