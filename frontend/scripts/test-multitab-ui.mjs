/** Live same-origin multi-tab refresh and send serialization checks. */
import {chromium,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {register} from './live-support.mjs';
const origin=process.env.CLIENT_ORIGIN||'http://localhost:18080';
if(!/^http:\/\/localhost:\d+$/.test(origin))throw new Error('Local production frontend only');
const started=new Date().toISOString(),browser=await chromium.launch({channel:'chrome',headless:true});const passed=[];let account,recipient;
const check=value=>{passed.push(value);console.log('PASS '+value)};
try{
 account=await register('Multi-tab UI owner');recipient=await register('Multi-tab UI recipient');
 const context=await browser.newContext();const a=await context.newPage(),b=await context.newPage();
 await a.goto(origin);await a.getByLabel('Phone number',{exact:true}).fill(account.user.phoneE164||'+'+account.user.phone);await a.getByLabel('Password',{exact:true}).fill(account.password);await a.locator('.auth-next').click();await expect(a.getByRole('heading',{name:'Your conversations.'})).toBeVisible();
 await b.goto(origin);await expect(b.getByRole('heading',{name:'Your conversations.'})).toBeVisible();
 let arrivals=0,releaseBarrier;const barrier=new Promise(resolve=>releaseBarrier=resolve);let refreshes=0;
 for(const page of [a,b]){
  await page.route('**/api/me/preferences',async route=>{if(++arrivals<=2){if(arrivals===2)releaseBarrier();await barrier;await route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{code:'UNAUTHORIZED',message:'hidden server detail'}})});}else await route.continue()});
  await page.route('**/api/auth/refresh',async route=>{refreshes++;await route.continue()});
 }
 await Promise.all([a.locator('.profile-button').click(),b.locator('.profile-button').click()]);
 await expect(a.locator('.settings-view')).toBeVisible();await expect(b.locator('.settings-view')).toBeVisible();
 await expect.poll(()=>refreshes,{timeout:30000}).toBe(1);
 await expect(a.getByRole('alert')).toHaveCount(0);await expect(b.getByRole('alert')).toHaveCount(0);
 check('Two browser tabs receive simultaneous 401 responses, share one live session renewal, and both recover their settings requests');
 await a.getByRole('button',{name:'Close dialog',exact:true}).click();await b.getByRole('button',{name:'Close dialog',exact:true}).click();
 const subject='Multi-tab exact send '+randomUUID();
 await a.getByRole('button',{name:'Compose C',exact:true}).click();await a.getByLabel('To',{exact:true}).fill(recipient.user.email);await a.getByLabel('Subject',{exact:true}).fill(subject);await a.getByLabel('Message',{exact:true}).fill('Only one server message may be created while another tab checks the same operation.');await a.getByRole('button',{name:'Confirm recipients',exact:true}).click();
 let sends=0,releaseSend;const gate=new Promise(resolve=>releaseSend=resolve);let finishFetch;
 const sendFetched=new Promise(resolve=>finishFetch=resolve);
 await a.route('**/api/drafts/*/send',async route=>{sends++;const response=await route.fetch();finishFetch(response.status());await gate;await route.fulfill({response})});
 await a.getByRole('button',{name:'Send message',exact:true}).click();
 expect(await sendFetched).toBe(201);
 await b.getByRole('button',{name:'Pending sends',exact:true}).click();await expect(b.getByRole('dialog',{name:'Pending & recent sends'})).toBeVisible();
 const retry=b.getByRole('button',{name:'Check / retry same send',exact:true});await expect(retry).toBeVisible();
 const secondAttempt=retry.click();await expect(b.getByText('Checking…',{exact:true})).toBeVisible();
 await new Promise(resolve=>setTimeout(resolve,300));expect(sends).toBe(1);
 releaseSend();await secondAttempt;
 await expect(a.getByRole('dialog')).toHaveCount(0,{timeout:30000});
 await expect(b.getByText('Committed to PhoneMail',{exact:true})).toBeVisible({timeout:30000});
 const sent=await account.client.request('/api/conversations/mailbox/sent?limit=100');
 expect(sent.messages.filter(message=>message.subject===subject)).toHaveLength(1);expect(sends).toBe(1);
 check('Two tabs race one durable send identity under Web Locks; operation lookup confirms one live backend message');
 await writeFile('docs/multitab-ui-results.json',JSON.stringify({started,finished:new Date().toISOString(),origin,browser:'Installed Chrome, production Docker frontend, one same-origin profile with two tabs',refreshRequestsObserved:refreshes,sendRequestsObserved:sends,passed,limitations:['Concurrent operations were issued in two tabs of one Chromium profile, so they shared cookies, IndexedDB, BroadcastChannel, and Web Locks. Other browsers do not share those browser primitives.']},null,2));
 await context.close();
}finally{await browser.close();if(account)await account.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{});if(recipient)await recipient.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{})}
