import type {Message} from './types';

// Consecutive sections preserve chronology; a later return to a subject starts
// another section rather than moving messages out of their original order.
export function subjectGroups(messages:Message[], decrypted?:{id:string;subject:string}|null){
 const identities=new Map<string,{key:string;subject:string}>();
 const groups:{id:string;subject:string;messages:Message[]}[]=[];
 const title=(value:string)=>value.replace(/^(?:\s*re\s*:\s*)+/i,'').trim();
 for(const message of messages){
  const parent=message.inReplyToId?identities.get(message.inReplyToId):undefined;
  const encrypted=message.contentFormat==='openpgp-v1';
  // Locked encrypted subjects are unknown, not evidence of matching subjects.
  const identity=parent||{key:encrypted?'encrypted:'+(message.inReplyToId||message.id):'plain:'+title(message.subject),subject:encrypted?message.subject:title(message.subject)};
  identities.set(message.id,identity);
  let group=groups.at(-1);
  const previous=group&&identities.get(group.messages[0].id);
  if(!group||previous?.key!==identity.key){group={id:message.id,subject:identity.subject,messages:[]};groups.push(group)}
  group.messages.push(message);
  if(encrypted&&decrypted?.id===message.id)group.subject=title(decrypted.subject);
 }
 return groups;
}
