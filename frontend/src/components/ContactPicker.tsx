import {useEffect,useRef,useState} from 'react';
import {t} from '../i18n';
import {searchContacts,type Contact,type Recipient} from '../lib/recipients';
import {ErrorNotice} from './ui';
export default function ContactPicker({onSelect}:{onSelect:(recipient:Recipient)=>void}){
 const [query,setQuery]=useState(''),[page,setPage]=useState(0),[items,setItems]=useState<Contact[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const ctrl=useRef<AbortController>();
 useEffect(()=>{ctrl.current?.abort();const next=new AbortController();ctrl.current=next;const timer=setTimeout(()=>{setBusy(true);setError('');void searchContacts(query,page*30,next.signal).then(setItems).catch(e=>{if(!next.signal.aborted)setError(e.message)}).finally(()=>{if(!next.signal.aborted)setBusy(false)})},250);return()=>{next.abort();clearTimeout(timer)}},[query,page]);
 return <details className="contact-picker"><summary>{t('recipient.chooseContact')}</summary><label>{t('recipient.searchContacts')}<input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPage(0)}}/></label>{error&&<ErrorNotice message={error}/>}<div className="recipient-options">{items.map(c=><button type="button" className="button quiet" key={c.id} onClick={()=>onSelect({userId:c.userId,address:c.address,name:c.label})}>{c.label&&<strong>{c.label}</strong>} {c.address}</button>)}</div>{!busy&&!items.length&&<p>{t('recipient.noContacts')}</p>}<div className="button-row"><button type="button" disabled={busy||!page} onClick={()=>setPage(p=>p-1)}>{t('recipient.previous')}</button><span role="status">{busy?t('recipient.loading'):t('recipient.page',{page:page+1})}</span><button type="button" disabled={busy||items.length<30} onClick={()=>setPage(p=>p+1)}>{t('recipient.next')}</button></div></details>
}
