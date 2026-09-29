import { isSupportedCountry } from "libphonenumber-js/min";
import { parsePhone } from "./phone";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export type AuthMethod = "password" | "otp";
export type MailTransportMode = "disabled" | "file" | "smtp";

function positiveInteger(name: string, value: string | undefined, fallback: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

const phoneDefaultCountry = (process.env.PHONE_DEFAULT_COUNTRY ?? "").trim().toUpperCase();
if (phoneDefaultCountry && (!/^[A-Z]{2}$/.test(phoneDefaultCountry) || !isSupportedCountry(phoneDefaultCountry))) {
  throw new Error("PHONE_DEFAULT_COUNTRY must be a supported two-letter region code");
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  accessTokenTtl: "15m",
  sessionRenewalTtl: "30 days",
  sessionRenewalMs: 30 * 24 * 60 * 60 * 1000,
  phoneDefaultCountry,
  mailDomain: (process.env.MAIL_DOMAIN ?? "phonemail.com").toLowerCase(),
  authMethod: (process.env.AUTH_METHOD ?? "password") as AuthMethod,
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:8080,http://localhost:8081",
  cookieSecure: process.env.COOKIE_SECURE === "true" || (process.env.NODE_ENV ?? "development") === "production",
  sessionCookieName: "phonemail_session",
  refreshCookieName: "phonemail_refresh",
  csrfCookieName: "phonemail_csrf",
  poolMax: Number(process.env.DB_POOL_MAX) || 10,
  statementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 10000,
  lockTimeoutMs: Number(process.env.DB_LOCK_TIMEOUT_MS) || 5000,
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  localMailDir: process.env.LOCAL_MAIL_DIR ?? "./local-mail",
  mailTransportMode: (process.env.MAIL_TRANSPORT_MODE ?? "disabled") as MailTransportMode,
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: positiveInteger("SMTP_PORT", process.env.SMTP_PORT, 587, 65535),
    tlsMode: process.env.SMTP_TLS_MODE ?? "starttls",
    secure: process.env.SMTP_TLS_MODE === "implicit",
    requireTls: (process.env.SMTP_TLS_MODE ?? "starttls") !== "plain",
    username: process.env.SMTP_USERNAME ?? "",
    password: process.env.SMTP_PASSWORD ?? "",
    timeoutMs: positiveInteger("SMTP_TIMEOUT_MS", process.env.SMTP_TIMEOUT_MS, 10000, 60000),
    maxConnections: positiveInteger("SMTP_MAX_CONNECTIONS", process.env.SMTP_MAX_CONNECTIONS, 2, 10),
    maxMessageBytes: positiveInteger("SMTP_MAX_MESSAGE_BYTES", process.env.SMTP_MAX_MESSAGE_BYTES, 10 * 1024 * 1024, 20 * 1024 * 1024),
    inboundEnabled: process.env.SMTP_INBOUND_ENABLED === "true",
    inboundHost: process.env.SMTP_INBOUND_HOST ?? "127.0.0.1",
    inboundPort: positiveInteger("SMTP_INBOUND_PORT", process.env.SMTP_INBOUND_PORT, 2525, 65535),
    inboundMaxClients: positiveInteger("SMTP_INBOUND_MAX_CLIENTS", process.env.SMTP_INBOUND_MAX_CLIENTS, 20, 100),
    inboundAuthUser: process.env.SMTP_INBOUND_AUTH_USER ?? "",
    inboundAuthPassword: process.env.SMTP_INBOUND_AUTH_PASSWORD ?? "",
    inboundTrustedPeers: (process.env.SMTP_INBOUND_TRUSTED_PEERS ?? "").split(",").map((peer) => peer.trim()).filter(Boolean),
    inboundTlsKey: process.env.SMTP_INBOUND_TLS_KEY ?? "",
    inboundTlsCert: process.env.SMTP_INBOUND_TLS_CERT ?? "",
  },
  uploadQuotaBytes: Number(process.env.UPLOAD_QUOTA_BYTES) || 50 * 1024 * 1024,
  uploadConcurrentLimit: Number(process.env.UPLOAD_CONCURRENT_LIMIT) || 3,
  outboxWorkerEnabled: process.env.OUTBOX_WORKER_ENABLED !== "false",
  outboxWorkerIntervalMs: Number(process.env.OUTBOX_WORKER_INTERVAL_MS) || 5000,
  outboxMaxAttempts: positiveInteger("OUTBOX_MAX_ATTEMPTS", process.env.OUTBOX_MAX_ATTEMPTS, 8, 20),
  outboxMaxRetryDelayMs: positiveInteger("OUTBOX_MAX_RETRY_DELAY_MS", process.env.OUTBOX_MAX_RETRY_DELAY_MS, 3_600_000, 86_400_000),
  outboxLeaseMs: positiveInteger("OUTBOX_LEASE_MS", process.env.OUTBOX_LEASE_MS, 300_000, 600_000),
  maintenanceIntervalMs: Number(process.env.MAINTENANCE_INTERVAL_MS) || 60_000,
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    phoneNumber: process.env.TWILIO_PHONE_NUMBER ?? "",
    verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID ?? "",
    apiKeySid: process.env.TWILIO_API_KEY_SID ?? "",
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET ?? "",
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? "",
    approvedTemplateSid: process.env.TWILIO_APPROVED_TEMPLATE_SID ?? "",
    publicUrl: process.env.TWILIO_PUBLIC_URL ?? "",
    timeoutMs: Number(process.env.TWILIO_TIMEOUT_MS) || 5000,
  },
  otpProvider: process.env.OTP_PROVIDER ?? "local",
  otp: {
    ttlMs: Number(process.env.OTP_TTL_MS) || 5 * 60 * 1000,
    resendCooldownMs: Number(process.env.OTP_RESEND_COOLDOWN_MS) || 30 * 1000,
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS) || 5,
    codeHashSecret: process.env.OTP_CODE_HASH_SECRET ?? process.env.JWT_SECRET ?? "",
    webhookSecret: process.env.OTP_WEBHOOK_SECRET ?? process.env.JWT_SECRET ?? "",
    webhookToleranceMs: Number(process.env.OTP_WEBHOOK_TOLERANCE_MS) || 5 * 60 * 1000,
  },
};

if (!["disabled", "file", "smtp"].includes(config.mailTransportMode)) {
  throw new Error("MAIL_TRANSPORT_MODE must be disabled, file, or smtp");
}
if (!["starttls", "implicit", "plain"].includes(config.smtp.tlsMode)) {
  throw new Error("SMTP_TLS_MODE must be starttls, implicit, or plain");
}
if (config.mailTransportMode === "smtp" && config.smtp.tlsMode === "plain" && config.nodeEnv !== "development") {
  throw new Error("SMTP_TLS_MODE=plain is only permitted in the isolated local test environment");
}
if (config.mailTransportMode === "smtp" && !config.smtp.host) {
  throw new Error("MAIL_TRANSPORT_MODE=smtp requires SMTP_HOST");
}
if (config.outboxLeaseMs < config.smtp.timeoutMs * 4) {
  throw new Error("OUTBOX_LEASE_MS must be at least four times SMTP_TIMEOUT_MS");
}
if (Boolean(config.smtp.username) !== Boolean(config.smtp.password)) {
  throw new Error("SMTP_USERNAME and SMTP_PASSWORD must be configured together");
}
if (config.smtp.secure && config.smtp.port !== 465) {
  throw new Error("SMTP_TLS_MODE=implicit requires the implicit-TLS port 465");
}
if (config.smtp.inboundEnabled) {
  if (config.nodeEnv === "production") {
    if (!config.smtp.inboundTrustedPeers.length || !config.smtp.inboundAuthUser || !config.smtp.inboundAuthPassword ||
        !config.smtp.inboundTlsKey || !config.smtp.inboundTlsCert) {
      throw new Error("Production inbound SMTP requires trusted peers, AUTH credentials, and TLS key/certificate files");
    }
    if (config.smtp.inboundHost === "0.0.0.0" || config.smtp.inboundHost === "::") {
      throw new Error("Production inbound SMTP must bind a restricted interface behind a trusted gateway");
    }
  }
  if (Boolean(config.smtp.inboundTlsKey) !== Boolean(config.smtp.inboundTlsCert)) {
    throw new Error("SMTP_INBOUND_TLS_KEY and SMTP_INBOUND_TLS_CERT must be configured together");
  }
}

for (const [name, value] of Object.entries({
  PORT: config.port,
  DB_POOL_MAX: config.poolMax,
  DB_STATEMENT_TIMEOUT_MS: config.statementTimeoutMs,
  DB_LOCK_TIMEOUT_MS: config.lockTimeoutMs,
  OUTBOX_WORKER_INTERVAL_MS: config.outboxWorkerIntervalMs,
  MAINTENANCE_INTERVAL_MS: config.maintenanceIntervalMs,
  OTP_TTL_MS: config.otp.ttlMs,
  OTP_RESEND_COOLDOWN_MS: config.otp.resendCooldownMs,
  OTP_MAX_ATTEMPTS: config.otp.maxAttempts,
  UPLOAD_QUOTA_BYTES: config.uploadQuotaBytes,
  UPLOAD_CONCURRENT_LIMIT: config.uploadConcurrentLimit,
})) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

if (config.authMethod !== "password" && config.authMethod !== "otp") {
  throw new Error("AUTH_METHOD must be 'password' or 'otp'");
}
if (config.otpProvider !== "local" && config.otpProvider !== "twilio") {
  throw new Error("OTP_PROVIDER must be 'local' or 'twilio'");
}
if (config.twilio.timeoutMs > 10_000) {
  throw new Error("TWILIO_TIMEOUT_MS must not exceed 10000");
}
const twilioVerifyCredentials = Boolean(
  config.twilio.accountSid && config.twilio.authToken ||
  config.twilio.apiKeySid && config.twilio.apiKeySecret,
);
if (config.otpProvider === "twilio" && (!config.twilio.verifyServiceSid || !twilioVerifyCredentials)) {
  throw new Error("OTP_PROVIDER=twilio requires TWILIO_VERIFY_SERVICE_SID and complete Twilio credentials");
}
const messagingRequested = Boolean(
  config.twilio.phoneNumber || config.twilio.messagingServiceSid || config.twilio.approvedTemplateSid,
);
if (messagingRequested && (!config.twilio.accountSid || !twilioVerifyCredentials || !config.twilio.publicUrl)) {
  throw new Error("Twilio Messaging requires TWILIO_ACCOUNT_SID, complete credentials, a sender/service, and TWILIO_PUBLIC_URL");
}
if (config.twilio.publicUrl && config.twilio.accountSid && !config.twilio.authToken) {
  throw new Error("Twilio webhooks require TWILIO_AUTH_TOKEN for X-Twilio-Signature validation");
}
if (config.twilio.phoneNumber) {
  try {
    parsePhone(config.twilio.phoneNumber);
  } catch {
    throw new Error("TWILIO_PHONE_NUMBER must be a valid E.164 number");
  }
}
if (config.twilio.messagingServiceSid && !/^MG[0-9a-fA-F]{32}$/.test(config.twilio.messagingServiceSid)) {
  throw new Error("TWILIO_MESSAGING_SERVICE_SID is invalid");
}
if (config.twilio.approvedTemplateSid && !/^HX[0-9a-fA-F]{32}$/.test(config.twilio.approvedTemplateSid)) {
  throw new Error("TWILIO_APPROVED_TEMPLATE_SID is invalid");
}
if (config.twilio.publicUrl) {
  let publicUrl: URL;
  try {
    publicUrl = new URL(config.twilio.publicUrl);
  } catch {
    throw new Error("TWILIO_PUBLIC_URL must be an absolute URL");
  }
  if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password ||
      publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("TWILIO_PUBLIC_URL must be an origin without credentials, path, query, or fragment");
  }
  if (config.nodeEnv !== "development" && publicUrl.protocol !== "https:") {
    throw new Error("TWILIO_PUBLIC_URL must use HTTPS outside development");
  }
}
if (config.nodeEnv !== "development" && config.otpProvider === "local") {
  throw new Error("Local OTP provider is not permitted outside development");
}
if (config.nodeEnv !== "development" && (
  config.jwtSecret === "change-me-in-production" ||
  config.jwtSecret === "local-development-secret-change-this-32chars" ||
  config.jwtSecret.length < 32
)) {
  throw new Error("JWT_SECRET must be a strong environment secret outside local development");
}
