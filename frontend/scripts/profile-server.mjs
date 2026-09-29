/** Local production-build lab server. Instruments timing only; never logs account content. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
const root = path.resolve('dist'), port = Number(process.env.LAB_PORT || 8081);
const delay = Number(process.env.LAB_LATENCY_MS || 0), bytesPerSecond = Number(process.env.LAB_KBPS || 0) * 1024;
const api = process.env.API_PROXY_TARGET || 'http://localhost:3000';
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(api + req.url, { method: req.method, headers: { ...req.headers, host: new URL(api).host }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual' });
      res.statusCode = response.status;
      for (const [key, value] of response.headers) if (!['set-cookie', 'transfer-encoding', 'content-encoding', 'content-length'].includes(key)) res.setHeader(key, value);
      res.setHeader('Set-Cookie', response.headers.getSetCookie()); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    let filename = pathname === '/__labmetrics.js' ? path.resolve('tests/lab-metrics.js') : path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (pathname !== '/__labmetrics.js' && !filename.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    let data = await readFile(filename);
    if (filename.endsWith('.html')) data = Buffer.from(data.toString().replace('<head>', '<head><script src="/__labmetrics.js"></script>'));
    const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
    res.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
    res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.headers['accept-encoding']?.includes('gzip')) { data = gzipSync(data); res.setHeader('Content-Encoding', 'gzip'); }
    res.setHeader('Content-Length', data.length);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (bytesPerSecond) { for (let offset = 0; offset < data.length; offset += 16384) { const chunk = data.subarray(offset, offset + 16384); res.write(chunk); await new Promise(resolve => setTimeout(resolve, chunk.length / bytesPerSecond * 1000)); } res.end(); }
    else res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, 'localhost', () => console.log(JSON.stringify({ url: 'http://localhost:' + port, build: root, perResponseLatencyMs: delay, perResponseKiBPerSecond: bytesPerSecond / 1024, cpuThrottling: 'none' })));
