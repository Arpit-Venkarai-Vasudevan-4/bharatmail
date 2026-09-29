import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { requireAuth } from "./auth/middleware";
import { config } from "./config";
import { pool } from "./db";
import { HttpError, isDependencyUnavailableError } from "./httpError";
import { randomUUID } from "node:crypto";
import { runMigrations } from "./migrate";
import { authRouter } from "./routes/auth";
import { conversationsRouter } from "./routes/conversations";
import { meRouter } from "./routes/me";
import { stage2Router } from "./routes/stage2";
import { uploadsRouter } from "./routes/uploads";
import { otpRouter } from "./routes/otp";
import { telecomRouter } from "./routes/telecom";
import { mailRouter } from "./routes/mail";
import { e2eeRouter } from "./routes/e2ee";
import { startOutboxWorker } from "./outboxWorker";
import { processMessageNotification, telecomCapabilities } from "./services/telecomService";
import { runMaintenance } from "./maintenance";
import { outboxStatusCounts } from "./outbox";
import { closeAllStreamingSnapshots } from "./services/stage2Service";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createConfiguredMailTransport, type MailTransport } from "./transport";
import { processSmtpDelivery, startInboundSmtpServer } from "./services/smtpService";

const app = express();
let ready = false;
const requestCounts = new Map<string, number>();
let smtpListenerAvailable = false;
let smtpRelayReachable: boolean | null = null;

const allowedOrigins = config.corsOrigin.split(",").map((v) => v.trim()).filter(Boolean);
app.use((req, res, next) => {
  const requestId = typeof req.header("X-Request-ID") === "string" && /^[\x20-\x7e]{8,128}$/.test(req.header("X-Request-ID")!)
    ? req.header("X-Request-ID")!
    : randomUUID();
  res.setHeader("X-Request-ID", requestId);
  const startedAt = Date.now();
  res.once("finish", () => {
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    const key = `${req.method}:${statusClass}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
    console.info(JSON.stringify({
      level: "info",
      event: "http_request",
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }));
  });
  next();
});
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new HttpError(403, "Origin is not allowed", "FORBIDDEN"));
  },
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-Auth-Transport", "X-CSRF-Token", "Idempotency-Key", "If-Match", "If-None-Match", "X-Request-ID", "X-Filename", "X-Expected-Bytes", "X-Upload-Mode", "X-Upload-Offset", "Range"],
  exposedHeaders: ["Retry-After", "X-Request-ID", "ETag", "Content-Range", "Content-Length", "Content-Disposition", "Accept-Ranges"],
}));
app.use(express.json({
  limit: "16mb",
  verify: (req, _res, buffer) => {
    if (!(req.url ?? "").startsWith("/api/e2ee/") && buffer.length > 64 * 1024) {
      throw new HttpError(413, "Request body exceeds the 64 KiB limit", "PAYLOAD_TOO_LARGE");
    }
  },
}));
app.disable("etag");

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      service: "phonemail-api",
      authMethod: config.authMethod,
      mailDomain: config.mailDomain,
    });

  } catch {
    res.status(503).json({ status: "degraded", service: "phonemail-api" });
  }
});

app.get("/live", (_req, res) => {
  res.json({ status: "live", service: "phonemail-api" });
});

app.get("/ready", (_req, res) => {
  if (!ready) {
    res.status(503).json({ status: "starting", service: "phonemail-api" });
    return;
  }
  Promise.all([
    pool.query("SELECT 1"),
    access(config.storageDir, constants.R_OK | constants.W_OK),
  ]).then(() => res.json({ status: "ready", service: "phonemail-api" }))
    .catch(() => res.status(503).json({ status: "not_ready", service: "phonemail-api" }));
});
app.get("/api/capabilities", (_req, res) => {
  res.json({
    auth: { password: true, otp: true, cookieSessions: true, bearerSessions: true },
    messaging: { attachments: true, idempotency: true, pagination: true, sync: true, e2ee: true, folders: ["inbox", "sent", "drafts", "trash", "archive", "spam"] },
    integrations: {
      ...telecomCapabilities(),
      smtp: config.mailTransportMode === "smtp",
      mailTransport: {
        mode: config.mailTransportMode,
        configured: config.mailTransportMode !== "disabled",
        listenerEnabled: config.smtp.inboundEnabled,
        listenerAvailable: smtpListenerAvailable,
        relayReachable: smtpRelayReachable,
      },
      provider: config.otpProvider === "twilio" ? "twilio_verify" : "local_mock",
      localMailHarness: false,
      outboxWorker: config.outboxWorkerEnabled,
    },
    limits: { pageSizeMax: 100, recipientMax: 50, messageBodyMax: 100000 },
  });
});

app.get("/metrics", async (_req, res, next) => {
  try {
    res.json({
      requests: Object.fromEntries([...requestCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      outbox: await outboxStatusCounts(),
    });
  } catch (error) {
    next(error);
  }
});

app.use("/api/auth", authRouter);
app.use("/api/otp", otpRouter);
app.use("/api/telecom", express.urlencoded({ extended: false, limit: "32kb", parameterLimit: 100 }), telecomRouter);
app.use("/api/me", requireAuth, meRouter);
app.use("/api/conversations", requireAuth, conversationsRouter);
app.use("/api/mail", requireAuth, mailRouter);
app.use("/api/e2ee", requireAuth, e2eeRouter);
app.use("/api", requireAuth, stage2Router);
app.use("/api/uploads", requireAuth, uploadsRouter);
app.use("/api", (_req, _res, next) => next(new HttpError(404, "Route not found", "NOT_FOUND")));

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      console.error(JSON.stringify({
        level: "error",
        event: "http_failure",
        requestId: res.getHeader("X-Request-ID"),
        code: err.code,
        errorType: err.name,
      }));
    }
    if (isDependencyUnavailableError(err)) {
      const code = "code" in (err as object) ? String((err as { code?: unknown }).code ?? "") : "";
      console.error(JSON.stringify({
        level: "error",
        event: "dependency_unavailable",
        requestId: res.getHeader("X-Request-ID"),
        dependency: "database",
        ...(code ? { errorCode: code } : {}),
      }));
      res.setHeader("Retry-After", "5");
      res.status(503).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Service is temporarily unavailable",
          requestId: res.getHeader("X-Request-ID"),
          retryable: true,
        },
      });
      return;
    }
    if (err.retryable && !res.hasHeader("Retry-After")) res.setHeader("Retry-After", "5");
    res.status(err.status).json({ error: { code: err.code, message: err.message, requestId: res.getHeader("X-Request-ID"), retryable: err.retryable, fields: err.fields ?? undefined } });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON", requestId: res.getHeader("X-Request-ID"), retryable: false } });
    return;
  }
  if (message.startsWith("Password must be")) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message, requestId: res.getHeader("X-Request-ID"), retryable: false } });
    return;
  }
  if (err && typeof err === "object" && "status" in err && (err as { status?: number }).status === 413) {
    res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large", requestId: res.getHeader("X-Request-ID"), retryable: false } });
    return;
  }
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  console.error(JSON.stringify({
    level: "error",
    event: "http_failure",
    requestId: res.getHeader("X-Request-ID"),
    method: req.method,
    path: req.path,
    errorType: err instanceof Error ? err.name : "UnknownError",
    ...(code ? { errorCode: code } : {}),
  }));
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error", requestId: res.getHeader("X-Request-ID"), retryable: true } });
});

async function main() {
  await runMigrations();
  const inboundSmtp = await startInboundSmtpServer();
  smtpListenerAvailable = inboundSmtp !== null;
  const mailTransport: MailTransport | null = createConfiguredMailTransport();
  if (mailTransport && config.mailTransportMode === "smtp" && mailTransport.verify) {
    void mailTransport.verify()
      .then(() => { smtpRelayReachable = true; })
      .catch(() => { smtpRelayReachable = false; });
  }
  const initialCleanup = await runMaintenance(config.storageDir);
  console.info(JSON.stringify({ level: "info", event: "maintenance_complete", counts: initialCleanup }));
  let maintenanceStopped = false;
  let maintenanceActive: Promise<void> | undefined;
  const maintenanceTick = () => {
    if (maintenanceStopped || maintenanceActive) return;
    maintenanceActive = runMaintenance(config.storageDir)
      .then((counts) => console.info(JSON.stringify({ level: "info", event: "maintenance_complete", counts })))
      .catch((error) => console.error(JSON.stringify({
        level: "error",
        event: "maintenance_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      })))
      .finally(() => { maintenanceActive = undefined; });
  };
  const maintenanceTimer = setInterval(maintenanceTick, config.maintenanceIntervalMs);
  maintenanceTimer.unref();
  const stopMaintenance = async (timeoutMs = 30_000): Promise<boolean> => {
    maintenanceStopped = true;
    clearInterval(maintenanceTimer);
    const active = maintenanceActive;
    if (!active) return true;
    let timeout: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      active.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return drained;
  };
  const stopOutboxWorker = config.outboxWorkerEnabled
    ? startOutboxWorker({
        intervalMs: config.outboxWorkerIntervalMs,
        limit: 1,
        handler: async (job) => {
          const payload = job.payload as { messageId?: unknown };
          if (typeof payload?.messageId !== "string") throw new Error("Outbox job has no valid message ID");
          if (job.kind === "message.notification") {
            await processMessageNotification(payload.messageId);
            return;
          }
          if (job.kind === "message.smtp-delivery") {
            if (!mailTransport) {
              await pool.query(
                `UPDATE smtp_message_deliveries SET status='failed',last_error='SMTP transport disabled',updated_at=now()
                  WHERE message_id=$1 AND status IN ('queued','retrying','acceptance_unknown')`,
                [payload.messageId],
              );
              return;
            }
            await processSmtpDelivery(payload.messageId, mailTransport);
            return;
          }
          throw new Error(`Unsupported outbox job kind: ${job.kind}`);
        },
      })
    : undefined;
  const server = app.listen(config.port, "0.0.0.0", () => {
    ready = true;
    console.info(JSON.stringify({ level: "info", event: "api_listening", port: config.port }));
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      ready = false;
      const smtpClosed = inboundSmtp ? inboundSmtp.close() : Promise.resolve();
      const serverClosed = new Promise<boolean>((resolve) => {
        server.close(() => resolve(true));
      });
      let serverTimeout: NodeJS.Timeout | undefined;
      const httpDrained = await Promise.race([
        serverClosed,
        new Promise<boolean>((resolve) => {
          serverTimeout = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
      if (serverTimeout) clearTimeout(serverTimeout);
      await smtpClosed;
      if (!httpDrained) {
        server.closeAllConnections();
        console.error(JSON.stringify({ level: "error", event: "http_shutdown_drain_timeout" }));
      }
      const maintenanceDrained = await stopMaintenance();
      if (!maintenanceDrained) console.error(JSON.stringify({ level: "error", event: "maintenance_shutdown_drain_timeout" }));
      const outboxDrained = await stopOutboxWorker?.(120_000) ?? true;
      if (!outboxDrained) console.error(JSON.stringify({ level: "error", event: "outbox_shutdown_drain_timeout" }));
      await Promise.resolve(mailTransport?.close?.());
      await closeAllStreamingSnapshots();
      await pool.end();
    })();
    return shutdownPromise;
  };
  const onShutdown = () => {
    void shutdown().catch((error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "shutdown_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      }));
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", onShutdown);
  process.once("SIGINT", onShutdown);
}

main().catch((err) => {
  console.error(JSON.stringify({
    level: "error",
    event: "api_start_failed",
    errorType: err instanceof Error ? err.name : "UnknownError",
    ...(err && typeof err === "object" && "code" in err ? { errorCode: String((err as { code?: unknown }).code ?? "") } : {}),
  }));
  process.exit(1);
});
