import bcrypt from "bcryptjs";
import type { AuthProvider, AuthUserRecord } from "./provider";

const ROUNDS = 10;

export const passwordProvider: AuthProvider = {
  method: "password",

  async prepareSecret(secret: string) {
    if (typeof secret !== "string" || secret.length < 6) {
      throw new Error("Password must be at least 6 characters");
    }
    if (Buffer.byteLength(secret, "utf8") > 72) {
      throw new Error("Password must be at most 72 UTF-8 bytes");
    }
    return bcrypt.hash(secret, ROUNDS);
  },

  async verify(user: AuthUserRecord, secret: string) {
    if (!secret || !user.passwordHash) {
      return false;
    }
    return bcrypt.compare(secret, user.passwordHash);
  },
};
