/** Hợp đồng dữ liệu cho giao diện chat Zalo/Messenger. Không chứa mã kết nối thật. */
export type ChatChannel = 'zalo' | 'messenger';
export type ChatFolder = 'all' | 'unread' | 'group' | 'stranger' | 'blocked' | 'spam';
export type ConversationKind = 'direct' | 'group';

/** Tệp đính kèm đã đọc sẵn thành base64 thuần (không tiền tố data:). */
export interface ChatFile {
  name: string;
  type: string;
  base64: string;
}

export interface ChatAccount {
  id: string;
  name: string;
}

export interface ChatConversation {
  id: string;
  accountId: string;
  name: string;
  kind: ConversationKind;
  /** Xem trước tin cuối. */
  preview: string;
  /** Thời điểm tin cuối, ISO 8601. */
  lastAt: string;
  unread: number;
  /** Dòng phụ trên đầu khung chat, ví dụ "8 thành viên". */
  subtitle?: string;
  /** Có ảnh đại diện để tải qua `getAvatar`; không có thì hiện chữ cái đầu. */
  hasAvatar?: boolean;
}

export interface ChatMessage {
  id: string;
  /** Thời điểm gửi, ISO 8601. */
  at: string;
  text: string;
  fromMe: boolean;
  /** Tên người gửi trong nhóm. */
  author?: string;
}

/** Quyền của trợ lý AI với một hội thoại: đọc và viết (mặc định), chỉ đọc, không truy cập. */
export type ChatAccess = 'write' | 'read' | 'none';

export interface ChatProvider {
  listAccounts(): Promise<ChatAccount[]>;
  listConversations(query: {folder: ChatFolder}): Promise<ChatConversation[]>;
  getMessages(conversationId: string): Promise<ChatMessage[]>;
  send(conversationId: string, text: string): Promise<void>;
  /** Gửi tệp (kèm chú thích tùy chọn); không có thì UI không hiện nút đính kèm. */
  sendFile?(conversationId: string, file: ChatFile, caption: string): Promise<void>;
  /** Đăng ký nhận sự kiện có tin mới (đẩy, không polling); trả hàm hủy. */
  onNewMessage?(listener: () => void): () => void;
  acceptStranger(conversationId: string): Promise<void>;
  block(conversationId: string): Promise<void>;
  unblock(conversationId: string): Promise<void>;
  markSpam(conversationId: string): Promise<void>;
  notSpam(conversationId: string): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
  /** Giải thích riêng từng thư mục khi rỗng (ví dụ thư mục chưa được hỗ trợ). */
  folderEmptyText?: Partial<Record<ChatFolder, string>>;
  /** Câu hiển thị khi hội thoại chưa có tin nào để xem. */
  emptyHistoryText?: string;
  /** Thông báo kèm hướng dẫn (ví dụ bật quyền lưu lịch sử); null nếu không cần. */
  getHistoryNotice?(): Promise<HistoryNotice | null>;
  /** Bật quyền lưu lịch sử khi người dùng bấm nút trong thông báo; ném lỗi nếu không bật được. */
  enableHistory?(): Promise<void>;
  /** Ảnh đại diện của một hội thoại (base64 thuần + mime); tải theo yêu cầu để phản hồi danh sách nhẹ. */
  getAvatar?(conversationId: string): Promise<AvatarData | undefined>;
  /** Quyền của trợ lý AI với hội thoại; chỉ khi có cả getAccess và setAccess thì UI mới hiện ô chọn. */
  getAccess?(conversationId: string): Promise<ChatAccess>;
  /** Lưu quyền của trợ lý AI; ném lỗi nếu không lưu được. */
  setAccess?(conversationId: string, access: ChatAccess): Promise<void>;
}

export interface AvatarData {
  /** Base64 thuần, không có tiền tố `data:`. */
  base64: string;
  type: string;
}

export interface HistoryNotice {
  text: string;
  /** Lệnh người dùng tự chạy, hiển thị nguyên văn. */
  command?: string;
}

/** Kết quả một phiên đăng nhập Messenger bằng trình duyệt. */
export interface BrowserLoginResult {
  phase: 'succeeded' | 'failed' | 'cancelled';
  reason?: string | null;
}

/** Cookie phiên Facebook người dùng cung cấp. Không bao giờ ghi log hay lưu lại ở UI. */
export interface MessengerCookies {
  cUser: string;
  xs: string;
  raw: string;
}

/** Lỗi của provider có thông điệp tiếng Việt an toàn để hiện thẳng cho người dùng (lỗi thường thì UI dùng câu mặc định). */
export class ChatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

export const FOLDER_LOCKED: readonly ChatFolder[] = ['stranger', 'spam', 'blocked'];
