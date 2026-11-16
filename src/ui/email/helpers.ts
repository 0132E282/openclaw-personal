import type {Folder, Message, MoveAction} from './provider';

export interface Selection {
 readonly selected: ReadonlySet<string>;
 readonly anchor: string | null;
}
export const EMPTY_SELECTION: Selection = {selected: new Set(), anchor: null};

/** Shift: chọn dải từ mốc tới hàng bấm; Ctrl/Cmd: thêm/bớt từng hàng; không phím: chọn riêng hàng đó. */
export function applySelection(order: readonly string[], current: Selection, id: string, mod: {shift?: boolean; meta?: boolean} = {}): Selection {
 const anchorAt = current.anchor === null ? -1 : order.indexOf(current.anchor);
 const at = order.indexOf(id);
 if (at < 0) return current;
 if (mod.shift && anchorAt >= 0) {
  const [a, b] = anchorAt < at ? [anchorAt, at] : [at, anchorAt];
  const range = order.slice(a, b + 1);
  return {selected: new Set(mod.meta ? [...current.selected, ...range] : range), anchor: current.anchor};
 }
 if (mod.meta) {
  const next = new Set(current.selected);
  if (!next.delete(id)) next.add(id);
  return {selected: next, anchor: id};
 }
 return {selected: new Set([id]), anchor: id};
}
export const selectAll = (order: readonly string[]): Selection => ({selected: new Set(order), anchor: order[0] ?? null});

/** Lọc cục bộ theo thư mục: "all" và "unread" chỉ gồm thư hộp đến. */
export function filterMessages(messages: readonly Message[], folder: Folder): Message[] {
 if (folder === 'all') return messages.filter(m => m.box === 'inbox');
 if (folder === 'unread') return messages.filter(m => m.box === 'inbox' && m.unread);
 return messages.filter(m => m.box === folder);
}

export interface Group {
 readonly key: string;
 readonly title: string;
 readonly items: readonly Message[];
}
const TITLES: Partial<Record<Folder, string>> = {
 unread: 'Chưa đọc',
 stranger: 'Người gửi lạ · chưa có trong danh bạ',
 blocked: 'Người gửi đã chặn',
 spam: 'Thư rác · tự xóa sau 30 ngày',
 trash: 'Thùng rác · tự xóa sau 30 ngày',
};
const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Nhóm theo Đã ghim / Hôm nay / Hôm qua / Cũ hơn (thư mục "all"); các mục khác một nhóm có tiêu đề cố định. */
export function groupMessages(messages: readonly Message[], folder: Folder, now: Date): Group[] {
 const sorted = [...messages].sort((a, b) => b.date.localeCompare(a.date));
 if (folder !== 'all') return sorted.length ? [{key: folder, title: `${TITLES[folder]}${folder === 'unread' ? ` · ${sorted.length}` : ''}`, items: sorted}] : [];
 const today = dayStart(now);
 const buckets: Group[] = [
  {key: 'pinned', title: 'Đã ghim', items: sorted.filter(m => m.pinned)},
  {key: 'today', title: 'Hôm nay', items: sorted.filter(m => !m.pinned && dayStart(new Date(m.date)) >= today)},
  {key: 'yesterday', title: 'Hôm qua', items: sorted.filter(m => !m.pinned && dayStart(new Date(m.date)) === today - 86400000)},
  {key: 'older', title: 'Cũ hơn', items: sorted.filter(m => !m.pinned && dayStart(new Date(m.date)) < today - 86400000)},
 ];
 return buckets.filter(g => g.items.length);
}

export function formatTime(iso: string, now: Date): string {
 const d = new Date(iso);
 const diff = dayStart(now) - dayStart(d);
 if (diff <= 0) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
 if (diff === 86400000) return 'Hôm qua';
 return `${d.getDate()}/${d.getMonth() + 1}`;
}

export interface ActionDef {
 readonly label: string;
 readonly act: MoveAction | 'read';
 readonly tone?: 'primary' | 'danger';
}
/** Thao tác ở thanh công cụ khung đọc, theo từng thư mục. */
export const FOLDER_ACTIONS: Partial<Record<Folder, readonly ActionDef[]>> = {
 stranger: [{label: 'Chấp nhận', act: 'accept', tone: 'primary'}, {label: 'Chặn', act: 'block'}, {label: 'Báo spam', act: 'spam'}],
 spam: [{label: 'Không phải spam', act: 'unspam', tone: 'primary'}, {label: 'Xóa vĩnh viễn', act: 'deletePermanent'}, {label: 'Chặn', act: 'block'}],
 blocked: [{label: 'Bỏ chặn', act: 'unblock', tone: 'primary'}, {label: 'Xóa', act: 'trash'}],
 trash: [{label: 'Khôi phục', act: 'restore', tone: 'primary'}, {label: 'Xóa vĩnh viễn', act: 'deletePermanent'}],
};
export const MAIL_ACTIONS: readonly ActionDef[] = [{label: 'Báo spam', act: 'spam'}, {label: 'Chặn', act: 'block'}];
/** Thao tác chọn nhiều (khớp mockup). */
export const BULK_ACTIONS: Record<Folder, readonly ActionDef[]> = {
 all: [{label: 'Đã đọc', act: 'read', tone: 'primary'}, {label: 'Báo spam', act: 'spam'}, {label: 'Chặn', act: 'block'}, {label: 'Xóa', act: 'trash', tone: 'danger'}],
 unread: [{label: 'Đã đọc', act: 'read', tone: 'primary'}, {label: 'Báo spam', act: 'spam'}, {label: 'Chặn', act: 'block'}, {label: 'Xóa', act: 'trash', tone: 'danger'}],
 stranger: [{label: 'Chấp nhận', act: 'accept', tone: 'primary'}, {label: 'Chặn', act: 'block'}, {label: 'Báo spam', act: 'spam'}],
 spam: [{label: 'Không phải spam', act: 'unspam', tone: 'primary'}, {label: 'Xóa vĩnh viễn', act: 'deletePermanent', tone: 'danger'}],
 blocked: [{label: 'Bỏ chặn', act: 'unblock', tone: 'primary'}, {label: 'Xóa', act: 'trash', tone: 'danger'}],
 trash: [{label: 'Khôi phục', act: 'restore', tone: 'primary'}, {label: 'Xóa vĩnh viễn', act: 'deletePermanent', tone: 'danger'}],
};
export const BANNERS: Partial<Record<Folder, {tone: string; title: string; text: string}>> = {
 stranger: {tone: 'amber', title: 'Người gửi chưa có trong danh bạ', text: 'Ảnh từ xa và liên kết đang bị ẩn cho tới khi bạn chấp nhận người gửi này.'},
 spam: {tone: 'red', title: 'Thư này có dấu hiệu lừa đảo', text: 'Liên kết và tệp đính kèm đã bị vô hiệu hóa. Đừng cung cấp mật khẩu hay mã OTP.'},
 blocked: {tone: 'stone', title: 'Bạn đã chặn người gửi này', text: 'Thư mới từ người gửi này tự vào mục Đã chặn và không báo cho bạn.'},
 trash: {tone: 'stone', title: 'Thư trong thùng rác', text: 'Thư sẽ bị xóa vĩnh viễn sau 30 ngày.'},
};

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c] as string));
export const textToHtml = (s: string): string => s.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
export const isEmail = (s: string): boolean => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);
export const initials = (name: string): string => name.trim().split(/\s+/).slice(-2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
const PALETTE = ['#e11d48', '#0284c7', '#059669', '#7c3aed', '#dc2626', '#57534e', '#d97706'];
export const avatarColor = (key: string): string => PALETTE[[...key].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
