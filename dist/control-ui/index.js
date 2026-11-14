export const services = Object.freeze([
 {id:'email',icon:'✉',name:'Email',description:'Mở nhà cung cấp email của bạn trong trình duyệt riêng.',note:'Chưa kết nối email vào trang này. Chọn Gmail hoặc Outlook và đăng nhập tại trang chính thức.',links:[{label:'Mở Gmail',href:'https://mail.google.com/'},{label:'Mở Outlook',href:'https://outlook.live.com/mail/'}]},
 {id:'zalo',icon:'Z',name:'Zalo cá nhân',description:'Truy cập Zalo Web bằng phiên đăng nhập của bạn.',note:'Trang này chưa kết nối Zalo. Không tự bật tích hợp tài khoản cá nhân không chính thức (có rủi ro khóa tài khoản).',links:[{label:'Mở Zalo Web',href:'https://chat.zalo.me/'}]},
 {id:'messenger',icon:'M',name:'Messenger cá nhân',description:'Mở Messenger chính thức để đọc và trả lời tin nhắn.',note:'Chưa kết nối Messenger cá nhân vào trang này. Tích hợp Facebook Page/Instagram không thay thế tài khoản cá nhân.',links:[{label:'Mở Messenger',href:'https://www.messenger.com/'}]},
]);
export function mountInbox(container) {
 const doc=container.ownerDocument;
 function element(tag,cls,text){const n=doc.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;}
 const root=element('section','openclaw-personal');root.lang='vi';root.setAttribute('aria-label','Personal');
 const header=element('header','openclaw-personal__header');
 header.append(element('p','openclaw-personal__eyebrow','KHÔNG GIAN CÁ NHÂN'),element('h1','','Personal'),element('p','openclaw-personal__intro','Email, Zalo và Messenger — các lối tắt của bạn ở một nơi.'));
 const notice=element('aside','openclaw-personal__notice');
 notice.append(element('strong','','Bản đầu: trung tâm mở nhanh'),element('p','','Các nút mở trang chính thức trong trình duyệt ngoài, không nhúng vào app. Chưa đồng bộ nội dung, số chưa đọc hoặc thông báo; không tự gửi tin nhắn. Trạng thái dưới đây chỉ áp dụng cho trang này, không phản ánh các kênh khác đã cấu hình trong OpenClaw.'));
 const grid=element('div','openclaw-personal__grid');
 for(const service of services){
  const card=element('article','openclaw-personal__card');card.setAttribute('aria-labelledby','openclaw-personal-'+service.id);
  const top=element('div','openclaw-personal__top');const icon=element('span','openclaw-personal__icon',service.icon);icon.setAttribute('aria-hidden','true');
  top.append(icon,element('span','openclaw-personal__status','Chưa kết nối vào trang'));
  const title=element('h2','',service.name);title.id='openclaw-personal-'+service.id;
  const links=element('div','openclaw-personal__links');
  for(const item of service.links){const link=element('a','openclaw-personal__link',item.label+' ↗');link.href=item.href;link.target='_blank';link.rel='noopener noreferrer';link.dataset.linkReaderExternal='';link.setAttribute('aria-label',item.label+' — mở trang ngoài');links.append(link);}
  card.append(top,title,element('p','openclaw-personal__description',service.description),links,element('p','openclaw-personal__note',service.note));grid.append(card);
 }
 const footer=element('footer','openclaw-personal__footer');
 footer.append(element('h2','','Kết nối sâu hơn'),element('p','','Để đọc và trả lời email ngay trong app, cần chọn nhà cung cấp và cấp quyền qua luồng đăng nhập chính thức. Zalo và Messenger cá nhân cần được kiểm chứng hỗ trợ riêng. Không nhập mật khẩu, mã OTP hoặc cookie vào cuộc trò chuyện.'));
 root.append(header,notice,grid,footer);container.append(root);return {dispose(){root.remove();}};
}
export default {id:'openclaw-personal',activate(host){
 const page=host.ui.registerPage({id:'inbox',label:'Personal',mount:mountInbox});
 const navigation=host.ui.registerNavigation({id:'inbox',label:'Personal',page:{id:'inbox'},icon:'mail'});
 return ()=>{navigation();page();};
}};
