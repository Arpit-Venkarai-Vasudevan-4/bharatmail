/** Production Chrome measurements with page-target network throttling and CDP CPU slowdown. */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { register } from './live-support.mjs';

const origin=process.env.CLIENT_ORIGIN||'http://localhost:18080';
const browser=await chromium.launch({channel:'chrome',headless:true});
const started=new Date().toISOString(),samples=[];
const conditions={routeReadiness:'heading visible, main mailbox API complete, updating indicator cleared',navigationRoute:'unauthenticated sign-in',latencyMs:150,downloadBytesPerSecond:200*1024,uploadBytesPerSecond:50*1024,cpuThrottlingRate:4,viewport:'390x844',coldRuns:3,warmRuns:3};
async function profile(page,cdp){
 await cdp.send('Network.enable');
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:conditions.latencyMs,downloadThroughput:conditions.downloadBytesPerSecond,uploadThroughput:conditions.uploadBytesPerSecond,connectionType:'cellular3g'});
 await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:conditions.cpuThrottlingRate});
 await page.addInitScript(()=>{
  window.__paintMetrics={lcp:0,longTasks:[]};
  try{new PerformanceObserver(list=>{for(const e of list.getEntries())window.__paintMetrics.lcp=Math.max(window.__paintMetrics.lcp,e.startTime)}).observe({type:'largest-contentful-paint',buffered:true});}catch{}
  try{new PerformanceObserver(list=>{for(const e of list.getEntries())window.__paintMetrics.longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true});}catch{}
 });
}
async function readNavigation(page){
 await page.waitForTimeout(100);
 return page.evaluate(()=>{
  const n=performance.getEntriesByType('navigation')[0];const paint=window.__paintMetrics||{lcp:0,longTasks:[]};
  return {domContentLoadedMs:Math.round(n.domContentLoadedEventEnd),loadEventMs:Math.round(n.loadEventEnd),responseStartMs:Math.round(n.responseStart),fcpMs:Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime||0),lcpMs:Math.round(paint.lcp),transferBytes:performance.getEntriesByType('resource').reduce((sum,e)=>sum+(e.transferSize||0),0),longTasks:paint.longTasks};
 });
}
let retained;
try{
 for(let i=0;i<3;i++){
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'allow'});const page=await context.newPage();const cdp=await context.newCDPSession(page);await profile(page,cdp);
  await page.goto(origin,{waitUntil:'load'});await page.locator('.auth-page').waitFor();
  const cold=await readNavigation(page);samples.push({kind:'cold',run:i+1,...cold});
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:false});
  await page.reload({waitUntil:'load'});await page.locator('.auth-page').waitFor();
  const warm=await readNavigation(page);samples.push({kind:'warm',run:i+1,...warm});
  if(i===2)retained={context,page,cdp};else await context.close();
 }
 assert.ok(retained);
 const {context,page,cdp}=retained;
 const account=await register('Perf browser '+randomUUID());
 await page.getByLabel('Phone number',{exact:true}).fill(account.user.phoneE164||'+'+account.user.phone);
 await page.getByLabel('Password',{exact:true}).fill(account.password);
 await page.locator('.auth-next').click();
 await expect(page.getByRole('heading',{name:'Your conversations.'})).toBeVisible({timeout:60000});
 const routes=[];
 // Representative folder transitions from the mobile drawer; Home remains primary.
 for(const destination of ['Drafts','Favorites','Home']){
  const menu=page.getByRole('button',{name:'Open navigation',exact:true});if(await menu.isVisible())await menu.click();
  const navigation=page.getByRole('complementary',{name:'Main navigation'}).getByRole('button',{name:destination,exact:true});await expect(navigation).toBeVisible();
  const completed=page.waitForResponse(response=>{const url=new URL(response.url());return response.status()===200&&(destination==='Drafts'?url.pathname==='/api/conversations/mailbox/drafts':url.pathname==='/api/conversations'&&url.searchParams.get('filter')===(destination==='Favorites'?'favorites':'all'));});
  const start=await page.evaluate(()=>performance.now());await navigation.click();
  await (await completed).finished();
  await expect(page.locator('.mail-list-pane h1')).toContainText(destination==='Home'?'Your conversations':destination,{timeout:30000});
  await expect(page.locator('.list-meta')).not.toContainText('UPDATING');
  routes.push({destination,elapsedMs:Math.round(await page.evaluate(s=>performance.now()-s,start))});
 }
 const menu=page.getByRole('button',{name:'Open navigation',exact:true});if(await menu.isVisible())await menu.click();
 const privacy=page.getByRole('button',{name:'Privacy & keys',exact:true});await expect(privacy).toBeVisible();await privacy.click();
 const passphrase='Perf-Encryption-'+randomUUID();
 await page.getByLabel('Private-key passphrase',{exact:true}).fill(passphrase);
 await page.getByLabel('Account password',{exact:true}).fill(account.password);
 const cryptoStart=await page.evaluate(()=>performance.now());
 await page.getByRole('button',{name:'Create & enroll',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('enrolled',{timeout:120000});
 const encryption=await page.evaluate(start=>{const tasks=(window.__paintMetrics?.longTasks||[]).filter(task=>task.start>=start);return {elapsedMs:Math.round(performance.now()-start),longTasks:tasks,longTaskCount:tasks.length,longTaskTotalMs:Math.round(tasks.reduce((sum,task)=>sum+task.duration,0)),longTaskMaxMs:Math.round(Math.max(0,...tasks.map(task=>task.duration))) }},cryptoStart);
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.getByRole('button',{name:'Account settings',exact:true}).click();
 const offlineToggle=page.getByLabel('Keep mail on this device',{exact:true});
 await page.locator('.setting-toggle').filter({hasText:'Keep mail on this device'}).click();
 await expect(offlineToggle).toBeChecked();
 await expect(page.getByRole('status')).toContainText('Offline storage enabled');
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.evaluate(()=>navigator.serviceWorker.ready);
 await cdp.send('Network.setCacheDisabled',{cacheDisabled:false});
 // One controlled online reload gives the active worker an opportunity to claim the page.
 await page.reload({waitUntil:'domcontentloaded'});
 await expect(page.getByRole('heading',{name:'Your conversations.'})).toBeVisible();
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 const offlineStarted=Date.now();
 await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0,connectionType:'none'});
 await page.reload({waitUntil:'domcontentloaded'});
 await expect(page.getByRole('heading',{name:'Your conversations.'})).toBeVisible();
 const offlineStartup={elapsedMs:Date.now()-offlineStarted,...await readNavigation(page),restoredWorkspace:true,serviceWorkerControlled:true,offlineStorageOptedIn:true};
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:conditions.latencyMs,downloadThroughput:conditions.downloadBytesPerSecond,uploadThroughput:conditions.uploadBytesPerSecond,connectionType:'cellular3g'});
 const output={started,origin,browser:'Installed Chrome, headless, production Docker frontend',browserVersion:browser.version(),host:{platform:process.platform,arch:process.arch,node:process.version,cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem()},conditions,samples,routes,encryption,offlineStartup,limitations:['CDP shapes the measured Chrome page target, including its API requests; separate service-worker target traffic and aggregate traffic from other devices are not guaranteed to share this limit. It does not emulate a real mobile radio or packet loss.','CPU rate 4 is Chrome software throttling on this host, not a physical low-end phone. Cold runs use fresh browser contexts with HTTP cache disabled; warm runs reload in the same context after one visit.','Offline startup is a single service-worker-controlled reload after explicit offline-storage opt-in; the separate offline acceptance suite verifies cached mail and local-draft restoration.','Resource transferBytes counts page-observed resource entries and excludes the navigation document and service-worker precache requests. LCP and resource timing are lab observations, not field percentiles. The API and UI acceptance backend remain local.']};
 output.finished=new Date().toISOString();await writeFile('docs/performance-browser-results.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
 await account.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{});await context.close();
}finally{await browser.close();}
