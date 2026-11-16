export const EMAIL_STATUS_OPERATION_ID = 'email.status';
export const MAX_IMAP_ACCOUNTS = 100;

export type GmailState = 'configured' | 'not-configured' | 'unknown';
export type ImapState = 'configured' | 'disabled' | 'not-configured' | 'unknown';

/** Chỉ gồm enum, boolean và số đếm: không có chuỗi nào lấy từ config, nên không thể lộ bí mật. */
export interface EmailStatus {
 gmailPubSub: {state: GmailState; hooksEnabled: boolean; presetEnabled: boolean};
 imap: {state: ImapState; accountCount: number};
 outlook: {state: 'launcher-only'};
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Đọc trạng thái cấu hình email sẵn có của OpenClaw. Chỉ đọc; lỗi thì trả 'unknown'. */
export function readEmailStatus(config: unknown): EmailStatus {
 const status: EmailStatus = {
  gmailPubSub: {state: 'unknown', hooksEnabled: false, presetEnabled: false},
  imap: {state: 'unknown', accountCount: 0},
  outlook: {state: 'launcher-only'},
 };
 try {
  const root = isRec(config) ? config : {};
  const hooks = isRec(root.hooks) ? root.hooks : {};
  const hooksEnabled = hooks.enabled === true;
  const presetEnabled = Array.isArray(hooks.presets) && hooks.presets.includes('gmail');
  const gmail = isRec(hooks.gmail) ? hooks.gmail : {};
  const hasAccount = typeof gmail.account === 'string' && gmail.account !== '';
  status.gmailPubSub = {state: hooksEnabled && presetEnabled && hasAccount ? 'configured' : 'not-configured', hooksEnabled, presetEnabled};
 } catch {
  status.gmailPubSub = {state: 'unknown', hooksEnabled: false, presetEnabled: false};
 }
 try {
  const root = isRec(config) ? config : {};
  const plugins = isRec(root.plugins) ? root.plugins : {};
  const entries = isRec(plugins.entries) ? plugins.entries : {};
  const imap = isRec(entries.imap) ? entries.imap : undefined;
  if (!imap) status.imap = {state: 'not-configured', accountCount: 0};
  else {
   const imapConfig = isRec(imap.config) ? imap.config : {};
   const accounts = isRec(imapConfig.accounts) ? imapConfig.accounts : {};
   const accountCount = Math.min(Object.keys(accounts).length, MAX_IMAP_ACCOUNTS);
   if (imap.enabled === false) status.imap = {state: 'disabled', accountCount};
   else status.imap = {state: imap.enabled === true && accountCount > 0 ? 'configured' : 'not-configured', accountCount};
  }
 } catch {
  status.imap = {state: 'unknown', accountCount: 0};
 }
 return status;
}

interface ConfigApi {
 config?: unknown;
 runtime?: {config?: {current?: () => unknown}};
}

/** Handler cho operation email.status: đọc config hiện tại, không ghi, không gọi mạng. */
export function createEmailStatusHandler(api: ConfigApi) {
 return async (): Promise<EmailStatus> => readEmailStatus(api.runtime?.config?.current?.() ?? api.config);
}
