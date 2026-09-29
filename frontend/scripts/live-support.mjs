import { randomInt, randomUUID } from 'node:crypto';
export const base = process.env.API_ORIGIN || 'http://localhost:3000';
const transport = globalThis.fetch;
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('Live acceptance only targets an explicit local API.');
export function session() {
  const cookies = new Map();
  return {
    async response(path, options = {}) {
      const headers = new Headers(options.headers);
      headers.set('X-Auth-Transport', 'cookie');
      if (cookies.size) headers.set('Cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
      if (cookies.has('phonemail_csrf')) headers.set('X-CSRF-Token', cookies.get('phonemail_csrf'));
      let body = options.body;
      if (body !== undefined && typeof body !== 'string' && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(body); }
      const response = await transport(base + path, { ...options, headers, body, signal: options.signal || AbortSignal.timeout(25000) });
      for (const line of response.headers.getSetCookie()) { const pair = line.split(';')[0], i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
      return response;
    },
    async request(path, options = {}) {
      const response = await this.response(path, options);
      const data = response.status === 204 ? undefined : await response.json();
      if (!response.ok) { const error = new Error(`${options.method || 'GET'} ${path}: ${response.status} ${data?.error?.message || ''}`); error.status = response.status; error.code = data?.error?.code; throw error; }
      return data;
    },
  };
}
export async function register(name = 'Frontend acceptance') {
  // Fixtures remain available for inspection, so a previous run may own a number.
  // Only a definitive conflict permits picking another one; never reuse that account.
  for (let attempt = 0; attempt < 20; attempt++) {
    const client = session(); const password = 'Acceptance-' + randomUUID();
    const phone = '+1415555' + String(randomInt(0, 10_000)).padStart(4, '0');
    try {
      const result = await client.request('/api/auth/register', { method: 'POST', body: { phone, country: 'US', password, displayName: name, termsAccepted: true, termsVersion: 'mvp-1', signupChannel: 'web' } });
      return { client, user: result.user, password };
    } catch (error) {
      if (error.status !== 409 || error.code !== 'CONFLICT') throw error;
    }
  }
  throw new Error('Could not allocate a fresh disposable PhoneMail account after 20 conflicts');
}
