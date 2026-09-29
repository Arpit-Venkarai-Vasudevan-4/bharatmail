import english from './en.json';
export type MessageKey = keyof typeof english;
export type Values = Record<string,string|number>;
export type Catalog = Record<MessageKey,string>;
const preview=import.meta.env?.VITE_TRANSLATION_PREVIEW==='true';
const approvedLoaders:Record<string,()=>Promise<{default:Catalog}>>={en:async()=>({default:english}),...(preview?{ta:async()=>({default:{...english,...(await import('./ta.draft.json')).default}})}:{})};
export const interfaceLanguages=[{code:'en',name:'English',dir:'ltr' as const},...(preview?[{code:'ta',name:'தமிழ் (வரைவு)',dir:'ltr' as const}]:[])];
let language='en',catalog:Catalog=english;
const loadedCatalogs:Catalog[]=[english];
const listeners=new Set<()=>void>();
export const subscribeLocale=(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)};
export const getLocale=()=>language;
export function validateCatalog(value:unknown):asserts value is Catalog {
  if(!value||typeof value!=='object')throw new Error('Invalid translation catalog');
  const candidate=value as Record<string,unknown>;
  for(const [key,source] of Object.entries(english)){
    if(typeof candidate[key]!=='string')throw new Error('Incomplete translation catalog: '+key);
    const tokens=(s:string)=>[...s.matchAll(/\{([\w]+)\}/g)].map(m=>m[1]).sort().join('|');
    if(tokens(source)!==tokens(candidate[key] as string))throw new Error('Translation parameters differ: '+key);
  }
}
let loadSequence=0;
export async function loadLocale(code:string){const sequence=++loadSequence;
  const loader=approvedLoaders[code];if(!loader){if(code!=='en')await loadLocale('en');return false;}
  const loaded=await loader();validateCatalog(loaded.default);if(sequence!==loadSequence)return false;catalog=loaded.default;if(!loadedCatalogs.includes(catalog))loadedCatalogs.push(catalog);language=code;
  if(typeof document!=='undefined'){document.title=t(import.meta.env?.VITE_PORTAL==='true'||document.body.dataset.portal==='true'?'portal.title':'app.title');const description=document.querySelector('meta[name=description]');description?.setAttribute('content',t('app.description'));document.documentElement.lang=code;document.documentElement.dir=interfaceLanguages.find(l=>l.code===code)?.dir||'ltr'}
  listeners.forEach(fn=>fn());return true;
}
export function t(key:MessageKey,values:Values={}):string {return (catalog[key]??english[key]).replace(/\{([\w]+)\}/g,(match,key)=>String(values[key]??match))}
export function formatDateTime(value:string|number|Date,options:Intl.DateTimeFormatOptions={dateStyle:'medium',timeStyle:'short'}){const date=new Date(value);return Number.isFinite(+date)?new Intl.DateTimeFormat(language,options).format(date):''}
export function formatNumber(value:number,options:Intl.NumberFormatOptions={}){return new Intl.NumberFormat(language,options).format(value)}
export function pluralKey(count:number,one:MessageKey,other:MessageKey){return t(new Intl.PluralRules(language).select(count)==='one'?one:other,{count:formatNumber(count)})}

export async function selectLocale(code:string){if(!await loadLocale(code))throw new Error('Locale unavailable');if(typeof localStorage!=='undefined')localStorage.setItem('phonemail.locale',code)}
export async function restoreLocale(){try{const saved=localStorage.getItem('phonemail.locale');if(saved)await loadLocale(saved)}catch{/* English remains available if storage or the optional catalog fails. */}}
// Translate already-issued application status/error prose when a mounted view switches locale.
// Call only for system messages, never for mail bodies, addresses or other user content.
export function localizeSystemMessage(message:string,depth=0):string {
  if(depth>2)return message;
  for(const sourceCatalog of loadedCatalogs)for(const [key,source] of Object.entries(sourceCatalog)){
    if(source===message)return t(key as MessageKey);
    if(!source.includes('{'))continue;
    const keys:string[]=[];
    const parts=source.split(/(\{\w+\})/g).map(part=>{if(/^\{\w+\}$/.test(part)){keys.push(part.slice(1,-1));return '([\\s\\S]+?)'}return part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')});
    const match=new RegExp('^'+parts.join('')+'$').exec(message);
    if(match)return t(key as MessageKey,Object.fromEntries(keys.map((name,i)=>[name,localizeSystemMessage(match[i+1],depth+1)])));
  }
  return message;
}
