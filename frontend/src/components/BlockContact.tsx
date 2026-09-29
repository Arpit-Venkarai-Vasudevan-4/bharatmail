import {useState} from 'react';
import {t} from '../i18n';
import {api} from '../lib/api';
import type {Recipient} from '../lib/recipients';
import {publicLabel,contactIdentity} from '../lib/recipients';
import ContactPicker from './ContactPicker';
import {Modal,ErrorNotice} from './ui';
export default function BlockContact({address,onChanged}:{address?:string;onChanged?:()=>void}){
 const [recipient,setRecipient]=useState<Recipient|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function choose(){setError('');try{setRecipient(await contactIdentity(address!))}catch(e:any){setError(e.message)}}
 return <>{address?<button className="button quiet" onClick={()=>void choose()}>{t('block.sender')}</button>:<ContactPicker onSelect={r=>{setError('');if(r.userId)setRecipient(r);else setError(t('block.knownOnly'))}}/>}{error&&<ErrorNotice message={error}/>} {recipient&&<Modal title={t('block.title')} onClose={()=>{if(!busy)setRecipient(null)}}><p>{t('block.consequence',{address:publicLabel(recipient)})}</p><div className="button-row"><button className="button danger" disabled={busy} onClick={async()=>{setBusy(true);try{await api('/me/blocks',{method:'POST',body:{userId:recipient.userId}});setRecipient(null);onChanged?.()}catch(e:any){setError(e.message)}finally{setBusy(false)}}}>{t('block.confirm')}</button><button className="button quiet" onClick={()=>setRecipient(null)}>{t('block.cancel')}</button></div></Modal>}</>
}
