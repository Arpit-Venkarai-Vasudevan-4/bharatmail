import { Router } from "express";
import { asyncHandler, HttpError } from "../httpError";
import { changePhoneNumber, loginUser, logoutUser, registerUser, registerWithOtp, loginWithOtp, renewSession, type SignupChannel } from "../services/userService";
import type { AuthedRequest } from "../auth/middleware";
import { requireAuth } from "../auth/middleware";
import { getUserById } from "../services/userService";
import { authRateLimit } from "../auth/rateLimit";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { recoverPhoneChangeResponse, requestToken, validPhoneChangeIdempotencyKey, type PhoneChangeRequest } from "../auth/phoneChangeRecovery";
import { verifyToken } from "../auth/jwt";
import { parseCookieHeader } from "../auth/cookies";

export const authRouter = Router();

const channels = new Set<SignupChannel>(["mobile", "web", "portal", "ivr"]);

authRouter.post(
  "/register",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const { phone, country, password, displayName, language, signupChannel, termsAccepted, termsVersion } = req.body ?? {};
    if (typeof phone !== "string" || typeof password !== "string" || !phone || !password) {
      throw new HttpError(400, "phone and password are required", "VALIDATION_ERROR");
    }
    if ((displayName !== undefined && typeof displayName !== "string") ||
        (language !== undefined && typeof language !== "string") ||
        (country !== undefined && (typeof country !== "string" || country.length !== 2)) ||
        (termsVersion !== undefined && typeof termsVersion !== "string") ||
        (signupChannel !== undefined && (typeof signupChannel !== "string" || !channels.has(signupChannel as SignupChannel)))) {
      throw new HttpError(400, "Registration fields are invalid", "VALIDATION_ERROR");
    }
    const channel =
      typeof signupChannel === "string" && channels.has(signupChannel as SignupChannel)
        ? (signupChannel as SignupChannel)
        : "mobile";
    const result = await registerUser({
      phone,
      country,
      password,
      displayName,
      language,
      signupChannel: channel,
      termsAccepted: termsAccepted === true,
      termsVersion,
    });
    respondAuth(req, res, result, 201);
  })
);

authRouter.post("/otp/register", asyncHandler(async (req, res) => {
  const { phone, country, challengeId, code, purpose, displayName, language, termsAccepted, signupChannel, termsVersion } = req.body ?? {};
  if (typeof phone !== "string" || typeof challengeId !== "string" || typeof code !== "string" || purpose !== "signup" ||
      termsAccepted !== true || (displayName !== undefined && typeof displayName !== "string") ||
      (language !== undefined && typeof language !== "string") ||
      (country !== undefined && (typeof country !== "string" || country.length !== 2)) ||
      (termsVersion !== undefined && typeof termsVersion !== "string") ||
      (signupChannel !== undefined && (typeof signupChannel !== "string" || !channels.has(signupChannel as SignupChannel)))) {
    throw new HttpError(400, "phone, challengeId, purpose=signup, and code are required", "VALIDATION_ERROR");
  }
  respondAuth(req, res, await registerWithOtp({ phone, country, challengeId, code, displayName, language, termsAccepted, signupChannel, termsVersion }), 201);
}));

authRouter.post("/otp/login", asyncHandler(async (req, res) => {
  const { phone, country, challengeId, code, purpose } = req.body ?? {};
  if (typeof phone !== "string" || (country !== undefined && (typeof country !== "string" || country.length !== 2)) ||
      typeof challengeId !== "string" || typeof code !== "string" || purpose !== "login") {
    throw new HttpError(400, "phone, challengeId, purpose=login, and code are required", "VALIDATION_ERROR");
  }
  respondAuth(req, res, await loginWithOtp({ phone, country, challengeId, code }));
}));

authRouter.post(
  "/login",
  authRateLimit,
  asyncHandler(async (req, res) => {
    const { phone, country, password } = req.body ?? {};
    if (typeof phone !== "string" || typeof password !== "string" || !phone || !password) {
      throw new HttpError(400, "phone and password are required", "VALIDATION_ERROR");
    }
    if (country !== undefined && (typeof country !== "string" || country.length !== 2)) {
      throw new HttpError(400, "country must be a two-letter region code", "VALIDATION_ERROR");
    }
    const result = await loginUser({ phone, country, password });
    respondAuth(req, res, result);
  })
);

authRouter.post("/logout", requireAuth, asyncHandler(async (req, res) => {
  const auth = req as AuthedRequest;
  await logoutUser(auth.userId, auth.sessionId);
  res.clearCookie(config.sessionCookieName, { httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/" });
  res.clearCookie(config.refreshCookieName, { httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/api/auth" });
  res.clearCookie(config.csrfCookieName, { secure: config.cookieSecure, sameSite: "lax", path: "/" });
  res.status(204).send();
}));

authRouter.post("/refresh", asyncHandler(async (req, res) => {
  const refreshCookie = parseCookieHeader(req.headers.cookie)[config.refreshCookieName];
  const bodyToken = req.body?.refreshToken;
  if (bodyToken !== undefined && (typeof bodyToken !== "string" || !bodyToken)) {
    throw new HttpError(400, "refreshToken must be a non-empty string", "VALIDATION_ERROR");
  }
  if (refreshCookie && bodyToken) throw new HttpError(400, "Use either the refresh cookie or bearer refresh token, not both", "AUTH_TRANSPORT_CONFLICT");
  const cookieTransport = Boolean(refreshCookie);
  const refreshToken = refreshCookie ?? bodyToken;
  if (cookieTransport && req.headers.authorization) {
    throw new HttpError(400, "Use either cookie refresh or bearer refresh transport, not both", "AUTH_TRANSPORT_CONFLICT");
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new HttpError(401, "A refresh credential is required", "UNAUTHORIZED");
  }
  if (cookieTransport) {
    const csrf = parseCookieHeader(req.headers.cookie)[config.csrfCookieName];
    if (!csrf || req.headers["x-csrf-token"] !== csrf) {
      throw new HttpError(403, "CSRF token is required", "FORBIDDEN");
    }
  }
  const result = await renewSession(refreshToken);
  if (cookieTransport) {
    res.cookie(config.sessionCookieName, result.token, {
      httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/", maxAge: 15 * 60 * 1000,
    });
    res.cookie(config.refreshCookieName, result.refreshToken, {
      httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/api/auth", maxAge: config.sessionRenewalMs,
    });
    res.json({ user: result.user });
    return;
  }
  res.json(result);
}));

authRouter.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const { userId } = req as AuthedRequest;
  res.json({ user: await getUserById(userId) });
}));

function requirePhoneChangeAuth(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  void (async () => {
    const key = req.header("Idempotency-Key");
    const token = requestToken(req);
    if (validPhoneChangeIdempotencyKey(key) && token) {
      let payload: ReturnType<typeof verifyToken> | undefined;
      try {
        payload = verifyToken(token);
      } catch {
        payload = undefined;
      }
      if (payload) {
        const cookieToken = parseCookieHeader(req.headers.cookie)[config.sessionCookieName];
        const bearerToken = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice("Bearer ".length) : undefined;
        if (cookieToken && bearerToken) {
          try {
            if (verifyToken(cookieToken).sub !== payload.sub) throw new HttpError(401, "Conflicting authentication credentials");
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(401, "Invalid or expired token");
          }
        }
        if (!bearerToken) {
          const csrf = parseCookieHeader(req.headers.cookie)[config.csrfCookieName];
          if (!csrf || req.headers["x-csrf-token"] !== csrf) {
            throw new HttpError(403, "CSRF token is required", "FORBIDDEN");
          }
        }
        const recovered = await recoverPhoneChangeResponse(payload, key, token, (req.body ?? {}) as PhoneChangeRequest);
        if (recovered) {
          respondAuth(req, res, recovered);
          return;
        }
      }
    }
    requireAuth(req, res, next);
  })().catch(next);
}

authRouter.post("/phone-change", requirePhoneChangeAuth, asyncHandler(async (req, res) => {
  const auth = req as AuthedRequest;
  const idempotencyKey = req.header("Idempotency-Key");
  const { currentPassword, newPhone, country, challengeId, code, oldChallengeId, oldCode } = req.body ?? {};
  if ((idempotencyKey !== undefined && !validPhoneChangeIdempotencyKey(idempotencyKey)) ||
      (currentPassword !== undefined && typeof currentPassword !== "string") ||
      (country !== undefined && (typeof country !== "string" || country.length !== 2)) ||
      typeof newPhone !== "string" || typeof challengeId !== "string" || typeof code !== "string" ||
      (oldChallengeId !== undefined && typeof oldChallengeId !== "string") ||
      (oldCode !== undefined && typeof oldCode !== "string") ||
      ((oldChallengeId === undefined) !== (oldCode === undefined))) {
    throw new HttpError(400, "newPhone, challengeId, and code are required; provide both oldChallengeId and oldCode for OTP-only accounts", "VALIDATION_ERROR");
  }
  const result = await changePhoneNumber({
    userId: auth.userId,
    sessionId: auth.sessionId,
    currentPassword,
    newPhone,
    country,
    challengeId,
    code,
    oldChallengeId,
    oldCode,
    idempotencyKey,
    originalToken: idempotencyKey ? requestToken(req) : undefined,
  });
  respondAuth(req, res, result);
}));

function respondAuth(req: import("express").Request, res: import("express").Response, result: { user: unknown; token: string; refreshToken: string }, status = 200) {
  if (req.header("X-Auth-Transport") === "cookie") {
    const csrf = randomBytes(24).toString("hex");
    res.cookie(config.sessionCookieName, result.token, {
      httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/", maxAge: 15 * 60 * 1000,
    });
    res.cookie(config.refreshCookieName, result.refreshToken, {
      httpOnly: true, secure: config.cookieSecure, sameSite: "lax", path: "/api/auth", maxAge: config.sessionRenewalMs,
    });
    res.cookie(config.csrfCookieName, csrf, {
      httpOnly: false, secure: config.cookieSecure, sameSite: "lax", path: "/",
    });
    res.status(status).json({ user: result.user });
    return;
  }
  res.status(status).json(result);
}
