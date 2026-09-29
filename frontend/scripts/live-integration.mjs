const base = process.env.API_ORIGIN || 'http://localhost:3000';
function cookieJar() {
  const values = new Map();
  return {
    add(headers) { for (const line of headers.getSetCookie?.() ?? []) { const [pair] = line.split(';'); const i = pair.indexOf('='); if (i > 0) values.set(pair.slice(0, i), pair.slice(i + 1)); } },
    header() { return [...values].map(([k, v]) => `${k}=${v}`).join('; '); },
    csrf() { return values.get('phonemail_csrf') ?? ''; },
  };
}
async function request(jar, path, options = {}) {
  const headers = new Headers(options.headers); headers.set('Accept', 'application/json');
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (jar.header()) headers.set('Cookie', jar.header());
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method ?? 'GET').toUpperCase())) { headers.set('X-Auth-Transport', 'cookie'); if (jar.csrf()) headers.set('X-CSRF-Token', jar.csrf()); }
  const response = await fetch(`${base}${path}`, { ...options, headers }); jar.add(response.headers);
  const raw = response.clone(); const text = await response.text(); let data; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status} ${JSON.stringify(data)}`);
  return { response: raw, data };
}
function phone(suffix) { return `+1415555${String(suffix).padStart(4, '0')}`; }
async function register(suffix, name) { const jar = cookieJar(); const { data } = await request(jar, '/api/auth/register', { method: 'POST', headers: { 'X-Auth-Transport': 'cookie', 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phone(suffix), country: 'US', password: 'ChangeMe!12345', displayName: name, language: 'en', signupChannel: 'web', termsAccepted: true, termsVersion: 'mvp-1' }) }); return { jar, user: data.user }; }
async function run() {
  const live = await fetch(`${base}/live`); const ready = await fetch(`${base}/ready`); if (!live.ok || !ready.ok) throw new Error('backend readiness failed');
  const a = await register(Date.now() % 10000, 'Integration Alice'); const b = await register((Date.now() + 1) % 10000, 'Integration Bob');
  const get = (who, path) => request(who.jar, path);
  await get(a, '/api/auth/me');
  const preferences = await request(a.jar, '/api/me/preferences');
  await request(a.jar, '/api/me/preferences', { method: 'PATCH', body: JSON.stringify({ discoverable: false }) });
  await request(a.jar, '/api/me/preferences', { method: 'PATCH', body: JSON.stringify({ discoverable: true }) });
  const contact = await request(a.jar, '/api/me/contacts', { method: 'POST', body: JSON.stringify({ address: b.user.email, label: 'Integration Bob', notes: 'disposable' }) });
  const contacts = await get(a, '/api/me/contacts?limit=10');
  const confirmed = await request(a.jar, '/api/me/recipient-confirmation', { method: 'POST', body: JSON.stringify({ address: b.user.email }) });
  const draft = await request(a.jar, '/api/drafts', { method: 'POST', body: JSON.stringify({ to: [b.user.email], cc: [], subject: 'Integration draft', body: 'Draft before send.' }) });
  const draftId = draft.data.draft.id; const revision = draft.data.draft.revision;
  const updated = await request(a.jar, `/api/drafts/${draftId}`, { method: 'PATCH', headers: { 'If-Match': `"revision-${revision}"` }, body: JSON.stringify({ body: 'Updated draft body.' }) });
  let conflict = false; try { await request(a.jar, `/api/drafts/${draftId}`, { method: 'PATCH', headers: { 'If-Match': `"revision-${revision}"` }, body: JSON.stringify({ body: 'Stale writer.' }) }); } catch { conflict = true; }
  const conversationsBefore = await get(a, '/api/conversations?filter=all&limit=10');
  const sendKey = `live-integration-${crypto.randomUUID()}`;
  const sent = await request(a.jar, `/api/drafts/${draftId}/send`, { method: 'POST', headers: { 'If-Match': `"revision-${updated.data.draft.revision}"`, 'Idempotency-Key': sendKey }, body: JSON.stringify({}) });
  const conversationsAfter = await get(a, '/api/conversations?filter=all&limit=10');
  const bobConversations = await get(b, '/api/conversations?filter=all&limit=10');
  const conversationId = sent.data.message.conversationId;
  const detail = await get(b, `/api/conversations/${conversationId}?pageSize=20`);
  const message = detail.data.messages.at(-1);
  await request(b.jar, `/api/conversations/${conversationId}/messages/${message.id}/state`, { method: 'PATCH', body: JSON.stringify({ isRead: true, isFavorite: true }) });
  const search = await get(b, `/api/search/messages?q=${encodeURIComponent('Updated')}&limit=10`);
  const payload = Buffer.from('PhoneMail upload integration\n', 'utf8');
  const upload = await request(a.jar, '/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Expected-Bytes': String(payload.length), 'X-Filename': 'integration.txt' }, body: payload });
  const uploadId = upload.data.upload.id; const attachment = await get(a, `/api/uploads/${uploadId}`); const bytes = Buffer.from(await attachment.response.arrayBuffer());
  const result = { live: live.status, ready: ready.status, users: [a.user.email, b.user.email], auth: true, preferences: preferences.data.preferences, contactCreated: Boolean(contact.data.contact), contacts: contacts.data.contacts.length, recipientConfirmed: confirmed.data.available, draftRevision: updated.data.draft.revision, revisionConflict: conflict, conversationsBefore: conversationsBefore.data.conversations.length, sent: sent.response.status, aliceConversations: conversationsAfter.data.conversations.length, bobConversations: bobConversations.data.conversations.length, receivedBody: message.body, messageState: 'read+favorite', searchMatches: search.data.messages.length, uploadStatus: upload.data.upload.status, uploadBytes: bytes.length };
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
