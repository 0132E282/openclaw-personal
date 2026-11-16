import {Type} from 'typebox';
import {defineFeaturePlugin} from 'openclaw/plugin-sdk/feature-plugin';
import {defineFeatureContract} from 'openclaw/plugin-sdk/feature-contract';
import {EMAIL_STATUS_OPERATION_ID,createEmailStatusHandler} from './connectors/email.ts';
import {gmailOperations} from './connectors/backend/gmail/contract.ts';
import {createGmailHandlers} from './connectors/backend/gmail/service.ts';
import {backendOperations} from './connectors/backend/contract.ts';
import {zaloEvents,zaloOperations} from './connectors/backend/zalo/contract.ts';
import {createZaloCli,defaultBins,nodeRunner} from './connectors/backend/zalo/cli.ts';
import {createAccessStore,createAccountMarker,createDirectorySnapshot,createZaloStore,nodeStoreIO,zaloAccountPaths} from './connectors/backend/zalo/store.ts';
import {createAvatarStore} from './connectors/backend/zalo/avatars.ts';
import {createZaloService} from './connectors/backend/zalo/service.ts';
import {createCoreProcess,nodeSpawn,resolveCoreBinary} from './connectors/backend/rust/client.ts';
import {createRustHandlers} from './connectors/backend/rust/handlers.ts';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const state=Type.Union([Type.Literal('configured'),Type.Literal('not-configured'),Type.Literal('unknown')]);
const imapState=Type.Union([Type.Literal('configured'),Type.Literal('disabled'),Type.Literal('not-configured'),Type.Literal('unknown')]);
const contract=defineFeatureContract({pluginId:'openclaw-personal',operations:{
 [EMAIL_STATUS_OPERATION_ID]:{kind:'query',description:'Trạng thái chỉ đọc của tích hợp email sẵn có trong OpenClaw.',
  input:Type.Object({},{additionalProperties:false}),
  output:Type.Object({
   gmailPubSub:Type.Object({state,hooksEnabled:Type.Boolean(),presetEnabled:Type.Boolean()},{additionalProperties:false}),
   imap:Type.Object({state:imapState,accountCount:Type.Integer({minimum:0,maximum:100})},{additionalProperties:false}),
   outlook:Type.Object({state:Type.Literal('launcher-only')},{additionalProperties:false}),
  },{additionalProperties:false})},

 ...gmailOperations,
 ...backendOperations,
 ...zaloOperations,
},events:{...zaloEvents}});
export default defineFeaturePlugin({
 contract,name:'Personal',description:'Personal hub: Gmail (OAuth), Zalo and Messenger status, with setup guidance.',
 setup(api,events){
  const stateDir=process.env.OPENCLAW_STATE_DIR||join(homedir(),'.openclaw','state');
  const rootDir=join(stateDir,'openclaw-personal');
  const pluginRoot=join(dirname(fileURLToPath(import.meta.url)),'..');
  const binaryPath=resolveCoreBinary({env:process.env,pluginRoot});
  const core=createCoreProcess({binaryPath,stateDir:join(stateDir,'openclaw-personal-core'),spawn:nodeSpawn,fetch:(u,i)=>fetch(u,i)});
  // Rust là chính; handler TS Gmail chỉ là dự phòng khi thiếu binary ('core-missing').
  const rust=createRustHandlers({core,fallback:createGmailHandlers({rootDir})});
  // SDK gọi stop() của service khi plugin dừng/gỡ (đã kiểm chứng trong docs registerService).
  api.registerService?.({id:'openclaw-personal:core',start(){},stop(){core.stop();}});
  // Zalo: danh bạ/gửi qua CLI openclaw; lịch sử do hook message_received lưu cục bộ (cần người dùng bật allowConversationAccess).
  const zalo=createZaloService({
   cli:createZaloCli({run:nodeRunner,bins:defaultBins(process.env)}),
   // Mỗi tài khoản có bộ dữ liệu riêng; 'default' dùng đúng đường dẫn cũ nên không mất dữ liệu.
   forAccount:(id)=>{const p=zaloAccountPaths(rootDir,id);return {
    store:createZaloStore({io:nodeStoreIO,file:p.history}),
    access:createAccessStore(p.access),
    account:createAccountMarker(p.marker),
    avatars:createAvatarStore({dir:p.avatars}),
    snapshot:createDirectorySnapshot(p.snapshot),
   };},
   getConfig:()=>{try{return api.runtime?.config?.current?.()??api.config;}catch{return undefined;}},
  });
  api.on?.('message_sent',async(event,ctx)=>{
   const r=await zalo.recordSent(event,ctx);
   if(r){try{events?.emit('zalo-message',r);}catch{}}
  });
  api.on?.('message_received',async(event,ctx)=>{
   const r=await zalo.record(event,ctx);
   if(r){try{events?.emit('zalo-message',r);}catch{}}
  });
  // Quyền của trợ lý AI theo hội thoại: 'none' bỏ qua agent; khác 'write' thì chặn mọi tin AI gửi (tin người dùng gửi từ Hộp thư được báo trước qua zalo.send.allow).
  api.on?.('before_dispatch',(event,ctx)=>zalo.beforeDispatch(event,ctx));
  api.on?.('message_sending',(event,ctx)=>zalo.messageSending(event,ctx));
  return {[EMAIL_STATUS_OPERATION_ID]:createEmailStatusHandler(api),...rust,...zalo.handlers};
 }
});
