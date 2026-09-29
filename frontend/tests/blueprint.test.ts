import test from 'node:test';
import assert from 'node:assert/strict';
import {validRecipient,publicLabel} from '../src/lib/recipients';
import {phoneInputValid,countries} from '../src/features/auth/contracts';
import {previewAllowed} from '../src/features/mail/Attachment';
import {validateCatalog} from '../src/i18n';
import english from '../src/i18n/en.json';
import tamil from '../src/i18n/ta.draft.json';
test('Recipient input separates public labels from routing UUIDs and requires country context',()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';assert.equal(validRecipient(id,''),false);assert.equal(publicLabel({userId:id}), 'Saved encrypted recipient');assert.equal(publicLabel({address:id}), 'Saved encrypted recipient');assert.equal(phoneInputValid('hello','IN'),false);assert.equal(phoneInputValid('123','US'),false);assert.equal(phoneInputValid('4155550100',''),false);assert.equal(phoneInputValid('+14155550100',''),true);assert.equal(validRecipient('person@phonemail.com',''),true);assert.equal(validRecipient('a@b',''),false);assert.equal(typeof countries,'function');
});
test('Preview admits bounded inert formats and rejects HTML SVG PDF and excessive content',()=>{for(const type of ['text/html','image/svg+xml','application/pdf','application/javascript'])assert.equal(previewAllowed(type,100),false);assert.equal(previewAllowed('image/png',1024),true);assert.equal(previewAllowed('text/plain',1024*1024+1),false)});
test('Optional Tamil draft overlay preserves English fallback and interpolation tokens',()=>validateCatalog({...english,...tamil}));
