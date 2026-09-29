import {useState,useSyncExternalStore} from 'react';
import {api,getSessionState} from '../lib/api';
import {interfaceLanguages,getLocale,subscribeLocale,selectLocale,t,localizeSystemMessage} from './index';
export default function LanguageSelector({signedIn=false,onChange}:{signedIn?:boolean;onChange?:(code:string)=>void}){
 const language=useSyncExternalStore(subscribeLocale,getLocale,getLocale);const [error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <div className="language-selector"><label>{t('locale.label')}<select aria-label={t('locale.label')} value={language} disabled={busy} onChange={async e=>{const code=e.target.value;setBusy(true);setError('');try{await selectLocale(code);onChange?.(code);if(signedIn||getSessionState()==='authenticated')await api('/me',{method:'PATCH',body:{language:code}})}catch{setError(t(signedIn?'locale.unsynced':'locale.failed'))}finally{setBusy(false)}}}>{interfaceLanguages.map(l=><option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}</select></label><small>{t(language==='ta'?'locale.draft':'locale.launchEnglish')}</small>{error&&<p role="alert">{localizeSystemMessage(error)}</p>}</div>
}
