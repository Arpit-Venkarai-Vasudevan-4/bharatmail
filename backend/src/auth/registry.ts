import { config } from "../config";
import { HttpError } from "../httpError";
import { otpProvider } from "./otpProvider";
import { passwordProvider } from "./passwordProvider";
import type { AuthProvider } from "./provider";

export function getAuthProvider(): AuthProvider {
  if (config.authMethod === "otp") {
    return otpProvider;
  }
  return passwordProvider;
}

export function requirePasswordAuth(): AuthProvider {
  const provider = getAuthProvider();
  if (provider.method !== "password") {
    throw new HttpError(501, "Password authentication is disabled");
  }
  return provider;
}
