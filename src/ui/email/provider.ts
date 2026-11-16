/** Hợp đồng dữ liệu email cho UI. Không chứa mã Gmail thật hay dữ liệu mẫu. */
export type Folder = 'all' | 'unread' | 'stranger' | 'blocked' | 'spam' | 'trash';
/** Vị trí thật của thư; `all`/`unread` chỉ là góc nhìn lọc từ `inbox`. */
export type Box = 'inbox' | 'stranger' | 'blocked' | 'spam' | 'trash';
export type MoveAction = 'spam' | 'trash' | 'block' | 'unspam' | 'restore' | 'deletePermanent' | 'accept' | 'unblock';

export interface Account {
 readonly id: string;
 readonly address: string;
 /** Màu chấm nhận diện (CSS color). */
 readonly color: string;
 readonly signature?: string;
}
export interface Address {
 readonly name: string;
 readonly address: string;
}
export interface Message {
 readonly id: string;
 readonly accountId: string;
 readonly box: Box;
 readonly from: Address;
 readonly to: readonly string[];
 readonly subject: string;
 readonly snippet: string;
 /** Văn bản thuần; luôn an toàn. */
 readonly text?: string;
 /** HTML thô từ nguồn ngoài; UI luôn lọc qua sanitizeHtml trước khi hiển thị. */
 readonly html?: string;
 /** ISO 8601. */
 readonly date: string;
 readonly unread: boolean;
 readonly pinned?: boolean;
}
export interface Draft {
 readonly accountId: string;
 readonly to: readonly string[];
 readonly cc: readonly string[];
 readonly bcc: readonly string[];
 readonly subject: string;
 /** HTML đã lọc bằng sanitizeHtml. */
 readonly html: string;
 readonly attachments: readonly File[];
 readonly replyToId?: string;
 /** ISO 8601 khi hẹn giờ gửi. */
 readonly scheduleAt?: string;
}
export interface EmailProvider {
 listAccounts(): Promise<readonly Account[]>;
 listMessages(query: {accountIds: readonly string[]; folder: Folder}): Promise<readonly Message[]>;
 getMessage(id: string): Promise<Message>;
 send(draft: Draft): Promise<void>;
 saveDraft?(draft: Draft): Promise<void>;
 moveToFolder(ids: readonly string[], action: MoveAction): Promise<void>;
 markRead(ids: readonly string[], read: boolean): Promise<void>;
}
