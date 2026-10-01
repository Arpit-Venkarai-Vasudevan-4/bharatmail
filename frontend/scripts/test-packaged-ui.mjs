/** Container smoke/acceptance for the frontend-only Docker overlay. */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { register } from './live-support.mjs';
const clientOrigin=process.env.CLIENT_ORIGIN||'http://localhost:18080';
const portalOrigin=process.env.PORTAL_ORIGIN||'http://localhost:18081';
if(!/^http:\/\/localhost:\d+$/.test(clientOrigin)||!/^http:\/\/localhost:\d+$/.test(portalOrigin))throw new Error('Local packaged UI only');
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[];
const started=new Date().toISOString();
try{
  const [clientShell,portalShell,apiLive]=await Promise.all([
    fetch(clientOrigin+'/'),fetch(portalOrigin+'/portal.html'),fetch(clientOrigin+'/api/otp/capabilities')
  ]);
  assert.equal(clientShell.status,200);assert.equal(portalShell.status,200);assert.equal(apiLive.status,200);
  for(const response of [clientShell,portalShell]){
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(response.headers.get('x-frame-options'),'DENY');
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    assert.ok(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  }
  assert.match(portalShell.headers.get('cache-control')||'',/no-store/);
  assert.match(apiLive.headers.get('cache-control')||'',/no-store/);
  const redirectResponse=await fetch(portalOrigin+'/portal',{redirect:'manual'});
  assert.equal(redirectResponse.status,302);assert.equal(redirectResponse.headers.get('location'),'/portal.html');
  const shellHtml=await clientShell.text();const assetPath=shellHtml.match(/src="([^"]+\.js)"/)?.[1];assert.ok(assetPath);
  const asset=await fetch(new URL(assetPath,clientOrigin),{headers:{'Accept-Encoding':'gzip'}});assert.match(asset.headers.get('cache-control')||'',/immutable/);assert.equal(asset.headers.get('content-encoding'),'gzip');assert.match(asset.headers.get('vary')||'',/Accept-Encoding/i);
  const account=await register('Packaged frontend acceptance');
  const context=await browser.newContext();const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(clientOrigin);await page.getByLabel('Phone number',{exact:true}).fill(account.user.phoneE164||'+'+account.user.phone);
  await page.getByLabel('Password',{exact:true}).fill(account.password);await page.locator('.auth-next').click();
  await expect(page.getByRole('heading',{name:'Your conversations.'})).toBeVisible();
  await page.evaluate(()=>navigator.serviceWorker.ready);
  const cachedShellPaths=await page.evaluate(async()=>{const paths=[];for(const name of await caches.keys())if(name.startsWith('phonemail-shell-'))for(const request of await (await caches.open(name)).keys())paths.push(new URL(request.url).pathname);return paths;});
  assert.ok(cachedShellPaths.includes('/index.html'));
  assert.ok(!cachedShellPaths.some(path=>/\/(encryption|scanner|SecurityPanel|Contacts|Introduction|ta\.draft)-/.test(path)),'Optional features must not be precached on startup');
  const cookieNames=(await context.cookies(clientOrigin)).map(cookie=>cookie.name);
  assert.ok(cookieNames.includes('phonemail_session'));assert.ok(cookieNames.includes('phonemail_csrf'));
  await page.locator('.profile-button').click();await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Display name',{exact:true}).fill('Proxy and CSRF verified');
  await page.getByRole('button',{name:'Save profile',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Profile saved');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.goto(`${clientOrigin}/conversations/deep-link-check`);
  await expect(page.getByRole('heading',{name:'Your conversations.'})).toBeVisible();

  const existingSession=(await context.cookies(clientOrigin)).find(cookie=>cookie.name==='phonemail_session')?.value;
  const portal=await context.newPage();const portalApiRequests=[];
  portal.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))portalApiRequests.push(request);});
  portal.on('pageerror',error=>errors.push(error.message));
  const redirect=await portal.goto(`${portalOrigin}/portal`);
  assert.equal(redirect?.status(),200);await expect(portal.locator('.auth-portal')).toBeVisible();
  await expect(portal.locator('.app-shell')).toHaveCount(0);
  await expect(portal.getByRole('heading',{name:'Your conversations.'})).toHaveCount(0);
  await expect.poll(()=>portalApiRequests.length).toBeGreaterThan(0);
  for(const request of portalApiRequests)assert.equal((await request.allHeaders()).cookie,undefined,'Portal API calls omit existing mailbox cookies');
  assert.equal((await context.cookies(clientOrigin)).find(cookie=>cookie.name==='phonemail_session')?.value,existingSession);
  await page.reload();await expect(page.getByRole('heading',{name:'Your conversations.'})).toBeVisible();
  assert.deepEqual(errors,[]);
  const portalRegistrationEnabled=await portal.locator('.auth-next').isEnabled();
  assert.equal(portalRegistrationEnabled,false,'Registration stays disabled until approved legal configuration exists');
  assert.equal(await portal.getByRole('option',{name:/தமிழ்/}).count(),0,'Unreviewed Tamil is not offered as a production interface language');
  await portal.locator('.ivr-registration summary').click();await expect(portal.locator('.ivr-registration')).toContainText('coming soon');await expect(portal.locator('a[href^="tel:"]')).toHaveCount(0);await expect(portal.getByRole('combobox',{name:'Interface language',exact:true})).toHaveValue('en');
  const summary={started,clientOrigin,portalOrigin,checks:['Container API proxy login returned cookie session and CSRF cookies','Settings profile update succeeded through cookie/CSRF proxy','SPA deep-link fallback served the authenticated app','Client and portal security headers, shell/API/portal cache policies, immutable gzip-compressed assets with Vary, and relative portal redirect verified','Portal API calls omit mailbox cookies in the same browser profile and preserve the existing mailbox login; registration stays gated without approved legal configuration','Actual service-worker startup cache contains the shell and excludes optional encryption, scanner, security, contacts and introduction chunks'],cachedShellPaths,portalRegistrationEnabled,ivrDefault:'unavailable; no dial link',interfaceLanguage:'English only',pageErrors:errors,limitations:['Packaged-browser acceptance against the configured local origins. The API must allow these origins; a nonstandard port alone does not prove that any proxy rewrites Origin. Physical devices, provider delivery and public TLS are outside this suite.']};
  summary.finished=new Date().toISOString();
  await writeFile('docs/packaged-ui-results.json',JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));
  await account.client.request('/api/auth/logout',{method:'POST'}).catch(()=>{});
}finally{await browser.close();}
