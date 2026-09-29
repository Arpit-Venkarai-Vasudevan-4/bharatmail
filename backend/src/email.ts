import { domainToASCII } from "node:url";
import { HttpError } from "./httpError";

export function normalizeEmailAddress(raw: string): string {
  if (raw.length > 254 || /[\r\n\0]/.test(raw) || raw.trim() !== raw) {
    throw new HttpError(400, "Email address is invalid", "EMAIL_INVALID");
  }
  const separator = raw.lastIndexOf("@");
  if (separator < 1 || separator === raw.length - 1 || raw.indexOf("@") !== separator) {
    throw new HttpError(400, "Email address is invalid", "EMAIL_INVALID");
  }
  const local = raw.slice(0, separator);
  const domain = domainToASCII(raw.slice(separator + 1).toLowerCase());
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(local) ||
      local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
      !domain || domain.length > 253 ||
      !domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new HttpError(400, "Email address is invalid", "EMAIL_INVALID");
  }
  return `${local.toLowerCase()}@${domain}`;
}
