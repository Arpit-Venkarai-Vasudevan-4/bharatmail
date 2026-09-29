import {useEffect,useState} from 'react';
import {Download,FileText} from 'lucide-react';
import {apiResponse} from '../../lib/api';
import {t,formatNumber} from '../../i18n';
import {ErrorNotice,Modal} from '../../components/ui';
import type {Message} from './types';
export const PREVIEW_LIMIT=1024*1024;
export function previewAllowed(mime:string,size:number){return ['text/plain','image/png','image/jpeg','image/gif','image/webp'].includes(mime)&&size>0&&size<=PREVIEW_LIMIT}
export default function Attachment({attachment:a}:{attachment:NonNullable<Message['attachments']>[number]}){
 const previewType=a.mimeType==='application/octet-stream'&&/\.txt$/i.test(a.filename)?'text/plain':a.mimeType;
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState<{text?:string;url?:string}|null>(null);
 useEffect(()=>()=>{if(preview?.url)URL.revokeObjectURL(preview.url)},[preview]);
 const scanLabels:Record<string,Parameters<typeof t>[0]>={unscanned:'m_39496dc006dd',pending:'m_dc180dd295b6',clean:'m_9e08e5015441',rejected:'m_7a0c007e4c6b'};
 async function download(){setBusy(true);try{const {downloadAttachment}=await import('../../lib/uploads');await downloadAttachment(a.id,a.filename)}catch(e:any){setError(e.message)}finally{setBusy(false)}}
 async function show(){setBusy(true);setError('');const ctrl=new AbortController();try{if(!previewAllowed(previewType,a.sizeBytes))throw new Error(t('attachment.previewUnavailable'));const response=await apiResponse(`/uploads/${encodeURIComponent(a.id)}`,{signal:ctrl.signal,headers:{Range:`bytes=0-${PREVIEW_LIMIT}`}});const reader=response.body?.getReader();if(!reader)throw new Error(t('attachment.previewUnavailable'));const parts:Uint8Array<ArrayBuffer>[]=[];let size=0;while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>PREVIEW_LIMIT){ctrl.abort();throw new Error(t('attachment.previewUnavailable'))}parts.push(new Uint8Array(value))}const blob=new Blob(parts,{type:previewType});if(previewType==='text/plain')setPreview({text:await blob.text()});else setPreview({url:URL.createObjectURL(blob)})}catch(e:any){setError(e.message)}finally{setBusy(false)}}
 return <div className="attachment-controls"><button className="attachment" onClick={()=>void download()} disabled={busy}><span className="attachment-icon"><FileText size={20}/></span><span><strong>{a.filename}</strong><small>{t('attachment.sizeStatus',{size:formatNumber(a.sizeBytes/1024,{maximumFractionDigits:1}),status:t(scanLabels[a.scanStatus||'unscanned']||'m_617ddd6bfe90')})}</small></span><Download size={18}/></button>{previewAllowed(previewType,a.sizeBytes)&&a.scanStatus!=='rejected'&&<button className="button quiet" disabled={busy} onClick={()=>void show()}>{t('attachment.preview',{name:a.filename})}</button>}{error&&<ErrorNotice message={error}/>} {preview&&<Modal title={a.filename} onClose={()=>setPreview(null)}>{preview.url?<img className="attachment-preview" src={preview.url} alt={a.filename}/>:<pre className="safe-message-text">{preview.text}</pre>}<button className="button outline" onClick={()=>void download()}>{t('attachment.download')}</button></Modal>}</div>
}
