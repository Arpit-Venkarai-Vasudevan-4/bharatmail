/** Verify the existing atomic draft-send contract where its fixed roles match. */
import {chromium, expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {register} from './live-support.mjs';

const origin=process.env.CLIENT_ORIGIN||'http://localhost:18080';
if(!/^http:\/\/localhost:\d+$/.test(origin))throw new Error('Local acceptance only');
const started=new Date().toISOString(),passed=[],accounts=[];
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  for(const name of ['Thread owner','Thread To recipient','Thread Cc recipient'])accounts.push(await register(name));
  const [owner,to,cc]=accounts,context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
  await page.goto(origin);await page.getByLabel('Phone number',{exact:true}).fill(owner.user.phoneE164||'+'+owner.user.phone);await page.getByLabel('Password',{exact:true}).fill(owner.password);await page.locator('.auth-next').click();await expect(page.locator('.mail-workspace')).toBeVisible();
  for(const group of [false,true]) {
    const subject=(group?'Group':'Direct')+' thread '+randomUUID();
    await page.getByRole('button',{name:'Compose C',exact:true}).click();await page.getByLabel('To',{exact:true}).fill(to.user.email);
    if(group){await page.getByRole('button',{name:'Cc',exact:true}).click();await page.getByLabel('Cc',{exact:true}).fill(cc.user.email);}
    await page.getByLabel('Subject',{exact:true}).fill(subject);await page.getByLabel('Message',{exact:true}).fill('Original membership and roles');await page.getByRole('button',{name:'Confirm recipients',exact:true}).click();await expect(page.locator('.success-note')).toContainText('Confirmed:');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
    const first=(await owner.client.request('/api/conversations/mailbox/sent?limit=100')).messages.find(m=>m.subject===subject);expect(first).toBeTruthy();
    await page.locator('.message-row').filter({hasText:subject}).click();await expect(page.locator('.message-detail')).toContainText('Original membership and roles');
    await page.locator('.thread-compose-bar button').nth(1).click();await expect(page.getByLabel('To',{exact:true})).toBeDisabled();await expect(page.getByLabel('To',{exact:true})).toHaveValue(to.user.email);
    if(group){await expect(page.getByLabel('Cc',{exact:true})).toBeDisabled();await expect(page.getByLabel('Cc',{exact:true})).toHaveValue(cc.user.email);}
    const followup=subject+' attachment';await page.getByLabel('Subject',{exact:true}).fill(followup);await page.getByLabel('Message',{exact:true}).fill('Attachment stays in the existing conversation');await page.getByLabel('Attach file',{exact:true}).setInputFiles({name:'thread-proof.txt',mimeType:'text/plain',buffer:Buffer.from('Same conversation attachment')});
    await expect(page.locator('.compose-attachments')).toContainText('Ready');
    await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
    const sent=(await owner.client.request('/api/conversations/mailbox/sent?limit=100')).messages.filter(m=>m.subject===followup);expect(sent).toHaveLength(1);expect(sent[0].conversationId).toBe(first.conversationId);
    const full=(await owner.client.request(`/api/conversations/${first.conversationId}/messages/${sent[0].id}`)).message;
    expect(full.recipients.map(r=>`${r.role}:${r.email}`).sort()).toEqual([`to:${to.user.email}`,...(group?[`cc:${cc.user.email}`]:[])].sort());expect(full.attachments).toHaveLength(1);
    for(const recipient of group?[to,cc]:[to]){const bytes=await recipient.client.response('/api/uploads/'+full.attachments[0].id);expect(await bytes.text()).toBe('Same conversation attachment');}
    const drafts=(await owner.client.request('/api/drafts')).drafts;expect(drafts.filter(d=>d.subject===followup)).toHaveLength(0);
    await page.getByRole('button',{name:'Refresh mailbox',exact:true}).click();await page.locator('.message-row').filter({hasText:followup}).click();await expect(page.getByRole('button',{name:'Preview thread-proof.txt',exact:true}).filter({visible:true})).toBeVisible();await page.getByRole('button',{name:'Preview thread-proof.txt',exact:true}).filter({visible:true}).click();await expect(page.getByRole('dialog',{name:'thread-proof.txt'})).toContainText('Same conversation attachment');await page.getByRole('button',{name:'Close dialog',exact:true}).click();
    passed.push(`${group?'Group with To/Cc':'Direct'} original-sender follow-up attaches a file through atomic draft send, retains conversation/roles, reaches recipients, and consumes the draft`);
    console.log('PASS '+passed.at(-1));
  }
  await writeFile('docs/thread-contract-ui-results.json',JSON.stringify({started,finished:new Date().toISOString(),origin,passed,limitations:['The supported path is a new message by the original sender after the initial message and its roles have been loaded. Replies, other senders, and incomplete history use the server-routed message endpoint, which has no attachment field.']},null,2));
  await context.close();
}finally{await browser.close();for(const account of accounts)await account.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{});}
