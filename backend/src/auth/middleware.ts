import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../httpError";
import { query } from "../db";
import { config } from "../config";
import { verifyToken } from "./jwt";
import { parseCookieHeader } from "./cookies";

export type AuthedRequest = Request & {
  userId: string;
  phone: string;
  sessionId: string;
  authTransport: "bearer" | "cookie";
};

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const cookieToken = parseCookieHeader(req.headers.cookie)[config.sessionCookieName];
  if ((!header || !header.startsWith("Bearer ")) && !cookieToken) {
    next(new HttpError(401, "Missing authorization token"));
    return;
  }
  try {
    const bearerPayload = header?.startsWith("Bearer ") ? verifyToken(header.slice("Bearer ".length)) : null;
    const cookiePayload = cookieToken ? verifyToken(cookieToken) : null;
    if (bearerPayload && cookiePayload && bearerPayload.sub !== cookiePayload.sub) {
      throw new HttpError(401, "Conflicting authentication credentials");
    }
    const payload = bearerPayload ?? cookiePayload;
    if (!payload) throw new HttpError(401, "Missing authorization token");
    if (!payload.jti || !payload.sub || !payload.phone) {
      throw new Error("Invalid token claims");
    }
    const session = await query(
      `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.expires_at > now() AND u.account_status='active'`,
      [payload.jti, payload.sub]
    );
    if ((session.rowCount ?? 0) === 0) {
      throw new HttpError(401, "Session is no longer active");
    }
    (req as AuthedRequest).userId = payload.sub;
    (req as AuthedRequest).phone = payload.phone;
    (req as AuthedRequest).sessionId = payload.jti;
    (req as AuthedRequest).authTransport = bearerPayload ? "bearer" : "cookie";
    if (!bearerPayload && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const csrf = parseCookieHeader(req.headers.cookie)[config.csrfCookieName];
      if (!csrf || req.headers["x-csrf-token"] !== csrf) {
        throw new HttpError(403, "CSRF token is required", "FORBIDDEN");
      }
    }
    next();
  } catch (error) {
    if (error instanceof HttpError) {
      next(error);
      return;
    }
    const dbCode = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
    if (dbCode.startsWith("08") || dbCode.startsWith("53") || dbCode.startsWith("57") || dbCode === "53300" || dbCode === "57014" ||
        error instanceof Error && (error.message.includes("connect") || error.message.includes("timeout"))) {
      next(new HttpError(503, "Authentication service is temporarily unavailable", "SERVICE_UNAVAILABLE", true));
      return;
    }
    next(new HttpError(401, "Invalid or expired token"));
  }
}
