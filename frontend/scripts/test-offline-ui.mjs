/** Browser offline/cache/sync acceptance against the live local backend. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { register } from './live-support.mjs';
const origin=process.env.CLIENT_ORIGIN||'http://localhost:18080';
const started=new Date().toISOString();
const docker='/Applications/Docker.app/Contents/Resources/bin/docker';
if(!/^http:\/\/localhost:\d+$/.test(origin))throw new Error('Local production frontend only');
const browser=await chromium.launch({channel:'chrome',headless:true});
const passed=[];const check=value=>{passed.push(value);console.log('PASS '+value)};
function setRetention(userId,revision){
  const sql=`INSERT INTO account_sync_state(user_id,pruned_through_revision,updated_at) VALUES('${userId}',${revision},now()) ON CONFLICT(user_id) DO UPDATE SET pruned_through_revision=EXCLUDED.pruned_through_revision,updated_at=now()`;
  const result=spawnSync(docker,['exec','frontrepo-db-1','psql','-U','phonemail','-d','phonemail','-v','ON_ERROR_STOP=1','-c',sql],{encoding:'utf8'});
  if(result.status!==0)throw new Error(`Unable to set disposable sync fixture: ${result.stderr||result.error}`);
}
async function localRecords(page,userId){return page.evaluate(async id=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('phonemail-offline-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const values=await new Promise((resolve,reject)=>{const tx=db.transaction('records','readonly');const r=tx.objectStore('records').index('account').getAll(IDBKeyRange.only(id));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();return values;
},userId)}
try{
  const owner=await register('Offline UI owner');const recipient=await register('Offline UI recipient');const emptyAccount=await register('Offline account switch target');
  const created=await owner.client.request('/api/drafts',{method:'POST',body:{to:[recipient.user.email],cc:[],subject:'Offline cache subject',body:'Offline cache message body'}});
  await owner.client.request(`/api/drafts/${created.draft.id}/send`,{method:'POST',headers:{'If-Match':`"revision-${created.draft.revision}"`,'Idempotency-Key':`offline-ui-${crypto.randomUUID()}`},body:{attachmentIds:[]}});
  // More than one bounded snapshot page, using inert .invalid contact addresses.
  for(let i=0;i<105;i++)await owner.client.request('/api/me/contacts',{method:'POST',body:{address:`offline-${i}@example.invalid`,label:`Offline snapshot fixture ${i}`}});
  const context=await browser.newContext();const page=await context.newPage();
  await page.goto(origin);await page.getByLabel('Phone number',{exact:true}).fill(owner.user.phoneE164||'+'+owner.user.phone);await page.getByLabel('Password',{exact:true}).fill(owner.password);await page.locator('.auth-next').click();
  await expect(page.locator('.mail-workspace')).toBeVisible();
  await page.evaluate(()=>navigator.serviceWorker.ready);
  let blockedSecondPage=false;
  await page.route('**/api/sync/snapshot**',async route=>{
    const url=new URL(route.request().url());
    if(url.searchParams.has('snapshotId')&&!blockedSecondPage){blockedSecondPage=true;await route.abort('failed');return}
    await route.continue();
  });
  await page.locator('.profile-button').click();
  const offlineToggle=page.getByLabel('Keep mail on this device',{exact:true});
  // The switch checkbox is intentionally visually hidden; exercise its visible label.
  try{await page.locator('.setting-toggle').filter({hasText:'Keep mail on this device'}).click()}catch(error){
    console.error('Offline preference state after click:',await offlineToggle.isChecked().catch(()=>null));
    console.error('Settings alert:',await page.getByRole('alert').allTextContents().catch(()=>[]));
    console.error('Settings visible text:',await page.locator('.settings-view').innerText().catch(()=>''));
    await page.screenshot({path:'docs/screenshots/offline-toggle-failure.png',fullPage:true}).catch(()=>{});throw error;
  }
  await expect(offlineToggle).toBeChecked({timeout:10000});
  await expect(page.getByRole('status')).toContainText('Offline storage enabled');
  await expect.poll(()=>blockedSecondPage,{timeout:30000}).toBe(true);
  await expect.poll(async()=>{
    const records=await localRecords(page,owner.user.id);return records.find(x=>x.bucket==='sync'&&x.key==='state')?.value?.snapshotId||'';
  },{timeout:10000}).not.toBe('');
  let records=await localRecords(page,owner.user.id);
  const staged=records.find(x=>x.bucket==='sync'&&x.key==='state').value;
  assert.ok(staged.pageCursor);assert.ok(records.some(x=>x.bucket===`snapshot:${staged.snapshotId}`));
  check('Offline storage opt-in persists; a real multi-page live snapshot is interrupted after page one and remains staged');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Refresh mailbox',exact:true}).click();
  await page.locator('.message-row').filter({hasText:'Offline cache subject'}).click();
  await expect(page.locator('.message-detail')).toContainText('Offline cache message body');
  await context.setOffline(true);
  await page.getByRole('button',{name:'Compose C',exact:true}).click();
  await page.getByLabel('To',{exact:true}).fill(recipient.user.email);
  await page.getByLabel('Subject',{exact:true}).fill('Offline local draft');
  await page.getByLabel('Message',{exact:true}).fill('Keep this unsent until reconnection');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.locator('.compose-mode')).toContainText('Saved on this device');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('.mail-workspace')).toBeVisible();
  await expect(page.locator('.message-row').filter({hasText:'Offline cache subject'})).toBeVisible();
  await page.getByRole('button',{name:'Drafts',exact:true}).click();
  await expect(page.locator('.message-row').filter({hasText:'Offline local draft'})).toBeVisible();
  check('After online visit, actual offline browser reload restores opted-in mail and the unsent local draft');

  // Simulate quota rejection at the IndexedDB write boundary: the UI must not say Saved.
  await page.getByRole('button',{name:'Compose C',exact:true}).click();
  await page.getByLabel('To',{exact:true}).fill(recipient.user.email);
  await page.getByLabel('Subject',{exact:true}).fill('Quota failure draft');
  await page.getByLabel('Message',{exact:true}).fill('This write must be reported as failed');
  await page.evaluate(()=>{window.__originalIdbPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException('Quota exceeded by test','QuotaExceededError')}});
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.locator('.compose-mode')).toContainText('Not saved on this device');
  await expect(page.locator('.compose-mode')).not.toContainText('Saved on this device');
  await page.evaluate(()=>{if(window.__originalIdbPut)IDBObjectStore.prototype.put=window.__originalIdbPut});
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  check('IndexedDB quota rejection gives an explicit failed-save state, never a Saved confirmation');

  // A separate tab with storage denied can show the online app but cannot confirm a durable offline save.
  const denied=await context.newPage();
  await denied.addInitScript(()=>Object.defineProperty(window,'indexedDB',{configurable:true,get(){throw new DOMException('Storage denied by test','SecurityError')}}));
  await denied.goto(origin);await expect(denied.getByRole('heading',{name:'Your conversations.'})).toBeVisible();
  await context.setOffline(true);
  await denied.getByRole('button',{name:'Compose C',exact:true}).click();await denied.getByLabel('To',{exact:true}).fill(recipient.user.email);await denied.getByLabel('Subject',{exact:true}).fill('Denied storage draft');await denied.getByLabel('Message',{exact:true}).fill('Do not claim this was saved');
  await denied.getByRole('button',{name:'Save draft',exact:true}).click();await expect(denied.locator('.compose-mode')).toContainText('Not saved on this device');
  await expect(denied.locator('.compose-mode')).not.toContainText('Saved on this device');
  await context.setOffline(false);await denied.close();
  check('IndexedDB denial blocks offline persistence and never produces a Saved confirmation');

  await context.unroute('**/api/sync/snapshot**');
  await context.setOffline(false);
  // Complete the previously staged snapshot; its restart must retain the local draft.
  await page.evaluate(()=>window.dispatchEvent(new Event('phonemail:offline-policy')));
  await expect.poll(async()=>{
    const current=await localRecords(page,owner.user.id);return current.find(x=>x.bucket==='sync'&&x.key==='state')?.value?.cursor||'';
  },{timeout:60000,intervals:[500,1000,2000,5000,10000]}).not.toBe('');
  records=await localRecords(page,owner.user.id);
  assert.ok(records.some(x=>x.bucket==='local-draft'&&x.value?.subject==='Offline local draft'));
  const state=records.find(x=>x.bucket==='sync'&&x.key==='state').value;
  const oldCursor=state.cursor;
  check('Reconnection resumes the actual paged snapshot and keeps the unsent local draft outside server reconciliation');

  // Force a 410 for this disposable account only, then verify Workspace recovery starts a fresh snapshot.
  setRetention(owner.user.id,(BigInt(oldCursor)+1n).toString());
  const expired=page.waitForResponse(response=>response.url().includes('/api/sync?')&&response.status()===410,{timeout:30000});
  await page.evaluate(()=>window.dispatchEvent(new Event('phonemail:offline-policy')));
  const expiredResponse=await expired;
  assert.equal(expiredResponse.status(),410);
  await expect.poll(async()=>{
    const current=await localRecords(page,owner.user.id);const sync=current.find(x=>x.bucket==='sync'&&x.key==='state')?.value;return !!sync?.cursor&&!sync.snapshotId;
  },{timeout:45000,intervals:[500,1000,2000,5000]}).toBe(true);
  records=await localRecords(page,owner.user.id);assert.ok(records.some(x=>x.bucket==='local-draft'&&x.value?.subject==='Offline local draft'));
  setRetention(owner.user.id,'0');
  check('Live backend CURSOR_EXPIRED (410) triggers a fresh snapshot without deleting the unsent local draft');

  // A second account in the same browser profile must not see the first account's cached mail or draft.
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByLabel('Phone number',{exact:true}).fill(emptyAccount.user.phoneE164||'+'+emptyAccount.user.phone);await page.getByLabel('Password',{exact:true}).fill(emptyAccount.password);await page.locator('.auth-next').click();
  await expect(page.locator('.mail-workspace')).toBeVisible();
  await expect(page.locator('.message-row').filter({hasText:'Offline cache subject'})).toHaveCount(0);
  await page.getByRole('button',{name:'Drafts',exact:true}).click();await expect(page.locator('.message-row').filter({hasText:'Offline local draft'})).toHaveCount(0);
  check('Switching accounts in the same browser does not expose another account’s cached messages or drafts');

  const result={started,origin,browser:'Installed Chrome, production Docker frontend, live backend, one isolated context with second tab',passed,contactsForPagedSnapshot:105,expiredCursorResponse:410,limitations:['QuotaExceededError and SecurityError were injected at the real IndexedDB write/open boundary; hardware quota exhaustion and browser-specific storage policy dialogs were not induced.','Retention watermark was set by a test-only SQL update for this generated account row, then reset to zero; no production account or backend source was changed.']};
  result.finished=new Date().toISOString();await writeFile('docs/offline-ui-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
