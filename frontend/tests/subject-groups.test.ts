import {test} from 'node:test';
import assert from 'node:assert/strict';
import {subjectGroups} from '../src/features/mail/subjectGroups';
import type {Message} from '../src/features/mail/types';
const message=(id:string,subject:string,extra:Partial<Message>={}):Message=>({id,subject,body:'Body',conversationId:'conversation',senderEmail:'sender@example.test',createdAt:'2026-09-30T00:00:00Z',isRead:true,isFavorite:false,...extra});
test('consecutive subject sections keep replies and preserve chronology across subject changes',()=>{
 const groups=subjectGroups([message('1','Plans'),message('2','Re: Plans',{inReplyToId:'1'}),message('3','Travel'),message('4','Plans')]);
 assert.deepEqual(groups.map(g=>[g.subject,g.messages.map(m=>m.id)]),[['Plans',['1','2']],['Travel',['3']],['Plans',['4']]]);
});
test('reply prefix works with a parent outside the loaded history',()=>{
 assert.equal(subjectGroups([message('1','Plans'),message('2','Re: Re: Plans',{inReplyToId:'older'})]).length,1);
});
test('encrypted subjects stay private and independent locked roots are not merged',()=>{
 const messages=[message('1','Encrypted message',{contentFormat:'openpgp-v1'}),message('2','Encrypted message',{contentFormat:'openpgp-v1',inReplyToId:'1'}),message('3','Encrypted message',{contentFormat:'openpgp-v1'})];
 assert.deepEqual(subjectGroups(messages).map(g=>g.messages.map(m=>m.id)),[['1','2'],['3']]);
 assert.equal(subjectGroups(messages,{id:'2',subject:'Re: Private plans'})[0].subject,'Private plans');
 assert.equal(subjectGroups(messages)[0].subject,'Encrypted message');
});
