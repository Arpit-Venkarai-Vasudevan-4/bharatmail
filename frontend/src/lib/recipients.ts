import {api} from './api';
import {t} from '../i18n';
import {phoneInputValid} from '../features/auth/contracts';
/** Internal routing identity is never a public label or an editable address. */
export type Recipient = {userId?:string;address?:string;name?:string};
export type Contact = {id:string;userId?:string;address:string;label?:string};
export const internalId = (value:string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function publicLabel(value:Recipient){return value.address&&!internalId(value.address)?value.address:t('recipient.unknown')}
export function validRecipient(value:string,country:string){return !internalId(value)&&value.length<=320&&(value.includes('@')?/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value):phoneInputValid(value,country))}
export async function searchContacts(query:string,offset=0,signal?:AbortSignal){return (await api<{contacts:Contact[]}>(`/me/contacts?limit=30&offset=${offset}&q=${encodeURIComponent(query)}`,{signal})).contacts}
export async function resolveRecipient(value:string,country:string):Promise<Recipient>{
 if(!validRecipient(value,country))throw new Error(t('recipient.invalid'));
 const result=await api<{available:boolean;address:string;displayName?:string}>('/me/recipient-confirmation',{method:'POST',body:{address:value,...(country?{country}:{})}});
 if(!result.available)throw new Error(t('recipient.unavailable'));
 // Confirmation intentionally does not disclose an account ID. Only the user's
 // own contacts may supply routing identity for encryption/blocking.
 return {address:result.address,name:result.displayName};
}
export async function contactIdentity(address:string):Promise<Recipient>{
 const contacts=await searchContacts(address);
 const match=contacts.find(c=>c.address.toLowerCase()===address.toLowerCase()&&c.userId);
 if(!match)throw new Error(t('recipient.saveContact'));
 return {userId:match.userId,address:match.address,name:match.label};
}

export type RecipientCountries = Record<string,string>;
export const splitRecipients=(text:string)=>text.split(/[,;\n]/).map(value=>value.trim()).filter(Boolean);
export const recipientCountryKey=(role:'to'|'cc',address:string,occurrence=0)=>`${role}:${address}${occurrence?'#'+occurrence:''}`;
export const needsRecipientCountry=(address:string)=>!address.includes('@')&&!/^(\+|00)/.test(address);
export function recipientEntries(to:string,cc:string,countries:RecipientCountries){
 return (['to','cc'] as const).flatMap(role=>{const seen=new Map<string,number>();return splitRecipients(role==='to'?to:cc).map(address=>{const occurrence=seen.get(address)||0;seen.set(address,occurrence+1);const key=recipientCountryKey(role,address,occurrence);return {role,address,occurrence,key,country:needsRecipientCountry(address)?countries[key]||'':''}})});
}
export async function confirmRecipientEntries(entries:ReturnType<typeof recipientEntries>,resolve=resolveRecipient){
 if(entries.length>50||new Set(entries.map(e=>`${e.address.toLowerCase()}|${e.country}`)).size!==entries.length)throw new Error(t('recipient.duplicates'));
 const results=await Promise.all(entries.map(e=>resolve(e.address,e.country)));
 if(new Set(results.map(r=>r.address?.toLowerCase())).size!==results.length)throw new Error(t('recipient.duplicates'));
 return {to:results.filter((_,i)=>entries[i].role==='to'),cc:results.filter((_,i)=>entries[i].role==='cc')};
}
