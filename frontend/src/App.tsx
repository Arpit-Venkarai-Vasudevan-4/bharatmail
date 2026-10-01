import {localizeSystemMessage,t,formatDateTime,formatNumber,getLocale,subscribeLocale,loadLocale} from './i18n';
import {lazy,Suspense,useCallback,useEffect,useState,useSyncExternalStore} from 'react';
import {Bell,Home,Inbox,Send,FileText,Star,Archive,ShieldAlert,Trash2,Users,Settings as SettingsIcon,Plus,Menu,WifiOff,Leaf,LogOut,ShieldCheck,ArrowRight,RefreshCw} from 'lucide-react';
import {api,bindAccount,getSessionState,setSessionState,subscribeSession,getReachability,subscribeReachability} from './lib/api';
import {Brand,ErrorNotice,Loading,Modal,newId} from './components/ui';
import {accountStore,rememberOfflineAccount,readOfflineAccount,forgetOfflineAccount} from './lib/storage';
import {ProfileAvatar} from './components/ProfileAvatar';
import Workspace from './features/mail/Workspace';
import {useAppearance} from './features/appearance/useAppearance';
const AppearancePanel=lazy(()=>import('./features/appearance/AppearancePanel'));
import type {User,ComposeSeed} from './features/mail/types';
const AuthScreen=lazy(()=>import('./features/auth/AuthScreen'));
const Settings=lazy(()=>import('./features/settings/Settings'));
const Outbox=lazy(()=>import('./features/mail/Outbox'));
const Contacts=lazy(()=>import('./features/contacts/Contacts'));
const SecurityPanel=lazy(()=>import('./features/security/SecurityPanel'));
const Introduction=lazy(()=>import('./Introduction'));
const folders=[['home',"m_3a78695388b3",Home],['inbox',"m_94835ea2fcf7",Inbox],['sent',"m_c16bc82bf1f0",Send],['drafts',"m_f592e6a4db3c",FileText],['favorites',"m_7a1f2a83aca9",Star],['archive',"m_66f4804ee23d",Archive],['spam',"m_94a9eac404c8",ShieldAlert],['trash',"m_c560122ac470",Trash2]] as const;
export default function App(){
 useSyncExternalStore(subscribeLocale,getLocale,getLocale);
 const reachability=useSyncExternalStore(subscribeReachability,getReachability,getReachability);
 const appearance=useAppearance();
 const [guidance,setGuidance]=useState(true);

 const [user,setUser]=useState<User|null>(null),[boot,setBoot]=useState(true),[bootError,setBootError]=useState(''),[folder,setFolder]=useState('home'),[panel,setPanel]=useState(''),[menu,setMenu]=useState(false),[online,setOnline]=useState(navigator.onLine),[lite,setLite]=useState(()=>{try{return localStorage.getItem('phonemail-lite')==='true'}catch{return false}}),[seed,setSeed]=useState<ComposeSeed|null>(null),[revision,setRevision]=useState(0),[notice,setNotice]=useState(''),[noticeKind,setNoticeKind]=useState<'status'|'error'>('error'),[reauth,setReauth]=useState(false),[intro,setIntro]=useState(location.pathname==='/welcome');
 useEffect(()=>{if(!user)return;try{setGuidance(localStorage.getItem('phonemail-guidance:'+user.id)!=='seen')}catch{setGuidance(true)}},[user?.id]);
 useEffect(()=>{if(user?.language){try{if(!localStorage.getItem('phonemail.locale'))void loadLocale(user.language)}catch{/* English remains available. */}}},[user?.id]);
 const restore=useCallback(async()=>{
  setBoot(true);setBootError('');setSessionState('unknown');
  const cached=readOfflineAccount();
  if(cached){bindAccount(cached.id);setUser(cached as User);setNotice(t("m_e8e8d5fa8130"));setBoot(false)}
  try {
    if(!navigator.onLine&&cached){setSessionState('checking',false);return}
    const pending=api<{user:User}>('/auth/me');
    if(cached)setSessionState('checking',false);
    const result=await pending;
    if(cached&&result.user.id!==cached.id){setSessionState('invalid');setReauth(true);return}
    bindAccount(result.user.id);setUser(result.user);setSessionState('authenticated');setNotice('');setRevision(v=>v+1);
  } catch(e:any) {
    if(e.status===401){if(cached){setSessionState('invalid');setReauth(true)}}
    else{setBootError(t("m_039eb7962876"));if(cached)setSessionState('checking',false)}
  } finally {setBoot(false)}
 },[]);
 useEffect(()=>{void restore();return subscribeSession((state:any)=>{if(state==='invalid')setReauth(true)})},[restore]);
 useEffect(()=>{const on=()=>setOnline(navigator.onLine);window.addEventListener('online',on);window.addEventListener('offline',on);return()=>{window.removeEventListener('online',on);window.removeEventListener('offline',on)}},[]);
 useEffect(()=>{if(!user)return;const remember=()=>rememberOfflineAccount(user);remember();window.addEventListener('phonemail:offline-policy',remember);return()=>window.removeEventListener('phonemail:offline-policy',remember)},[user]);
 useEffect(()=>{if(!user)return;const verify=async()=>{setSessionState('checking',false);try{const result=await api<{user:User}>('/auth/me',{auth:false,refresh:false});if(result.user.id!==user.id){setReauth(true);return}bindAccount(user.id);setUser(result.user);setSessionState('authenticated');setReauth(false);setNotice('');setRevision(v=>v+1)}catch(e:any){if(e.status===401){setSessionState('invalid');setReauth(true)}else{setSessionState('checking',false);setNotice(t("m_c0ac1aed91b7"))}}};window.addEventListener('online',verify);window.addEventListener('phonemail:recheck-session',verify);return()=>{window.removeEventListener('online',verify);window.removeEventListener('phonemail:recheck-session',verify)}},[user?.id]);
 useEffect(()=>{document.documentElement.dataset.lite=String(lite);try{localStorage.setItem('phonemail-lite',String(lite))}catch{/* preference is optional */}},[lite]);
 const compose=useCallback((to?:string)=>{setSeed(current=>current||{key:newId(),to:to?[to]:[]});setPanel('');setMenu(false)},[]);
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')return;if(e.key==='c' && !(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement||e.ctrlKey||e.metaKey)){e.preventDefault();compose()}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler)},[compose]);
 async function logout(){try{await api('/auth/logout',{method:'POST',auth:false,refresh:false});const {lockKeys}=await import('./features/security/service');lockKeys();accountStore(user!.id).clearMemory();forgetOfflineAccount();bindAccount(undefined);setSessionState('invalid');setUser(null);setSeed(null);setPanel('');setReauth(false);setNotice('')}catch{setNotice(t("m_cb8d5e44d8c2"))}}
 if(intro)return <Suspense fallback={<Loading/>}><Introduction onContinue={()=>{setIntro(false);history.replaceState({},'','/')}}/></Suspense>;
 if(boot)return <div className="boot"><Brand/><Loading label={t("m_7cd769e7bf5e")}/></div>;
 if(!user)return <Suspense fallback={<Loading/>}>{bootError&&<div className="connection-banner"><WifiOff size={16}/>{bootError}<button onClick={restore}>{t("m_eccee4ef9458")}</button></div>}<AuthScreen onAuthenticated={(u:any)=>{bindAccount(u.id);setUser(u);setSessionState('authenticated');setReauth(false)}}/></Suspense>;
 return <div className="app-shell">
 <a className="skip-link" href="#workspace">{t("m_e5a3ef7c25bc")}</a>
 <aside className={`sidebar ${menu?'open':''}`} aria-label={t("m_eb355944b92d")}><Brand/><button className="compose-button" onClick={()=>compose()}><Plus size={21}/> {t("m_8196cc7f970a")}<span>{t("m_6b23c0d5f35d")}</span></button><div className="nav-caption">{t("m_95049f1227f6")}</div><nav>{folders.map(([id,label,Icon])=><button key={id} className={`nav-item ${folder===id?'active':''} ${id==='inbox'||id==='sent'?'desktop-folder':''}`} onClick={()=>{setFolder(id);setMenu(false);setPanel('')}}><Icon size={19}/><span>{t(label)}</span>{folder===id&&<span className="nav-dot"/>}</button>)}</nav><div className="sidebar-divider"/><button className="nav-item" onClick={()=>{setPanel('outbox');setMenu(false)}}><Send size={19}/>{t("m_514e5dc98b7b")}</button><button className={`nav-item ${panel==='contacts'?'active':''}`} onClick={()=>{setPanel('contacts');setMenu(false)}}><Users size={19}/>{t("m_b450645debe2")}</button><button className={`nav-item ${panel==='security'?'active':''}`} onClick={()=>{setPanel('security');setMenu(false)}}><ShieldCheck size={19}/>{t("m_5d8d03a2e6bb")}</button><div className="sidebar-bottom"><div className="little-note"><span className="note-flower">✳</span><p>{t("m_45ba14159fcd")}<br/><strong>{t("m_de41cbfd5405")}</strong></p></div><button className="nav-item" onClick={()=>{setPanel('appearance');setMenu(false)}}><SettingsIcon size={17}/>{t('appearance.title')}</button><button className="nav-item motion-control" onClick={()=>setLite(!lite)} aria-pressed={lite}><Leaf size={17}/>{t("m_2a1e1f360c49")}<span className={`toggle ${lite?'on':''}`}/></button><button className="profile-button" onClick={()=>{setPanel('settings');setMenu(false)}}><ProfileAvatar user={user}/><span><strong>{user.displayName||t("m_dbb5f6371b6a")}</strong><small>{t("m_4aaf6a9dc80d")}</small></span><SettingsIcon size={17}/></button></div></aside>
 {menu&&<button className="nav-backdrop" aria-label={t("m_99904db30de4")} onClick={()=>setMenu(false)}/>}
 <div className="main-shell"><header className="topbar"><div className="topbar-start"><button className="icon-button mobile-menu" onClick={()=>setMenu(!menu)} aria-label={t("m_0ed77fd2619b")}><Menu size={21}/></button><span className="topbar-greeting">{t("m_a2a2fc5ae8df")}</span><span className="mobile-brand">{t("m_ed572eb0dd7f")}<span>•</span></span></div><div className="topbar-actions"><span className={`connection-pill ${online?'':'offline'}`}><i/>{!online?t('m_a1794783aab7'):reachability==='reachable'?t('connection.reachable'):reachability==='unreachable'?t('connection.unreachable'):t('connection.unknown')}</span><button className="icon-button" aria-label={t("m_e9c07e134741")} onClick={()=>setRevision(v=>v+1)}><RefreshCw size={17}/></button><button className="icon-button" aria-label={t('notice.open')} onClick={()=>setPanel('settings')}><Bell size={18}/></button><button className="icon-button" aria-label={t("m_a587aa1f4ffc")} onClick={()=>setPanel('settings')}><SettingsIcon size={19}/></button><button className="icon-button" aria-label={t("m_48f0d3d397d4")} onClick={logout}><LogOut size={18}/></button></div></header>
 {!online&&<div className="connection-banner"><WifiOff size={16}/>{t("m_be1d0b8efb2c")}</div>}
 {getSessionState()==='invalid'&&!reauth&&<div className="connection-banner">{t("m_2bf46e72ff32")}<button onClick={()=>setReauth(true)}>{t("m_bfd402b2f6f3")}</button></div>}{notice&&(noticeKind==='status'?<p className="notice" role="status">{localizeSystemMessage(notice)}</p>:<ErrorNotice message={localizeSystemMessage(notice)} retry={getSessionState()==='checking'?()=>window.dispatchEvent(new Event('phonemail:recheck-session')):undefined}/>) }{guidance&&<aside className="first-use" aria-label={t('guidance.title')}><strong>{t('guidance.address',{address:user.primaryEmail||user.email||''})}</strong><p>{t('guidance.help')}</p><button className="button quiet" onClick={()=>{setGuidance(false);try{localStorage.setItem('phonemail-guidance:'+user.id,'seen')}catch{/* dismissal is optional */}}}>{t('guidance.dismiss')}</button></aside>}<main id="workspace" className="workspace-main"><Workspace key={user.id} user={user} folder={folder} refresh={revision} composeSeed={seed} onCompose={setSeed} onNotice={(value,kind)=>{setNoticeKind(kind||'error');setNotice(value)}}/></main><footer className="shell-footer"><span>{t("m_64db0a046592")}</span><button onClick={()=>setPanel('security')}><ShieldCheck size={13}/> {t("m_d9c842765a2d")}<ArrowRight size={13}/></button></footer></div>
 <button className="mobile-compose" onClick={()=>compose()}><Plus size={21}/>{t("m_98652afe6ee7")}</button>
 <Suspense fallback={<div className="overlay-loading"><Loading/></div>}>
 {panel==='appearance'&&<AppearancePanel {...appearance} onClose={()=>setPanel('')}/>}
 {panel==='outbox'&&<Outbox userId={user.id} onClose={()=>setPanel('')} onChanged={()=>setRevision(v=>v+1)}/>}
 {panel==='settings'&&<Settings onSignOut={()=>void logout()} user={user} onUserChange={(u:any)=>setUser(u)} onClose={()=>setPanel('')}/>}
 {panel==='contacts'&&<Modal title={t("m_b450645debe2")} onClose={()=>setPanel('')} wide><Contacts onCompose={compose}/></Modal>}
 {panel==='security'&&<SecurityPanel user={user} onClose={()=>setPanel('')}/>}
 {reauth&&user&&<Modal title={t("m_7a66599789db")} onClose={()=>setReauth(false)} wide><p>{t("m_2db7f0c01676")}</p><AuthScreen onAuthenticated={(u:any)=>{if(u.id!==user.id){setSeed(null);setPanel('');setFolder('home')}bindAccount(u.id);setUser(u);setSessionState('authenticated');setReauth(false);setRevision(v=>v+1)}}/></Modal>}
 </Suspense></div>
}
