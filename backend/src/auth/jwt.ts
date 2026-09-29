import jwt from "jsonwebtoken";
import { config } from "../config";

export type JwtPayload = {
  sub: string;
  phone: string;
  jti: string;
};

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.accessTokenTtl,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
  if (typeof payload !== "object" || !payload || typeof payload.sub !== "string" ||
      typeof payload.phone !== "string" || typeof payload.jti !== "string") {
    throw new Error("Invalid token claims");
  }
  return payload as JwtPayload;
}
