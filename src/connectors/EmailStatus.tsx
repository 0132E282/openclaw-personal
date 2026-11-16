import {useEffect, useState} from 'react';
import {requestWithTimeout, type PluginHost} from '../host';
import {EMAIL_STATUS_OPERATION_ID, type EmailStatus as Status} from './email';

const PLUGIN_ID = 'openclaw-personal';
const UNKNOWN = 'Không xác định được trạng thái';

export function gmailLabel(s: Status['gmailPubSub']): string {
 if (s.state === 'configured') return 'Đã cấu hình trong OpenClaw (không xác nhận đang chạy)';
 if (s.state === 'not-configured') return 'Chưa cấu hình — xem: openclaw webhooks gmail setup';
 return UNKNOWN;
}

export function imapLabel(s: Status['imap']): string {
 if (s.state === 'configured') return `Đã cấu hình trong OpenClaw, ${s.accountCount} tài khoản (không xác nhận đang chạy)`;
 if (s.state === 'disabled') return 'Plugin imap đang tắt';
 if (s.state === 'not-configured') return 'Chưa cấu hình (plugin imap dùng mật khẩu ứng dụng, không khuyến nghị)';
 return UNKNOWN;
}

export const OUTLOOK_LABEL = 'Chưa có tích hợp OpenClaw đã xác minh — dùng nút mở trang';

/** Chấp nhận kết quả đúng dạng; sai dạng coi như không xác định. */
function asStatus(result: unknown): Status | undefined {
 const r = result as Partial<Status> | null;
 if (!r || typeof r !== 'object' || !r.gmailPubSub || !r.imap) return undefined;
 return {gmailPubSub: r.gmailPubSub, imap: r.imap, outlook: {state: 'launcher-only'}};
}

export function EmailStatus({host}: {host: PluginHost}) {
 const [status, setStatus] = useState<Status | 'loading' | 'failed'>('loading');
 useEffect(() => {
  let current = true;
  requestWithTimeout(host, 'plugins.sessionAction', {pluginId: PLUGIN_ID, actionId: EMAIL_STATUS_OPERATION_ID, payload: {}}).then(
   response => {
    const result = (response as {ok?: boolean; result?: unknown} | null)?.ok === true ? asStatus((response as {result: unknown}).result) : undefined;
    if (current) setStatus(result ?? 'failed');
   },
   () => { if (current) setStatus('failed'); },
  );
  return () => { current = false; };
 }, [host]);
 const text = (pick: (s: Status) => string) => status === 'loading' ? 'Đang kiểm tra…' : status === 'failed' ? UNKNOWN : pick(status);
 return (
  <ul className="openclaw-personal__email-status" aria-label="Trạng thái email trong OpenClaw">
   <li><strong>Gmail PubSub:</strong> {text(s => gmailLabel(s.gmailPubSub))}</li>
   <li><strong>IMAP:</strong> {text(s => imapLabel(s.imap))}</li>
   <li><strong>Outlook:</strong> {OUTLOOK_LABEL}</li>
  </ul>
 );
}
