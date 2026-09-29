/** Mobile-first UI pass with actual product navigation and ordinary send. */
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {register} from './live-support.mjs';
const origin=process.env.CLIENT_ORIGIN||'http://localhost:18080';
const started=new Date().toISOString(),browser=await chromium.launch({channel:'chrome',headless:true}),passed=[];
const check=value=>{passed.push(value);console.log('PASS '+value)};
async function noHorizontalOverflow(page,label){const width=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));assert.ok(width.document<=width.viewport,`${label}: ${JSON.stringify(width)}`)}
async function screenshot(page,name){await page.screenshot({path:`docs/screenshots/${name}.png`,fullPage:true})}
try{
 await mkdir('docs/screenshots',{recursive:true});
 const account=await register('Mobile UI '+randomUUID()),recipient=await register('Mobile UI recipient');
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.getByLabel('Phone number',{exact:true}).fill(account.user.phoneE164||'+'+account.user.phone);await page.getByLabel('Password',{exact:true}).fill(account.password);await page.locator('.auth-next').click();await expect(page.locator('.mail-workspace')).toBeVisible();await expect(page.locator('.list-meta > span').first()).toHaveText('0 messages');await noHorizontalOverflow(page,'mobile Home');await screenshot(page,'mailbox-mobile');
 const compose=page.locator('.mobile-compose');await expect(compose).toBeVisible();const composeTarget=await compose.boundingBox();assert.ok(composeTarget.height>=44);await compose.click();await expect(page.getByRole('dialog')).toBeVisible();
 await page.getByLabel('To',{exact:true}).fill(recipient.user.email);await page.getByLabel('Subject',{exact:true}).fill('Mobile conversation subject');await page.getByLabel('Message',{exact:true}).fill('A readable mobile message with enough length to show natural wrapping in the conversation view.');
 await noHorizontalOverflow(page,'mobile compose');await screenshot(page,'compose-mobile');
 await page.getByRole('button',{name:'Confirm recipients',exact:true}).click();await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:30000});
 const sizes=await page.evaluate(()=>({menu:document.querySelector('.mobile-menu')?.getBoundingClientRect().height||0,settings:document.querySelector('.topbar-actions button[aria-label="Account settings"]')?.getBoundingClientRect().height||0,filters:[...document.querySelectorAll('.filter-row button')].map(e=>e.getBoundingClientRect().height)}));
 assert.ok(sizes.menu>=44);assert.ok(sizes.settings>=44);assert.ok(sizes.filters.every(height=>height>=44));
 const row=page.locator('.message-row').filter({hasText:'Mobile conversation subject'});await expect(row).toBeVisible({timeout:30000});await expect(page.locator('.list-meta > span').first()).toHaveText('1 conversation');await row.click();await expect(page.locator('.mobile-history')).toBeVisible();await expect(page.locator('.mobile-history')).toContainText('A readable mobile message');await noHorizontalOverflow(page,'mobile conversation history');const forwardTarget=await page.getByRole('button',{name:'Forward as new message',exact:true}).boundingBox();assert.ok(forwardTarget.y>=0&&forwardTarget.y+forwardTarget.height<=844,'Forward stays inside the mobile reading pane above the footer');await screenshot(page,'conversation-mobile');
 sizes.reply=await page.locator('.bubble-bottom button').evaluateAll(buttons=>buttons.map(e=>e.getBoundingClientRect().height));assert.ok(sizes.reply.every(height=>height>=44));
 await page.getByRole('button',{name:'Account settings',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await noHorizontalOverflow(page,'mobile settings');await screenshot(page,'settings-mobile');
 const dialog=await page.getByRole('dialog').boundingBox();assert.ok(dialog.x>=0&&dialog.x+dialog.width<=390&&dialog.y>=0&&dialog.y+dialog.height<=844);
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.setViewportSize({width:1280,height:1000});
 await expect(page.locator('.message-detail')).toBeVisible();
 await page.locator('.message-detail').getByRole('button',{name:'Delivery details',exact:true}).click();
 const delivery=page.getByRole('dialog',{name:'Delivery details'});await expect(delivery).toContainText('Committed to PhoneMail');await expect(delivery).toContainText('Available in PhoneMail');await expect(delivery).toContainText(recipient.user.email);await expect(delivery.locator('pre')).toHaveCount(0);await screenshot(page,'delivery-desktop');
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.getByRole('button',{name:'Pending sends',exact:true}).click();await expect(page.getByRole('dialog',{name:'Pending & recent sends'})).toContainText('Committed to PhoneMail');await screenshot(page,'pending-sends-desktop');
 check('Mailbox counts render once with the correct plural; live delivery and pending-send statuses use readable labels');
 assert.deepEqual(errors,[]);check('390×844 touch browser: Home, compose, sent conversation history, and settings fit without horizontal overflow or browser errors');check('Mobile primary compose, navigation/settings, and filter touch targets are at least 44 CSS pixels');
 const result={started,finished:new Date().toISOString(),origin,browser:'Installed Chrome, headless, emulated 390×844 touch viewport, production Docker frontend, live backend',passed,measuredTouchTargets:sizes,limitations:['This Chromium run has touch input and a mobile viewport but no physical iOS/Android on-screen keyboard; keyboard resize, predictive bar, and device-specific viewport behavior remain unverified.']};await writeFile('docs/responsive-ui-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await context.close();await account.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{});await recipient.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{});
}finally{await browser.close()}
