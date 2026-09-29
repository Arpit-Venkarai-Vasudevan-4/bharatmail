import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const { base } = integrationTargets();
const suffix = randomUUID().slice(0, 8);

async function request(path: string, init: RequestInit = {}, token?: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error?.message ?? "request failed"), { status: response.status, data });
  return data;
}

async function register(phone: string) {
  return request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone, password: "secret123", displayName: phone, language: "en", termsAccepted: true }),
  });
}

test("message identity, pagination, replies, recipient protection, concurrency, mailbox state, and aliases", async () => {
  const phones = await Promise.all(Array.from({ length: 4 }, () => randomTestPhone()));
  const a = await register(phones[0]);
  const b = await register(phones[1]);
  const c = await register(phones[2]);
  const d = await register(phones[3]);

  const conversation = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ participantPhones: [phones[1]] }),
  }, a.token);
  const id = conversation.conversation.id;

  let lastId = "";
  let firstId = "";
  for (let index = 0; index < 55; index += 1) {
    const result = await request(`/api/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ subject: index === 0 ? "first" : "", body: `message-${index}` }),
    }, a.token);
    lastId = result.message.id;
    if (index === 0) firstId = result.message.id;
  }
  let searchPage = await request("/api/search/messages?q=message-&limit=10", {}, a.token);
  const searchedIds = new Set<string>();
  while (true) {
    for (const message of searchPage.messages) searchedIds.add(message.id);
    if (!searchPage.hasMore) break;
    searchPage = await request(`/api/search/messages?q=message-&limit=10&cursor=${encodeURIComponent(searchPage.nextCursor)}`, {}, a.token);
  }
  assert.equal(searchedIds.size, 55);
  const latest = await request(`/api/conversations/${id}/messages?page=1&pageSize=50`, {}, a.token);
  assert.equal(latest.messages.length, 50);
  assert.equal(latest.messages.at(-1).id, lastId);
  assert.equal(latest.pagination.hasMore, true);
  const older = await request(`/api/conversations/${id}/messages?page=2&pageSize=50`, {}, a.token);
  assert.equal(older.messages.length, 5);
  assert.equal(new Set([...latest.messages, ...older.messages].map((message) => message.id)).size, 55);
  const legacyDraft = await request(`/api/conversations/${id}/messages`, {
    method: "POST", body: JSON.stringify({ body: "legacy private draft", folder: "drafts" }),
  }, a.token);
  const legacyDraftMailbox = await request("/api/conversations/mailbox/drafts?limit=20", {}, a.token);
  assert.ok(legacyDraftMailbox.messages.some((item: any) => item.id === legacyDraft.message.id && item.entityType === "message"));
  const privateDraftMailbox = await request("/api/conversations/mailbox/drafts?limit=20", {}, b.token);
  assert.ok(!privateDraftMailbox.messages.some((item: any) => item.id === legacyDraft.message.id));

  const reply = await request(`/api/conversations/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: "reply", inReplyToId: lastId }),
  }, b.token);
  assert.equal(reply.message.inReplyToId, lastId);
  await assert.rejects(
    request(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ body: "duplicate", inReplyToId: lastId }) }, b.token),
    (error: any) => error.status === 409,
  );
  const simultaneousReplies = await Promise.allSettled(Array.from({ length: 5 }, () =>
    request(`/api/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "concurrent reply", inReplyToId: firstId }),
    }, b.token),
  ));
  assert.equal(simultaneousReplies.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(simultaneousReplies.filter((result) => result.status === "rejected").length, 4);
  await assert.rejects(
    request(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ body: "tampered", to: [phones[2]] }) }, a.token),
    (error: any) => error.status === 400,
  );
  await assert.rejects(
    request(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ body: "cc tamper", cc: [phones[2]] }) }, a.token),
    (error: any) => error.status === 400,
  );
  await assert.rejects(
    request(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ body: "bcc unsupported", bcc: [phones[2]] }) }, a.token),
    (error: any) => error.status === 400 && error.data.error.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    request(`/api/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "legacy draft recipient tamper", folder: "drafts", to: [phones[2]] }),
    }, a.token),
    (error: any) => error.status === 400,
  );
  await assert.rejects(request(`/api/conversations/${id}`, {}, c.token), (error: any) => error.status === 404);

  const concurrent = await Promise.all(Array.from({ length: 5 }, () =>
    request("/api/conversations", { method: "POST", body: JSON.stringify({ participantPhones: [phones[1]] }) }, a.token),
  ));
  assert.equal(new Set(concurrent.map((item) => item.conversation.id)).size, 1);

  const aSent = await request("/api/conversations/mailbox/sent", {}, a.token);
  assert.ok(aSent.messages.some((message: any) => message.id === lastId));
  const bInbox = await request("/api/conversations/mailbox/inbox", {}, b.token);
  assert.ok(bInbox.messages.some((message: any) => message.id === lastId));
  const unreadConversations = await request("/api/conversations?filter=unread&limit=20", {}, b.token);
  assert.ok(unreadConversations.conversations.some((item: any) => item.id === id));
  await request(`/api/conversations/${id}/messages/${lastId}/state`, {
    method: "PATCH", body: JSON.stringify({ isFavorite: true }),
  }, b.token);
  const favoriteConversations = await request("/api/conversations?filter=favorites&limit=20", {}, b.token);
  assert.ok(favoriteConversations.conversations.some((item: any) => item.id === id));
  await request(`/api/conversations/${id}/messages/${lastId}/state`, {
    method: "PATCH", body: JSON.stringify({ folder: "archive" }),
  }, a.token);
  const aArchive = await request("/api/conversations/mailbox/archive", {}, a.token);
  assert.ok(aArchive.messages.some((message: any) => message.id === lastId));
  const bInboxAfterArchive = await request("/api/conversations/mailbox/inbox", {}, b.token);
  assert.ok(bInboxAfterArchive.messages.some((message: any) => message.id === lastId));

  await request(`/api/conversations/${id}/messages/${lastId}/state`, {
    method: "PATCH", body: JSON.stringify({ isFavorite: true, isRead: true, folder: "trash" }),
  }, b.token);
  const bTrash = await request("/api/conversations/mailbox/trash", {}, b.token);
  assert.ok(bTrash.messages.some((message: any) => message.id === lastId));
  const aTrash = await request("/api/conversations/mailbox/trash", {}, a.token);
  assert.ok(!aTrash.messages.some((message: any) => message.id === lastId));

  const group = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ participantPhones: [phones[1], phones[2]] }),
  }, a.token);
  const groupId = group.conversation.id;
  await request(`/api/conversations/${groupId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: "group original" }),
  }, a.token);
  const groupReply = await request(`/api/conversations/${groupId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: "group reply" }),
  }, b.token);
  assert.deepEqual(
    groupReply.message.recipients.map((recipient: any) => recipient.email).sort(),
    [a.user.email, c.user.email].sort(),
  );
  const forwarded = await request("/api/conversations", {
    method: "POST", body: JSON.stringify({ participantPhones: [phones[3]] }),
  }, b.token);
  assert.notEqual(forwarded.conversation.id, groupId);
  const forwardedMessage = await request(`/api/conversations/${forwarded.conversation.id}/messages`, {
    method: "POST", body: JSON.stringify({ subject: "Forwarded separately", body: "forward content" }),
  }, b.token);
  await assert.rejects(
    request(`/api/conversations/${groupId}/messages/${groupReply.message.id}`, {}, d.token),
    (error: any) => error.status === 404,
  );
  assert.notEqual(forwardedMessage.message.conversationId, groupId);

  await assert.rejects(
    request("/api/me/addresses", { method: "POST", body: JSON.stringify({ alias: phones[1] }) }, a.token),
    (error: any) => error.status === 400,
  );
  const alias = await request("/api/me/addresses", { method: "POST", body: JSON.stringify({ alias: `hello-world-${suffix}` }) }, a.token);
  assert.equal(alias.address.email, `hello-world-${suffix}@phonemail.com`);
  const disabledAlias = await request(`/api/me/addresses/${alias.address.id}`, {
    method: "PATCH", body: JSON.stringify({ active: false }),
  }, a.token);
  assert.equal(disabledAlias.address.isActive, false);
  await assert.rejects(
    request("/api/conversations", {
      method: "POST", body: JSON.stringify({ participantPhones: [alias.address.email] }),
    }, b.token),
    (error: any) => error.status === 404 || error.status === 403,
  );
  const enabledAlias = await request(`/api/me/addresses/${alias.address.id}`, {
    method: "PATCH", body: JSON.stringify({ active: true }),
  }, a.token);
  assert.equal(enabledAlias.address.isActive, true);
  await request(`/api/me/addresses/${alias.address.id}`, { method: "DELETE" }, a.token);
  const addresses = await request("/api/me/addresses", {}, a.token);
  assert.ok(!addresses.addresses.some((address: any) => address.id === alias.address.id));
});
