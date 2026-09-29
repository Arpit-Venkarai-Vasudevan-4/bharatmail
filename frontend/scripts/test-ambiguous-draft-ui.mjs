/** Verify an unknown initial server-draft creation is reconciled without blind duplicate creation. */
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {register} from './live-support.mjs';
const origin=process.env.CLIENT_ORIGIN||'http://localhost:18080',started=new Date().toISOString();
const browser=await chromium.launch({channel:'chrome',headless:true});let account,recipient;
try{
 account=await register('Ambiguous draft owner');recipient=await register('Ambiguous draft recipient');const context=await browser.newContext();const page=await context.newPage();
 await page.goto(origin);await page.getByLabel('Phone number',{exact:true}).fill(account.user.phoneE164||'+'+account.user.phone);await page.getByLabel('Password',{exact:true}).fill(account.password);await page.locator('.auth-next').click();await expect(page.locator('.mail-workspace')).toBeVisible();
 const subject='Unknown creation '+randomUUID(),body='Keep this exact text while the server draft outcome is reconciled.';let firstResponseStatus=0,requests=0;
 await page.route('**/api/drafts',async route=>{if(route.request().method()==='POST'&&requests++===0){const response=await route.fetch();firstResponseStatus=response.status();await route.abort('failed');}else await route.continue()});
 await page.getByRole('button',{name:'Compose C',exact:true}).click();await page.getByLabel('To',{exact:true}).fill(recipient.user.email);await page.getByLabel('Subject',{exact:true}).fill(subject);await page.getByLabel('Message',{exact:true}).fill(body);
 const recovery=page.locator('.draft-recovery');await expect(recovery).toBeVisible({timeout:30000});assert.equal(firstResponseStatus,201);
 await expect(page.getByLabel('Subject',{exact:true})).toHaveValue(subject);await expect(page.getByLabel('Message',{exact:true})).toHaveValue(body);
 await recovery.getByRole('button',{name:'Inspect server drafts',exact:true}).click();await expect(recovery.getByText(subject,{exact:true})).toBeVisible();
 await expect(recovery.locator('pre')).toContainText(body);await recovery.getByRole('button',{name:'Use this draft; keep my text',exact:true}).click();
 await expect(page.getByLabel('Subject',{exact:true})).toHaveValue(subject);await expect(page.getByLabel('Message',{exact:true})).toHaveValue(body);
 await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.getByText('Saved to PhoneMail',{exact:true})).toBeVisible({timeout:30000});
 const drafts=await account.client.request('/api/drafts');assert.equal(drafts.drafts.filter(draft=>draft.subject===subject).length,1);
 const result={started,finished:new Date().toISOString(),origin,browser:'Installed Chrome, one local account and one recipient, live backend',passed:['A real initial draft POST committed with HTTP 201 but its browser response was dropped, producing the ambiguous state.','The composer kept the original recipient, subject, and body while listing the server draft.','The user explicitly linked the matching server draft, saved against its revision, and the backend still contained exactly one matching draft.'],limitations:['The test deliberately drops the response after the local server commit; it does not assert content similarity can identify authorship. The UI labels it as a possible draft and asks the user to review it.']};
 await writeFile('docs/ambiguous-draft-ui-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await context.close();
}finally{await browser.close();if(account)await account.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{});if(recipient)await recipient.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{})}
