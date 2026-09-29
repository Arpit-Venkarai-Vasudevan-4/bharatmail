import {t} from '../../i18n';
/** Bounded reader for the exact text/plain + attachment MIME produced by our supplied client. No HTML rendering. */
export type DecodedMail = {subject:string; text:string; attachments:{name:string; type:string; bytes:Uint8Array}[]; to?:string[]; cc?:string[]};
function bytes64(value:string) {const clean=value.replace(/\s/g,'');if(!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error(t("m_09384582edb6"));return Uint8Array.from(atob(clean),c=>c.charCodeAt(0));}
function headers(part:string) {const split=part.indexOf('\r\n\r\n');if(split<0)throw new Error(t("m_23cd824f0036"));const lines=part.slice(0,split).split('\r\n');if(lines.length>40)throw new Error(t("m_29439ff5e830"));const result:Record<string,string>={};for(const line of lines){const index=line.indexOf(':');if(index>0)result[line.slice(0,index).toLowerCase()]=line.slice(index+1).trim();}return {headers:result,body:part.slice(split+4)};}
function qp(value:string) {const unfolded=value.replace(/=\r\n/g,'');const bytes:number[]=[];for(let i=0;i<unfolded.length;i++){if(unfolded[i]==='='&&/^[a-f0-9]{2}$/i.test(unfolded.slice(i+1,i+3))){bytes.push(parseInt(unfolded.slice(i+1,i+3),16));i+=2;}else{bytes.push(...new TextEncoder().encode(unfolded[i]));}}return new TextDecoder().decode(new Uint8Array(bytes));}
export function decodeMime(value:string):DecodedMail {
  if(value.length>10*1024*1024)throw new Error(t("m_432b6050881c"));
  value=value.replace(/\r?\n/g,'\r\n');
  const top=headers(value);let subject=top.headers.subject||'';subject=subject.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi,(_,part:string)=>new TextDecoder().decode(bytes64(part)));
  const result:DecodedMail={subject,text:'',attachments:[]};
  const routing=top.headers['x-phonemail-draft-routing'];
  if(routing){const encoded=routing.replace(/-/g,'+').replace(/_/g,'/');const obj=JSON.parse(new TextDecoder().decode(bytes64(encoded.padEnd(Math.ceil(encoded.length/4)*4,'='))));const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;if(!obj||Object.keys(obj).some(key=>!['to','cc'].includes(key))||!Array.isArray(obj.to)||!Array.isArray(obj.cc)||obj.to.length+obj.cc.length>49||[...obj.to,...obj.cc].some(id=>typeof id!=='string'||!uuid.test(id)))throw new Error(t("m_a7fc24f9d6f9"));result.to=obj.to;result.cc=obj.cc;}
  const boundary=/boundary="([^"]{1,100})"/.exec(top.headers['content-type']||'')?.[1];
  const parts=boundary?top.body.split(`--${boundary}`).slice(1).filter(part=>!part.startsWith('--')).map(part=>headers(part.replace(/^\r\n/,'').replace(/\r\n$/,''))):[top];
  if(parts.length>11)throw new Error(t("m_0b2a61961fab"));
  for(const part of parts){const disposition=part.headers['content-disposition']||'';if(disposition.startsWith('attachment;')){const name=(/filename="([^"]*)"/.exec(disposition)?.[1]||'attachment').replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,120);const type=(part.headers['content-type']||'application/octet-stream').split(';')[0];const bytes=bytes64(part.body);result.attachments.push({name,type,bytes});}else if((part.headers['content-type']||'').startsWith('text/plain')){result.text+=part.headers['content-transfer-encoding']==='quoted-printable'?qp(part.body):part.body;}else throw new Error(t("m_ed91b4c54826"));}
  if(result.attachments.reduce((sum,file)=>sum+file.bytes.byteLength,0)>9*1024*1024)throw new Error(t("m_e66edb664f79"));
  result.text=result.text.replace(/\r\n/g,'\n');
  return result;
}
