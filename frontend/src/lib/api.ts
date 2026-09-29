import {t} from '../i18n';
/** Cookie transport for the mailbox; the registration portal has a separate bearer transport. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public data?: unknown, public retryAfter = 0) {
    super(message); this.name = 'ApiError';
  }
}

export type ApiOptions = Omit<RequestInit, 'body' | 'credentials'> & {
  body?: unknown; auth?: boolean; refresh?: boolean; timeout?: number;
};
export type SessionState = 'unknown' | 'checking' | 'authenticated' | 'invalid';
type Reachability='unknown'|'reachable'|'unreachable';
let reachability:Reachability='unknown';
const reachListeners=new Set<()=>void>();
export const getReachability=()=>reachability;
export const subscribeReachability=(listener:()=>void)=>{reachListeners.add(listener);return()=>reachListeners.delete(listener)};
function reached(value:Reachability){reachability=value;reachListeners.forEach(fn=>fn())}
if(typeof window!=='undefined')window.addEventListener('online',()=>reached('unknown'));
let sessionState: SessionState = 'unknown';
let boundAccount: string | undefined;
export function bindAccount(id?: string) { boundAccount = id; channel?.postMessage({ type: 'account', accountId: id }); }
let accountChangePending = false;
export function setAccountChangePending(value: boolean) { accountChangePending = value; }
const listeners = new Set<(state: SessionState) => void>();
let refreshPromise: Promise<void> | undefined;
const EPOCH_KEY = 'phonemail.refresh.epoch.v1';
let memoryEpoch = '';
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('phonemail.session.v1') : null;
channel?.addEventListener('message', (event: MessageEvent<{ type: string; epoch?: string; accountId?: string }>) => {
  if (event.data?.type === 'account' && boundAccount && event.data.accountId !== boundAccount) setSessionState('invalid', false);
  if (event.data?.type === 'renewed') { memoryEpoch = event.data.epoch ?? ''; if (!boundAccount || event.data.accountId === boundAccount) setSessionState('authenticated', false); else setSessionState('invalid', false); }
  if (event.data?.type === 'invalid') setSessionState('invalid', false);
});

export function setSessionState(state: SessionState, broadcast = true): void {
  sessionState = state;
  listeners.forEach(listener => listener(state));
  if (broadcast && state === 'invalid') channel?.postMessage({ type: 'invalid' });
}
export function getSessionState(): SessionState { return sessionState; }
export function subscribeSession(listener: (state: SessionState) => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const value = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('phonemail_csrf='));
  try { return value ? decodeURIComponent(value.slice('phonemail_csrf='.length)) : ''; } catch { return ''; }
}
function epoch(): string {
  try { return localStorage.getItem(EPOCH_KEY) ?? memoryEpoch; } catch { return memoryEpoch; }
}
function apiPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new Error(t("m_38ec3eb0503e"));
  return path.startsWith('/api/') || path === '/api' ? path : `/api${path}`;
}
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0;
}
async function asError(response: Response): Promise<ApiError> {
  const data = await response.json().catch(() => undefined) as { error?: string | { message?: string; code?: string; fields?: { retryAfter?: string } }; message?: string; code?: string } | undefined;
  const detail = typeof data?.error === 'object' ? data.error : undefined;
  const code=detail?.code ?? data?.code ?? `HTTP_${response.status}`;
  const message=apiErrorText(code,response.status);
  return new ApiError(response.status, code, message, data,
    Math.max(retryAfterMs(response.headers.get('Retry-After')), retryAfterMs(detail?.fields?.retryAfter ?? null)));
}
/** Never render backend prose directly: public error codes map to reviewed catalog messages. */
export function apiErrorText(code:string,status=0):string {
  const otp:Record<string,Parameters<typeof t>[0]>={OTP_INVALID:'otp.invalid',OTP_EXPIRED:'otp.expired',OTP_ATTEMPTS_EXCEEDED:'otp.attempts',OTP_RESEND_COOLDOWN:'otp.cooldown'};if(otp[code])return t(otp[code]);
  const input=new Set(['VALIDATION_ERROR','INVALID_CURSOR','INVALID_RANGE','PHONE_INVALID','PHONE_COUNTRY_INVALID','PHONE_COUNTRY_REQUIRED','EMAIL_INVALID','TERMS_VERSION_MISMATCH','PRECONDITION_REQUIRED','PAYLOAD_TOO_LARGE']);
  const auth=new Set(['UNAUTHORIZED','AUTH_TRANSPORT_CONFLICT','SESSION_REJECTED','SESSION_EXPIRED']);
  const forbidden=new Set(['FORBIDDEN','CSRF_INVALID','ADDRESS_UNAVAILABLE']);
  const missing=new Set(['NOT_FOUND']);
  const changed=new Set(['CONFLICT','REVISION_CONFLICT','ALREADY_REPLIED','RECIPIENTS_LOCKED','IDEMPOTENCY_CONFLICT','IDEMPOTENCY_EXPIRED','OTP_STATE_CONFLICT','KEY_CHALLENGE_INVALID','KEY_ALREADY_REGISTERED','UPLOAD_OFFSET_CONFLICT']);
  const service=new Set(['CAPABILITY_UNAVAILABLE','INTERNAL_ERROR','RATE_LIMITED','OTP_PROVIDER_MISMATCH','OTP_PURPOSE_INVALID','OTP_OPERATION_MISMATCH','WEBHOOK_CONFLICT','WEBHOOK_INVALID']);
  const upload=new Set(['ATTACHMENT_INVALID','UPLOAD_QUOTA_EXCEEDED','UPLOAD_SIZE_MISMATCH','UPLOAD_STORAGE_MISMATCH']);
  const identity=new Set(['KEY_INVALID','KEY_PROOF_INVALID','E2EE_KEY_REQUIRED','E2EE_KEY_CHANGED','E2EE_RECIPIENT_MISMATCH']);
  const codeKey=input.has(code)?'m_5165840170d0':auth.has(code)?'m_30bab2b29782':forbidden.has(code)?'m_bbc061f9344f':missing.has(code)?'m_ffa44dd1ed15':changed.has(code)?'m_8c2bfd9723ed':service.has(code)?'m_a7412509ef7a':upload.has(code)?'m_f959d17e6d67':identity.has(code)?'m_d94326f17863':code.startsWith('OTP_')?'m_1367aab05945':code.startsWith('PHONE_')||code.startsWith('ADDRESS_')?'m_b0ace78d181a':code==='RECIPIENT_UNAVAILABLE'?'m_d60d0a818c0f':code==='MESSAGE_TOO_LARGE'?'m_249ac92a64f9':code==='PROFILE_IMAGE_INVALID'?'m_23a24e792456':status===401?'m_da64d3e8235f':status>=500?'m_a7412509ef7a':'m_aec6e94a5c89';
  return t(codeKey);
}
function isRawBody(body: unknown): body is BodyInit {
  return typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof FormData || body instanceof URLSearchParams;
}
async function request(path: string, options: ApiOptions, bearer?: string, portal = false): Promise<Response> {
  const { body, auth: _auth, refresh: _refresh, timeout = 25_000, signal, ...init } = options;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (portal) {
    headers.delete('X-Auth-Transport'); headers.delete('X-CSRF-Token'); headers.delete('Authorization');
    if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
  } else {
    if (headers.has('Authorization')) throw new Error(t("m_3a68dd70492d"));
    headers.set('X-Auth-Transport', 'cookie');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) {
      const csrf = csrfToken(); if (csrf) headers.set('X-CSRF-Token', csrf);
    }
  }
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    payload = isRawBody(body) ? body : JSON.stringify(body);
    if ((!isRawBody(body) || typeof body === 'string') && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException(t("m_e7a50435a351"), 'TimeoutError')), timeout);
  try {
    const response=await fetch(apiPath(path), { ...init, headers, body: payload, signal: controller.signal, credentials: portal ? 'omit' : 'same-origin', cache: 'no-store', redirect: 'error' });reached('reachable');return response;
  } catch (error) {
    if (signal?.aborted) throw error;
    reached('unreachable');
    throw new ApiError(0, controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_UNAVAILABLE', controller.signal.aborted ? t("m_bda9b6414f47") : t("m_ae324f85c7f7"));
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Web Locks serializes refresh/outbox across tabs. Without it, decline unsafe concurrency. */
export async function withBrowserLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(`phonemail:${name}`, task);
  throw new ApiError(0, 'COORDINATION_UNAVAILABLE', t("m_0f0d3f99e098"));
}
async function renew(previousEpoch: string): Promise<void> {
  if (!refreshPromise) refreshPromise = withBrowserLock('session-refresh', async () => {
    if (epoch() !== previousEpoch && sessionState !== 'invalid') return;
    const response = await request('/auth/refresh', { method: 'POST', body: {}, timeout: 20_000 });
    if (!response.ok) {
      const error = await asError(response);
      if (response.status === 401) setSessionState('invalid');
      throw error;
    }
    const renewed = await response.json() as { user?: { id: string } };
    if (boundAccount && renewed.user?.id !== boundAccount) {
      setSessionState('invalid');
      throw new ApiError(401, 'ACCOUNT_CHANGED', t("m_a4686a0fadab"));
    }
    memoryEpoch = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    try { localStorage.setItem(EPOCH_KEY, memoryEpoch); } catch { /* Web Locks remains available without storage. */ }
    setSessionState('authenticated'); channel?.postMessage({ type: 'renewed', epoch: memoryEpoch, accountId: renewed.user?.id });
  }).finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}
export async function apiResponse(path: string, options: ApiOptions = {}): Promise<Response> {
  if (options.auth !== false && sessionState === 'checking') throw new ApiError(0, 'SESSION_CHECKING', t("m_eec1a3564cf0"));
  if (options.auth !== false && sessionState === 'invalid') throw new ApiError(401, 'SESSION_REJECTED', t("m_993f9dce71ab"));
  if (accountChangePending && options.auth !== false) throw new ApiError(0, 'ACCOUNT_CHANGE_PENDING', t("m_d09f9843f42d"));
  const before = epoch();
  let response = await request(path, options);
  if (response.status === 401 && options.auth !== false && options.refresh !== false && !apiPath(path).startsWith('/api/auth/')) {
    await renew(before);
    response = await request(path, options);
    if (response.status === 401) setSessionState('invalid');
  } else if (response.status === 401 && apiPath(path) === '/api/auth/me' && options.refresh !== false && options.auth !== false) {
    await renew(before); response = await request(path, options);
    if (response.status === 401) setSessionState('invalid');
  }
  if (!response.ok) throw await asError(response);
  return response;
}
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await apiResponse(path, options);
  return response.status === 204 ? undefined as T : await response.json() as T;
}
/** Portal tokens stay in caller memory; credentials:omit also ignores Set-Cookie on logout. */
export async function portalApi<T = unknown>(path: string, options: ApiOptions = {}, token?: string): Promise<T> {
  const response = await request(path, options, token, true);
  if (!response.ok) throw await asError(response);
  return response.status === 204 ? undefined as T : await response.json() as T;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : t("m_3ccd9d6586ef"); }
