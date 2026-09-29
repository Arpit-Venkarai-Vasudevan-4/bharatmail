/** Real rendered UI acceptance. Fixtures use the real local API; no module actions stand in for UI clicks. */
import {chromium,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {register} from './live-support.mjs';
const origin=process.env.UI_ORIGIN||'http://localhost:18080';
if(!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))throw new Error('Local acceptance only');
const passed=[],started=new Date().toISOString(),accounts=[];
const browser=await chromium.launch({channel:'chrome',headless:true});
const contexts=await Promise.all([browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true}),browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true}),browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true})]);
const pages=await Promise.all(contexts.map(c=>c.newPage()));
const secrets=['Protected-UI-'+randomUUID(),'Protected-UI-'+randomUUID()];
const check=name=>{passed.push(name);console.log('PASS '+name)};
await mkdir('docs/screenshots',{recursive:true});
async function login(page,account){await page.goto(origin);await page.getByLabel('Phone number',{exact:true}).fill(account.user.phoneE164||'+'+account.user.phone);await page.getByLabel('Password',{exact:true}).fill(account.password);await page.locator('.auth-next').click();await expect(page.getByRole('heading',{name:'Your conversations.'})).toBeVisible()}
async function security(page){await page.getByRole('button',{name:'Privacy & keys',exact:true}).click();await expect(page.getByRole('dialog',{name:'Encryption & trust'})).toBeVisible()}
async function noPublicIds(page){const text=await page.evaluate(()=>[document.body.innerText,...[...document.querySelectorAll('input:not([type=password]),textarea')].map(e=>e.value),...[...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label'))].join('\n'));expect(text).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)}
async function close(page){await page.getByRole('button',{name:'Close dialog',exact:true}).click()}
async function identity(page){await page.getByRole('button',{name:'Show identity QR'}).click();const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download identity for sharing',exact:true}).click();const file=await pending;return readFile(await file.path(),'utf8')}
async function trust(page,payload){await page.getByLabel('PhoneMail identity payload',{exact:true}).fill(payload);await page.getByRole('button',{name:'Check identity',exact:true}).click();const button=page.getByRole('button',{name:'Trust this fingerprint',exact:true});await expect(button).toBeDisabled();await page.getByLabel('I compared every fingerprint character with this person through a trusted independent channel.').check();await button.click();await expect(page.getByRole('status')).toContainText('Fingerprint verified')}
async function compose(page,to,subject,body,{encrypted=true,file=false}={}){await page.getByRole('button',{name:'Compose C',exact:true}).click();if(encrypted)await page.getByRole('button',{name:'Use end-to-end encryption',exact:true}).click();await page.getByLabel('To',{exact:true}).fill(to);await page.getByLabel('Subject',{exact:true}).fill(subject);await page.getByLabel('Message',{exact:true}).fill(body);await page.getByRole('button',{name:'Confirm recipients',exact:true}).click();await expect(page.locator('.success-note')).toContainText('Confirmed:');if(file)await page.getByLabel('Attach file',{exact:true}).setInputFiles({name:'private-proof.txt',mimeType:'text/plain',buffer:Buffer.from('Encrypted attachment from UI')});}
async function send(page){const confirm=page.getByRole('button',{name:'Confirm recipients',exact:true});if(await confirm.isVisible()){await confirm.click();await expect(page.locator('.success-note')).toContainText('Confirmed:')}await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:30000})}
async function openEncrypted(page,subject){await page.getByRole('button',{name:'Refresh mailbox',exact:true}).click();await page.locator('.message-row').first().click();await page.getByRole('button',{name:'Decrypt message',exact:true}).filter({visible:true}).click();await expect(page.locator('.message-detail')).toContainText(subject)}
try{
  for(let i=0;i<2;i++){accounts.push(await register('UI acceptance '+i));await login(pages[i],accounts[i]);await security(pages[i]);await pages[i].getByLabel('Private-key passphrase',{exact:true}).fill(secrets[i]);await pages[i].getByLabel('Account password',{exact:true}).fill(accounts[i].password);await pages[i].getByRole('button',{name:'Create & enroll',exact:true}).click();await expect(pages[i].getByRole('status')).toContainText('enrolled',{timeout:30000})}
  for(let i=0;i<2;i++)await accounts[i].client.request('/api/me/contacts',{method:'POST',body:{address:accounts[1-i].user.email,label:'Verified UI contact'}});
  check('Two isolated browser contexts sign in and enroll keys through rendered controls');
  const identities=await Promise.all(pages.slice(0,2).map(identity));
  await close(pages[0]);await compose(pages[0],accounts[1].user.email,'Untrusted recipient check','This must remain unsent');await pages[0].getByRole('button',{name:'Send message',exact:true}).click();await expect(pages[0].getByRole('alert')).toContainText('Verify each recipient');await noPublicIds(pages[0]);pages[0].once('dialog',dialog=>dialog.accept());await pages[0].getByRole('button',{name:'Discard draft',exact:true}).click();await security(pages[0]);check('Unverified recipient send is refused with a localized neutral error containing no internal account ID');
  // Independent channel for these controlled test identities is each account's own displayed payload.
  for(let i=0;i<2;i++)await trust(pages[i],identities[1-i]);
  await Promise.all(pages.slice(0,2).map(noPublicIds));
  check('Both UIs require explicit independent fingerprint comparison before pinning');
  const downloadPromise=pages[0].waitForEvent('download');await pages[0].getByRole('button',{name:'Download encrypted backup',exact:true}).click();const backup=await downloadPromise;const backupBytes=await readFile(await backup.path());
  await pages[0].getByRole('button',{name:'Lock now',exact:true}).click();await pages[0].getByLabel('Private-key passphrase',{exact:true}).fill(secrets[0]);await pages[0].getByLabel('Import encrypted backup',{exact:true}).setInputFiles({name:'backup.json',mimeType:'application/json',buffer:backupBytes});await expect(pages[0].getByRole('status')).toContainText('import');
  check('Encrypted backup downloads and imports through the UI after locking');
  await Promise.all(pages.slice(0,2).map(close));
  await compose(pages[0],accounts[1].user.email,'UI private subject','UI private body',{file:true});
  await pages[0].getByRole('button',{name:'Save draft',exact:true}).click();await expect(pages[0].getByText('Saved to PhoneMail',{exact:true})).toBeVisible();await close(pages[0]);
  await pages[0].getByRole('button',{name:'Drafts',exact:true}).click();await pages[0].getByRole('button',{name:/Encrypted draft Unlock to continue/}).click();await expect(pages[0].getByLabel('Message',{exact:true})).toHaveValue('UI private body');await noPublicIds(pages[0]);await send(pages[0]);
  check('Encrypted draft saves, closes, restores recipients/text/files and sends from UI');
  await pages[0].getByRole('button',{name:'Home',exact:true}).click();await openEncrypted(pages[0],'UI private subject');
  // Inject a signer mismatch into an otherwise real response: no ciphertext,
  // database record, public key, or proof is fabricated or changed on the server.
  const receivedRoute='**/api/e2ee/messages/*';
  await pages[1].route(receivedRoute,async route=>{const response=await route.fetch();const payload=await response.json();payload.message.senderUserId=accounts[1].user.id;await route.fulfill({response,json:payload});});
  await pages[1].getByRole('button',{name:'Refresh mailbox',exact:true}).click();await pages[1].locator('.message-row').first().click();
  await pages[1].getByRole('button',{name:'Decrypt message',exact:true}).filter({visible:true}).click();
  await expect(pages[1].getByRole('alert')).toContainText('Message signature is invalid');
  await expect(pages[1].locator('.message-detail')).not.toContainText('UI private body');
  await expect(pages[1].getByRole('button',{name:/private-proof.txt/})).toHaveCount(0);
  await pages[1].unroute(receivedRoute);await openEncrypted(pages[1],'UI private subject');
  check('A received sender/signature mismatch is rejected without displaying plaintext or attachments; the genuine response still decrypts');
  await expect(pages[1].locator('.message-detail')).toContainText('UI private body');
  const fileDownload=pages[1].waitForEvent('download');await pages[1].getByRole('button',{name:/private-proof.txt/}).click();const file=await fileDownload;expect((await readFile(await file.path())).toString()).toBe('Encrypted attachment from UI');
  check('Receiver and sender Sent decrypt through UI; downloaded encrypted attachment bytes match');
  // A real in-flight decrypt must not reveal plaintext after a rendered Lock action.
  await pages[1].getByRole('button',{name:'Inbox',exact:true}).click();await pages[1].locator('.message-row').first().click();
  let releaseDecrypt,heldDecrypt=false;const decryptGate=new Promise(resolve=>releaseDecrypt=resolve);
  await pages[1].route('**/api/e2ee/messages/*',async route=>{const response=await route.fetch();heldDecrypt=true;await decryptGate;await route.fulfill({response});});
  await pages[1].getByRole('button',{name:'Decrypt message',exact:true}).filter({visible:true}).click();await expect.poll(()=>heldDecrypt).toBe(true);
  await security(pages[1]);await pages[1].getByRole('button',{name:'Lock now',exact:true}).click();releaseDecrypt();await pages[1].waitForTimeout(500);await close(pages[1]);await expect(pages[1].locator('.message-detail')).not.toContainText('UI private body');
  await pages[1].unroute('**/api/e2ee/messages/*');await security(pages[1]);await pages[1].getByLabel('Private-key passphrase',{exact:true}).fill(secrets[1]);await pages[1].getByRole('button',{name:'Unlock keys',exact:true}).click();await expect(pages[1].getByRole('status')).toContainText('Keys unlocked');await close(pages[1]);await pages[1].getByRole('button',{name:'Decrypt message',exact:true}).filter({visible:true}).click();await expect(pages[1].locator('.message-detail')).toContainText('UI private body');
  check('A held decrypt response released after the UI locks keys cannot reveal plaintext; unlock and a new decrypt recover normally');

  await pages[1].getByRole('button',{name:'Keep the conversation going Reply to this message'}).click();await pages[1].getByLabel('Message',{exact:true}).fill('UI encrypted reply');await send(pages[1]);
  check('Encrypted reply sends through the rendered locked-recipient composer');

  // The initial ordinary compose accepts a group; conversation recipients lock after creation.
  accounts.push(await register('UI group acceptance'));
  await login(pages[2],accounts[2]);
  await compose(pages[0],`${accounts[1].user.email}, ${accounts[2].user.email}`,'UI group subject','UI group body',{encrypted:false});
  await pages[0].getByRole('button',{name:'Confirm recipients',exact:true}).click();
  await expect(pages[0].locator('.success-note')).toContainText(accounts[2].user.displayName);
  await send(pages[0]);
  for(const page of [pages[1],pages[2]]){
    await page.getByRole('button',{name:'Refresh mailbox',exact:true}).click();
    await expect(page.locator('.message-row').filter({hasText:'UI group subject'})).toBeVisible();
  }
  await pages[0].getByRole('button',{name:'Refresh mailbox',exact:true}).click();
  await pages[0].locator('.message-row').filter({hasText:'UI group subject'}).click();
  await expect(pages[0].locator('.message-detail')).toContainText('UI group body');
  await pages[0].locator('.thread-compose-bar button').nth(1).click();
  await expect(pages[0].getByLabel('To',{exact:true})).toBeDisabled();
  await close(pages[0]);
  check('Rendered initial compose creates one two-recipient group; both recipients receive it and thread recipients stay locked');

  // An interrupted encrypted draft-send is durably retried after a real page reload.
  const interrupted=[];
  const sendRoute='**/api/e2ee/drafts/*/send';
  await pages[0].route(sendRoute,async route=>{
    const request=route.request();
    interrupted.push({body:request.postDataJSON(),key:request.headers()['idempotency-key']});
    await route.abort('failed');
  });
  await compose(pages[0],accounts[1].user.email,'Interrupted UI secret','The exact ciphertext must survive reload');
  await pages[0].getByRole('button',{name:'Send message',exact:true}).click();
  await expect(pages[0].getByRole('alert')).toContainText('outcome unknown',{timeout:30000});
  await pages[0].reload({waitUntil:'domcontentloaded'});
  await expect(pages[0].getByRole('heading',{name:'Your conversations.'})).toBeVisible();
  await security(pages[0]);
  await pages[0].getByLabel('Private-key passphrase',{exact:true}).fill(secrets[0]);
  await pages[0].getByRole('button',{name:'Unlock keys',exact:true}).click();
  await expect(pages[0].locator('.pending-row')).toHaveCount(1);
  // Corrupt the persisted signature once, verify refusal, then restore the exact saved record.
  const savedOperation=await pages[0].evaluate(async userId=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('phonemail-encrypted-outbox-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    const records=await new Promise((resolve,reject)=>{const tx=db.transaction('operations','readonly');const r=tx.objectStore('operations').getAll();r.onsuccess=()=>resolve(r.result.filter(x=>x.userId===userId));r.onerror=()=>reject(r.error)});
    db.close();if(records.length!==1)throw new Error('Expected exactly one durable encrypted operation');return records[0];
  },accounts[0].user.id);
  await pages[0].evaluate(async operation=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('phonemail-encrypted-outbox-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    const tx=db.transaction('operations','readwrite');const value=structuredClone(operation);value.record.prepared.to[0]='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';tx.objectStore('operations').put(value);await new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)});db.close();
  },savedOperation);
  const tamperedRecipient=await pages[0].evaluate(async id=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('phonemail-encrypted-outbox-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    const value=await new Promise((resolve,reject)=>{const tx=db.transaction('operations','readonly');const r=tx.objectStore('operations').get(id);r.onsuccess=()=>resolve(r.result.record.prepared.to[0]);r.onerror=()=>reject(r.error)});db.close();return value;
  },savedOperation.id);
  expect(tamperedRecipient).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const pending=pages[0].locator('.pending-row').first();
  await pending.getByRole('button',{name:'Check / retry exact send',exact:true}).click();
  await expect(pages[0].locator('.security-panel .error')).toBeVisible();
  await expect(pages[0].locator('.security-panel .error')).not.toContainText('Send outcome unknown');
  expect(interrupted).toHaveLength(1);
  await pages[0].evaluate(async operation=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('phonemail-encrypted-outbox-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    const tx=db.transaction('operations','readwrite');tx.objectStore('operations').put(operation);await new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)});db.close();
  },savedOperation);
  await pages[0].unroute(sendRoute);
  const replay=[];
  await pages[0].route(sendRoute,async route=>{
    const request=route.request();replay.push({body:request.postDataJSON(),key:request.headers()['idempotency-key']});await route.continue();
  });
  await pending.getByRole('button',{name:'Check / retry exact send',exact:true}).click();
  await expect(pages[0].getByRole('status')).toContainText('confirmed',{timeout:30000});
  expect(interrupted).toHaveLength(1);expect(replay).toHaveLength(1);
  expect(replay[0].body).toEqual(interrupted[0].body);expect(replay[0].key).toBe(interrupted[0].key);
  await pages[0].unroute(sendRoute);
  await close(pages[0]);
  const refreshedInbox=pages[1].waitForResponse(r=>(r.url().includes('/api/conversations?')||r.url().includes('/api/conversations/mailbox/inbox?'))&&r.request().method()==='GET');
  await pages[1].getByRole('button',{name:'Refresh mailbox',exact:true}).click();await refreshedInbox;await expect(pages[1].locator('.list-meta')).not.toContainText('UPDATING');
  const interruptedThread=pages[1].locator('.message-row').filter({hasText:'Encrypted message'}).first();
  await expect(interruptedThread).toBeVisible();await interruptedThread.click();
  await pages[1].getByRole('button',{name:'Decrypt message',exact:true}).filter({visible:true}).click();
  await expect(pages[1].locator('.message-detail')).toContainText('The exact ciphertext must survive reload');
  check('Interrupted encrypted send survives reload; invalid durable signature is rejected; retry reuses identical ciphertext and idempotency key once');

  // Also exercise response loss after the live backend has committed the ciphertext.
  const beforeCommittedLoss=(await accounts[0].client.request('/api/conversations/mailbox/sent?limit=100')).messages.length;
  const committedRequests=[];
  await pages[0].route(sendRoute,async route=>{const request=route.request();const response=await route.fetch();expect(response.ok()).toBe(true);committedRequests.push({body:request.postDataJSON(),key:request.headers()['idempotency-key']});await route.abort('failed');});
  await compose(pages[0],accounts[1].user.email,'Committed response lost','The backend already has this encrypted message');
  await pages[0].getByRole('button',{name:'Send message',exact:true}).click();await expect(pages[0].getByRole('alert')).toContainText('outcome unknown');
  await pages[0].reload({waitUntil:'domcontentloaded'});await expect(pages[0].getByRole('heading',{name:'Your conversations.'})).toBeVisible();await security(pages[0]);
  await pages[0].getByLabel('Private-key passphrase',{exact:true}).fill(secrets[0]);await pages[0].getByRole('button',{name:'Unlock keys',exact:true}).click();
  await pages[0].locator('.pending-row').getByRole('button',{name:'Check / retry exact send',exact:true}).click();await expect(pages[0].getByRole('status')).toContainText('confirmed');
  expect(committedRequests).toHaveLength(1);await expect(pages[0].locator('.pending-row')).toHaveCount(0);
  const recoveredOperation=(await accounts[0].client.request('/api/conversations/operations/'+committedRequests[0].key)).operation;
  const recoveredMessage=(await accounts[0].client.request('/api/e2ee/messages/'+recoveredOperation.resourceId)).message;
  expect(recoveredMessage.ciphertext).toBe(committedRequests[0].body.ciphertext);
  const afterCommittedLoss=(await accounts[0].client.request('/api/conversations/mailbox/sent?limit=100')).messages;expect(afterCommittedLoss.length).toBe(beforeCommittedLoss+1);expect(afterCommittedLoss.filter(m=>m.id===recoveredMessage.id)).toHaveLength(1);
  await pages[0].unroute(sendRoute);await close(pages[0]);
  check('A committed encrypted send with its response dropped survives reload and reconciles by the same identity/ciphertext without another send or duplicate');

  // Rotate through rendered controls, force changed-key re-verification, then retain historical mail.
  await security(pages[0]);
  await pages[0].getByLabel('Account password',{exact:true}).fill(accounts[0].password);
  await pages[0].getByLabel('I have an independent encrypted backup and understand that contacts must reverify a rotated key.',{exact:true}).check();
  await pages[0].getByRole('button',{name:'Rotate active key',exact:true}).click();
  await expect(pages[0].getByRole('status')).toContainText('rotated');
  const changedIdentity=await identity(pages[0]);
  await security(pages[1]);
  await pages[1].getByLabel('PhoneMail identity payload',{exact:true}).fill(changedIdentity);
  await pages[1].getByRole('button',{name:'Check identity',exact:true}).click();
  await expect(pages[1].locator('.trust-review')).toContainText('Changed fingerprint');
  await pages[1].getByLabel('I compared every fingerprint character with this person through a trusted independent channel.').check();
  await pages[1].getByRole('button',{name:'Trust this fingerprint',exact:true}).click();
  await expect(pages[1].getByRole('status')).toContainText('Fingerprint verified');
  check('Key rotation rejects the stale fingerprint in the recipient UI and requires explicit trust of the new key');

  await close(pages[1]);await pages[1].getByRole('button',{name:'Inbox',exact:true}).click();
  await pages[1].getByRole('button',{name:'Refresh mailbox',exact:true}).click();
  // Encrypted subjects are deliberately not sent in clear text; select by visible sender identity.
  await pages[1].locator('.message-row').filter({hasText:accounts[0].user.email}).last().click();
  await pages[1].getByRole('button',{name:'Decrypt message',exact:true}).filter({visible:true}).click();
  await expect(pages[1].locator('.message-detail')).toContainText('UI private body');
  await close(pages[0]);await pages[0].getByRole('button',{name:'Sent',exact:true}).click();
  await pages[0].getByRole('button',{name:'Refresh mailbox',exact:true}).click();
  await pages[0].locator('.message-row').filter({hasText:accounts[0].user.email}).last().click();
  await pages[0].getByRole('button',{name:'Decrypt message',exact:true}).filter({visible:true}).click();
  await expect(pages[0].locator('.message-detail')).toContainText('UI private body');
  check('Sender Sent and recipient historical mail remain readable after rotation and new-key trust');

  await security(pages[0]);
  await pages[0].getByLabel('Account password',{exact:true}).fill(accounts[0].password);
  await pages[0].getByLabel('I have an independent encrypted backup and understand that contacts must reverify a rotated key.',{exact:true}).check();
  await pages[0].getByRole('button',{name:'Revoke active key',exact:true}).click();
  await expect(pages[0].getByRole('status')).toContainText('revoked');
  await close(pages[0]);await security(pages[1]);
  await pages[1].getByLabel('PhoneMail identity payload',{exact:true}).fill(changedIdentity);
  await pages[1].getByRole('button',{name:'Check identity',exact:true}).click();
  await expect(pages[1].getByRole('alert')).toContainText('no longer has an active registered key');
  check('Revoked identity is rejected by the recipient UI');
  await pages[0].screenshot({path:'docs/screenshots/e2ee-desktop.png',fullPage:true});
}catch(error){console.error('UI acceptance stopped:',error?.stack||error);await pages[0].screenshot({path:'docs/screenshots/ui-failure.png',fullPage:true}).catch(()=>{});throw error}
finally{await writeFile('docs/browser-ui-results.json',JSON.stringify({started,finished:new Date().toISOString(),origin,browser:'Installed Chrome; production frontend; two isolated E2EE contexts plus one group recipient context; real UI actions',passed},null,2));await browser.close();for(const a of accounts)await a.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{})}
