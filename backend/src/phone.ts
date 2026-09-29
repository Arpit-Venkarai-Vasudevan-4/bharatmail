import { HttpError } from "./httpError";
import {
  isSupportedCountry,
  parsePhoneNumberWithError,
  type CountryCode,
  type PhoneNumber,
} from "libphonenumber-js/min";

export type ParsedPhone = {
  e164: string;
  normalized: string;
  country: CountryCode | null;
  nationalNumber: string;
};

function supportedCountry(value: string | undefined): CountryCode | undefined {
  if (value === undefined || value === "") return undefined;
  const country = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || !isSupportedCountry(country)) {
    throw new HttpError(400, "country must be a supported two-letter region code", "PHONE_COUNTRY_INVALID");
  }
  return country;
}

function parse(value: string, country?: CountryCode): PhoneNumber | undefined {
  try {
    return country
      ? parsePhoneNumberWithError(value, { defaultCountry: country, extract: false })
      : parsePhoneNumberWithError(value, { extract: false });
  } catch {
    return undefined;
  }
}

export function parsePhone(input: string, countryValue?: string): ParsedPhone {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value || !/^\+?[0-9][0-9 ()-]*$/.test(value) || (value.includes("+") && !value.startsWith("+"))) {
    throw new HttpError(400, "Phone number contains unsupported characters", "PHONE_INVALID");
  }

  const country = supportedCountry(countryValue);
  const digits = value.replace(/\D/g, "");
  let parsed: PhoneNumber | undefined;

  if (value.startsWith("+")) {
    parsed = parse(value);
  } else if (value.startsWith("00")) {
    parsed = parse(`+${digits.slice(2)}`);
  } else {
    if (!country) {
      throw new HttpError(400, "Use an international number or provide its country", "PHONE_COUNTRY_REQUIRED");
    }
    parsed ??= parse(value, country);
  }

  if (!parsed?.isValid()) {
    throw new HttpError(400, "Phone number is not valid for the supplied country and numbering plan", "PHONE_INVALID");
  }
  return {
    e164: parsed.number,
    normalized: parsed.number.slice(1),
    country: parsed.country ?? null,
    nationalNumber: parsed.nationalNumber,
  };
}

export function normalizePhone(input: string, country?: string): string {
  return parsePhone(input, country).normalized;
}

export function phoneNumberFromPublicIdentity(input: string): string {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value || !/^[0-9 ()-]+$/.test(value)) {
    throw new HttpError(400, "PhoneMail phone identity is invalid", "PHONE_INVALID");
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new HttpError(400, "PhoneMail phone identity is invalid", "PHONE_INVALID");
  }
  return digits;
}

export async function lockPhoneIdentities(
  client: { query: (text: string, values?: any[]) => Promise<any> },
  phones: string[],
): Promise<void> {
  for (const phone of [...new Set(phones.map(phoneNumberFromPublicIdentity))].sort()) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`phonemail.phone_identity:${phone}`],
    );
  }
}

export function emailFromPhone(phone: string, mailDomain: string): string {
  const value = phone.trim();
  const digits = value.startsWith("+") || value.startsWith("00")
    ? normalizePhone(value)
    : phoneNumberFromPublicIdentity(value);
  return `${digits}@${mailDomain.toLowerCase()}`;
}

export function parseMailboxLocalPart(email: string, mailDomain: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) {
    return null;
  }
  const domain = trimmed.slice(at + 1);
  const local = trimmed.slice(0, at);
  if (domain !== mailDomain.toLowerCase()) {
    return null;
  }
  return local;
}
