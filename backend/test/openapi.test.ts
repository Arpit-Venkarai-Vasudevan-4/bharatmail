import assert from "node:assert/strict";
import test from "node:test";
import spec from "../openapi.json";

test("OpenAPI contract contains implemented core routes", () => {
  for (const path of [
    "/health", "/live", "/ready", "/api/capabilities", "/api/auth/register", "/api/auth/login",
    "/api/auth/logout", "/api/auth/refresh", "/api/auth/me", "/api/auth/otp/register", "/api/auth/otp/login",
    "/api/auth/phone-change", "/api/otp/request", "/api/otp/verify", "/api/otp/webhook",
    "/api/me/security-events", "/api/me/security-events/{id}/read",
    "/api/otp/capabilities", "/api/telecom/capabilities", "/api/telecom/sms/inbound",
    "/api/telecom/ivr/inbound", "/api/telecom/ivr/decision", "/api/telecom/messaging/status",
    "/api/conversations", "/api/conversations/{conversationId}", "/api/conversations/mailbox/{folder}",
    "/api/conversations/operations/{key}", "/api/conversations/{conversationId}/messages",
    "/api/conversations/{conversationId}/messages/{messageId}",
    "/api/conversations/{conversationId}/messages/{messageId}/delivery",
    "/api/conversations/{conversationId}/messages/{messageId}/state", "/api/search/messages", "/api/drafts",
    "/api/drafts/{id}/send", "/api/mail/compose", "/api/mail/reply",
    "/api/e2ee/reauth", "/api/e2ee/key-challenges", "/api/e2ee/keys", "/api/e2ee/keys/{userId}", "/api/e2ee/keys/{userId}/history", "/api/e2ee/keys/current",
    "/api/e2ee/messages", "/api/e2ee/messages/{id}", "/api/e2ee/drafts", "/api/e2ee/drafts/{id}", "/api/e2ee/drafts/{id}/send",
    "/api/sync", "/api/sync/snapshot", "/api/sync/snapshot/{id}/close", "/api/me", "/api/me/addresses",
    "/api/me/addresses/{id}", "/api/me/contacts", "/api/me/contacts/{id}",
    "/api/me/blocks", "/api/me/blocks/{userId}", "/api/me/preferences", "/api/me/app-presence",
    "/api/me/recipient-confirmation", "/api/me/profile-picture", "/api/users/{id}/profile-picture",
    "/api/uploads", "/api/uploads/{id}/status", "/api/uploads/{id}", "/api/uploads/{id}/attach",
  ]) {
    assert.ok(spec.paths[path], `missing ${path}`);
  }
  assert.equal(spec.openapi, "3.0.3");
  assert.deepEqual(spec.paths["/api/auth/refresh"].post.security, [{ refreshCookie: [] }, {}]);
  assert.ok(spec.paths["/api/auth/refresh"].post.parameters.some((parameter) => parameter.$ref === "#/components/parameters/CsrfToken"));
  assert.equal(spec.components.securitySchemes.refreshCookie.name, "phonemail_refresh");
  assert.match(spec.paths["/api/auth/refresh"].post.description, /90 seconds/);
  assert.ok(spec.paths["/api/drafts/{id}/send"].post.parameters.some((parameter) => parameter.$ref === "#/components/parameters/IfMatchRequired"));
  assert.equal(spec.components.parameters.IfMatchRequired.required, true);
  assert.equal(spec.components.parameters.IdempotencyKeyRequired.required, true);
  for (const path of ["/api/mail/compose", "/api/mail/reply"]) {
    assert.deepEqual(spec.paths[path].post.security, [{ bearerAuth: [] }, { sessionCookie: [] }]);
    assert.ok(spec.paths[path].post.parameters.some((parameter) => parameter.$ref === "#/components/parameters/IdempotencyKeyRequired"));
    assert.ok(spec.paths[path].post.responses["201"]);
  }
  for (const path of ["/api/e2ee/messages", "/api/e2ee/drafts/{id}/send"]) {
    assert.deepEqual(spec.paths[path].post.security, [{ bearerAuth: [] }, { sessionCookie: [] }]);
    assert.ok(spec.paths[path].post.parameters.some((parameter) => parameter.$ref === "#/components/parameters/IdempotencyKeyRequired"));
  }
  assert.match(spec.paths["/api/e2ee/messages"].post.description, /sender public key/);
  assert.match(spec.paths["/api/e2ee/messages"].post.description, /ciphertext size remain visible/);
  assert.match(spec.paths["/api/e2ee/messages"].post.description, /never queued for SMTP/);
  assert.match(spec.info.description, /No decrypted server-side search index/);
  assert.match(spec.info.description, /private keys and plaintext stay client-side/);
  assert.equal(spec.components.requestBodies.DraftSend.content["application/json"].schema.required, undefined);
  assert.equal(spec.components.requestBodies.DraftSend.content["application/json"].schema.properties.conversationId.description.includes("Optional"), true);
  assert.ok(spec.components.schemas.DeliveryStatus.properties.recipients.items.properties.status.enum.includes("relay_accepted"));
  assert.ok(spec.components.schemas.DeliveryStatus.properties.recipients.items.properties.status.enum.includes("acceptance_unknown"));
  assert.equal(spec.components.schemas.SyncSnapshotPage.properties.watermark.type, "string");
  assert.equal(spec.components.schemas.SyncSnapshotPage.properties.totalRecords.type, "string");
  assert.deepEqual(spec.components.schemas.UploadStatus.properties.scannerState.enum, ["unscanned", "pending", "clean", "rejected"]);
  assert.equal(spec.components.schemas.ErrorEnvelope.properties.error.properties.requestId.type, "string");
  assert.equal(spec.paths["/api/telecom/sms/inbound"].post.parameters[0].$ref, "#/components/parameters/TwilioSignature");
});

test("OpenAPI references and templated path parameters resolve", () => {
  const resolveReference = (ref: string) => ref.slice(2).split("/").reduce<unknown>((current, key) => {
    return current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }, spec);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string" && object.$ref.startsWith("#/")) {
      assert.notEqual(resolveReference(object.$ref), undefined, `unresolved ${object.$ref}`);
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(spec);

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const required = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const pathParameters = pathItem.parameters ?? [];
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const parameters = [...pathParameters, ...(operation.parameters ?? [])];
      for (const name of required) {
        assert.ok(parameters.some((parameter) => {
          const resolved = "$ref" in parameter ? resolveReference(parameter.$ref) : parameter;
          if (!resolved || typeof resolved !== "object") return false;
          const item = resolved as { in?: string; name?: string; required?: boolean };
          return item.in === "path" && item.name === name && item.required === true;
        }), `${method.toUpperCase()} ${path} is missing path parameter ${name}`);
      }
    }
  }
});
