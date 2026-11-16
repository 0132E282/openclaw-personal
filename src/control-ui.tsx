import {createRoot} from 'react-dom/client';
import type {PluginHost, ViewContext} from './host';
import {EmailStatus} from './connectors/EmailStatus';
import {MessengerStatus} from './connectors/MessengerStatus';
import {ZaloStatus} from './connectors/ZaloStatus';
import {mountPersonal} from './ui/pages';

interface ServiceLink {
 readonly label: string;
 readonly href: string;
}

interface Service {
 readonly id: string;
 readonly icon: string;
 readonly name: string;
 readonly description: string;
 readonly note: string;
 readonly links: readonly ServiceLink[];
}

interface Host {
 ui: {
  registerPage(page: {id: string; label: string; mount: (container: HTMLElement, context?: ViewContext) => {dispose(): void}}): () => void;
  registerNavigation(nav: {id: string; label: string; page: {id: string}; icon: string; parent?: string}): () => void;
 };
}

export const services: readonly Service[] = Object.freeze([
 {id:'email',icon:'✉',name:'Email',description:'Mở nhà cung cấp email của bạn trong trình duyệt riêng.',note:'Chưa kết nối email vào trang này. Chọn Gmail hoặc Outlook và đăng nhập tại trang chính thức.',links:[{label:'Mở Gmail',href:'https://mail.google.com/'},{label:'Mở Outlook',href:'https://outlook.live.com/mail/'}]},
 {id:'zalo',icon:'Z',name:'Zalo cá nhân',description:'Truy cập Zalo Web bằng phiên đăng nhập của bạn.',note:'Trang này chưa kết nối Zalo. Không tự bật tích hợp tài khoản cá nhân không chính thức (có rủi ro khóa tài khoản).',links:[{label:'Mở Zalo Web',href:'https://chat.zalo.me/'}]},
 {id:'messenger',icon:'M',name:'Messenger cá nhân',description:'Mở Messenger chính thức để đọc và trả lời tin nhắn.',note:'Chưa kết nối Messenger cá nhân vào trang này. Tích hợp Facebook Page/Instagram không thay thế tài khoản cá nhân.',links:[{label:'Mở Messenger',href:'https://www.messenger.com/'}]},
]);

function ServiceCard({service, host}: {service: Service; host?: PluginHost}) {
 const titleId = `openclaw-personal-${service.id}`;
 return (
  <article className="openclaw-personal__card" aria-labelledby={titleId}>
   <div className="openclaw-personal__top">
    <span className="openclaw-personal__icon" aria-hidden="true">{service.icon}</span>
    {!(host && (service.id === 'zalo' || service.id === 'messenger')) && <span className="openclaw-personal__status">Chưa kết nối vào trang</span>}
   </div>
   <h2 id={titleId}>{service.name}</h2>
   <p className="openclaw-personal__description">{service.description}</p>
   {host && service.id === 'zalo' && <ZaloStatus host={host} />}
   {host && service.id === 'email' && <EmailStatus host={host} />}
   {host && service.id === 'messenger' && <MessengerStatus host={host} />}
   <div className="openclaw-personal__links">
    {service.links.map(item => (
     <a
      key={item.href}
      className="openclaw-personal__link"
      href={item.href}
      target="_blank"
      rel="noopener noreferrer"
      data-link-reader-external=""
      aria-label={`${item.label} — mở trang ngoài`}
     >{item.label} ↗</a>
    ))}
   </div>
   <p className="openclaw-personal__note">{service.note}</p>
  </article>
 );
}

/** `only` = id dịch vụ: trang chi tiết của một mục con trong sidebar; bỏ trống = trang tổng quan. */
export function Personal({host, only}: {host?: PluginHost; only?: string}) {
 const shown = only ? services.filter(service => service.id === only) : services;
 const single = only ? shown[0] : undefined;
 return (
  <section className="openclaw-personal" lang="vi" aria-label="Personal">
   <header className="openclaw-personal__header">
    <p className="openclaw-personal__eyebrow">{single ? 'PERSONAL' : 'KHÔNG GIAN CÁ NHÂN'}</p>
    <h1>{single ? single.name : 'Personal'}</h1>
    <p className="openclaw-personal__intro">{single ? single.description : 'Email, Zalo và Messenger — các lối tắt của bạn ở một nơi.'}</p>
   </header>
   <aside className="openclaw-personal__notice">
    <strong>Bản đầu: trung tâm mở nhanh</strong>
    <p>Các nút mở trang chính thức trong trình duyệt ngoài, không nhúng vào app. Chưa đồng bộ nội dung, số chưa đọc hoặc thông báo; không tự gửi tin nhắn. Trạng thái từng thẻ chỉ áp dụng cho trang này. Chỉ đọc: thẻ Zalo hiển thị trạng thái kênh zalouser và thẻ Email hiển thị cấu hình email của OpenClaw, thẻ Messenger hiển thị trạng thái kênh Facebook Messenger (Page/Instagram); không đăng nhập, không cấu hình, không gửi.</p>
   </aside>
   <div className={single ? 'openclaw-personal__grid openclaw-personal__grid--single' : 'openclaw-personal__grid'}>
    {shown.map(service => <ServiceCard key={service.id} service={service} host={host} />)}
   </div>
   <footer className="openclaw-personal__footer">
    <h2>Kết nối sâu hơn</h2>
    <p>Để đọc và trả lời email ngay trong app, cần chọn nhà cung cấp và cấp quyền qua luồng đăng nhập chính thức. Zalo và Messenger cá nhân cần được kiểm chứng hỗ trợ riêng. Không nhập mật khẩu, mã OTP hoặc cookie vào cuộc trò chuyện.</p>
   </footer>
  </section>
 );
}

export function mountInbox(container: HTMLElement, context?: ViewContext, only?: string) {
 const root = createRoot(container);
 root.render(<Personal host={context?.host} only={only} />);
 return {dispose() { root.unmount(); }};
}

/** Một mục sidebar duy nhất; các kênh chuyển qua lại bên trong trang. */
export default {id:'openclaw-personal',activate(host: Host) {
 const disposers = [
  host.ui.registerPage({id:'personal',label:'Hộp thư',mount:(container, context) => mountPersonal(container, context?.host)}),
  host.ui.registerNavigation({id:'personal',label:'Hộp thư',page:{id:'personal'},icon:'inbox'}),
 ];
 return () => {for (const dispose of disposers.reverse()) dispose();};
}};
