import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(await readFile('dist/.vite/manifest.json','utf8'));
const assets=new Set(['/index.html','/favicon.svg','/fonts.css']),seen=new Set();
function include(key){if(seen.has(key))return;seen.add(key);const item=manifest[key];if(!item)return;assets.add('/'+item.file);for(const css of item.css||[])assets.add('/'+css);for(const dependency of item.imports||[])include(dependency)}
// Only essential entry points are prefetched; optional features cache on actual use.
include('index.html');
for(const [key,item] of Object.entries(manifest))if(['Composer','AuthScreen'].includes(item.name))include(key);
const version=createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0,12);
const allowed=Object.values(manifest).flatMap(item=>['/'+item.file,...(item.css||[]).map(css=>'/'+css)]);
await writeFile('dist/sw.js',`const CACHE='phonemail-shell-${version}';const CORE=${JSON.stringify([...assets])};const ALLOWED=new Set(${JSON.stringify(allowed)});
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('phonemail-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const url=new URL(e.request.url);if(e.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.includes('portal'))return;
if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html')));return}
if(CORE.includes(url.pathname)||ALLOWED.has(url.pathname))e.respondWith(caches.open(CACHE).then(async cache=>{const existing=await cache.match(e.request);if(existing)return existing;const response=await fetch(e.request);if(response.ok)await cache.put(e.request,response.clone());return response}));});`);
await writeFile('docs/precache-manifest.json',JSON.stringify({version,core:[...assets],onDemand:allowed.filter(path=>!assets.has(path))},null,2));
