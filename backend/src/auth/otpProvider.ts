import { HttpError } from "../httpError";
import type { AuthProvider, AuthUserRecord } from "./provider";
import { config } from "../config";
import { parsePhone } from "../phone";

export type VerifyClient = (url: string, init: RequestInit) => Promise<Response>;
type VerifySettings = {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  verifyServiceSid: string;
  timeoutMs: number;
};

export class TwilioVerifyAdapter {
  constructor(private readonly fetcher: VerifyClient = fetch, private readonly settings: VerifySettings = config.twilio) {}

  private get credentials(): string {
    const sid = this.settings.apiKeySid || this.settings.accountSid;
    const secret = this.settings.apiKeySecret || this.settings.authToken;
    if (!sid || !secret || !this.settings.verifyServiceSid) {
      throw new HttpError(503, "Twilio Verify is not configured", "PROVIDER_UNAVAILABLE", true);
    }
    return Buffer.from(`${sid}:${secret}`).toString("base64");
  }

  async start(phone: string, channel: "sms" | "call" = "sms"): Promise<string> {
    const destination = parsePhone(phone.startsWith("+") ? phone : `+${phone}`).e164;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await this.fetcher(
        `https://verify.twilio.com/v2/Services/${encodeURIComponent(this.settings.verifyServiceSid)}/Verifications`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${this.credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: destination, Channel: channel }).toString(),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 503, "Twilio Verify rejected the request", "PROVIDER_REJECTED", true);
      const body = await response.json() as { sid?: string; status?: string };
      if (typeof body.sid !== "string" || !/^VE[0-9a-fA-F]{32}$/.test(body.sid)) throw new HttpError(503, "Twilio Verify returned malformed data", "PROVIDER_MALFORMED", true);
      return body.sid;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "Twilio Verify is temporarily unavailable", "PROVIDER_UNAVAILABLE", true);
    } finally {
      clearTimeout(timer);
    }
  }

  async check(verificationSid: string, code: string): Promise<boolean> {
    if (!/^VE[0-9a-fA-F]{32}$/.test(verificationSid)) {
      throw new HttpError(503, "Twilio Verify challenge reference is invalid", "PROVIDER_MALFORMED", true);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await this.fetcher(
        `https://verify.twilio.com/v2/Services/${encodeURIComponent(this.settings.verifyServiceSid)}/VerificationCheck`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${this.credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ VerificationSid: verificationSid, Code: code }).toString(),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 503, "Twilio Verify rejected the request", "PROVIDER_REJECTED", true);
      const body = await response.json() as { status?: string };
      return body.status === "approved";
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "Twilio Verify is temporarily unavailable", "PROVIDER_UNAVAILABLE", true);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const otpProvider: AuthProvider = {
  method: "otp",

  async prepareSecret(_secret: string) {
    return null;
  },

  async verify(_user: AuthUserRecord, _secret: string) {
    throw new HttpError(501, "Twilio Verify OTP is not enabled yet");
  },

  async requestCode(_phoneNormalized: string) {
    throw new HttpError(501, "Twilio Verify OTP is not enabled yet");
  },
};
