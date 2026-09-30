import test from 'node:test';
import assert from 'node:assert/strict';
import {recipientEntries,recipientCountryKey,confirmRecipientEntries,needsRecipientCountry} from '../src/lib/recipients';
test('mixed national To/Cc recipients retain their own country and canonical order',async()=>{
 const choices={[recipientCountryKey('to','9876543210')]:'IN',[recipientCountryKey('cc','4155550123')]:'US'};
 const entries=recipientEntries('9876543210, +14155550124','4155550123, person@example.test',choices),seen:unknown[]=[];
 const r=await confirmRecipientEntries(entries,async(address,country)=>{seen.push([address,country]);return {address:address==='9876543210'?'919876543210@phonemail.com':address==='4155550123'?'14155550123@phonemail.com':address}});
 assert.deepEqual(seen,[['9876543210','IN'],['+14155550124',''],['4155550123','US'],['person@example.test','']]);
 assert.deepEqual(r.to.map(r=>r.address),['919876543210@phonemail.com','+14155550124']);assert.equal(r.cc[0].address,'14155550123@phonemail.com');
 const changed=recipientEntries('9876543210','4155550123',{...choices,[recipientCountryKey('cc','4155550123')]:'IN'});assert.equal(changed[0].country,'IN');assert.equal(changed[1].country,'IN');
 assert.equal(recipientEntries('9876543211','',choices)[0].country,'');assert.equal(needsRecipientCountry('person@example.test'),false);
});
test('confirmation rejects canonical duplicates and more than 50 recipients',async()=>{
 await assert.rejects(confirmRecipientEntries(recipientEntries('a@example.test','b@example.test',{}),async()=>({address:'same@example.test'})));
 await assert.rejects(confirmRecipientEntries(recipientEntries(Array.from({length:51},(_,i)=>`${i}@example.test`).join(','),'',{})));
});
test('identical national digits can have distinct countries per occurrence; canonical duplicates still fail',async()=>{
 const choices={[recipientCountryKey('to','9876543210')]:'IN',[recipientCountryKey('to','9876543210',1)]:'US'};
 const entries=recipientEntries('9876543210, 9876543210','',choices);assert.deepEqual(entries.map(e=>e.country),['IN','US']);
 const result=await confirmRecipientEntries(entries,async(address,country)=>({address:country+'-'+address+'@example.test'}));assert.equal(result.to.length,2);
});
