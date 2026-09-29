import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { HttpError } from "../httpError";
import { parsePhone } from "../phone";

function providerDestination(value: string): string {
  return parsePhone(value.startsWith("+") ? value : `+${value}`).e164;
}

export type TwilioFormValue = string | string[];
export type TwilioForm = Record<string, TwilioFormValue>;

export function twilioSignature(authToken: string, publicUrl: string, parameters: TwilioForm): string {
  const append = (name: string, value: TwilioFormValue): string => {
    if (Array.isArray(value)) {
      return [...new Set(value)].sort().map((item) => append(name, item)).join("");
    }
    return name + value;
  };
  const data = Object.keys(parameters).sort().reduce((result, key) => result + append(key, parameters[key]), publicUrl);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validTwilioSignature(authToken: string, signature: string, publicUrl: string, parameters: TwilioForm): boolean {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, publicUrl, parameters));
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function publicWebhookUrl(publicUrl: string, requestUrl: string): string {
  let configured: URL;
  try {
    configured = new URL(publicUrl);
  } catch {
    throw new HttpError(503, "Twilio public webhook URL is not configured", "PROVIDER_UNAVAILABLE", true);
  }
  if (configured.protocol !== "https:" && config.nodeEnv !== "development") {
    throw new HttpError(503, "Twilio webhooks require a public HTTPS URL", "PROVIDER_UNAVAILABLE", true);
  }
  if (!requestUrl.startsWith("/") || requestUrl.startsWith("//")) {
    throw new HttpError(400, "Invalid provider callback URL", "WEBHOOK_INVALID");
  }
  return `${configured.origin}${requestUrl}`;
}

type MessagingSettings = {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  phoneNumber: string;
  messagingServiceSid: string;
  approvedTemplateSid: string;
  timeoutMs: number;
};

type MessagingResponse = { sid?: string; status?: string; code?: number; message?: string };
export type SmsSendResult = { sid: string; status: "accepted" | "sent" | "delivered" };

export class TwilioMessagingAdapter {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly settings: MessagingSettings = config.twilio,
  ) {}

  private get credentials(): string {
    const sid = this.settings.apiKeySid || this.settings.accountSid;
    const secret = this.settings.apiKeySecret || this.settings.authToken;
    if (!sid || !secret || (!this.settings.phoneNumber && !this.settings.messagingServiceSid)) {
      throw new HttpError(503, "Twilio Messaging is not configured", "PROVIDER_UNAVAILABLE", true);
    }
    return Buffer.from(`${sid}:${secret}`).toString("base64");
  }

  async send(input: { to: string; body: string; statusCallback: string; templateVariables: { sender: string; subject: string } }): Promise<SmsSendResult> {
    const accountSid = this.settings.accountSid;
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
      throw new HttpError(503, "Twilio account SID is not configured", "PROVIDER_UNAVAILABLE", true);
    }
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    let response = await this.post(endpoint, input, false);
    if (!response.ok && this.settings.approvedTemplateSid) {
      const rejected = await this.readError(response);
      if (rejected.code === 21608 || rejected.code === 63016) {
        response = await this.post(endpoint, input, true);
      } else {
        throw this.providerError(rejected);
      }
    }
    if (!response.ok) throw this.providerError(await this.readError(response));
    const result = await response.json() as MessagingResponse;
    if (!result.sid || !/^(SM|MM)[0-9a-fA-F]{32}$/.test(result.sid)) {
      throw new HttpError(503, "Twilio Messaging returned malformed data", "PROVIDER_MALFORMED", true);
    }
    const status = result.status === "sent" ? "sent" : result.status === "delivered" ? "delivered" : "accepted";
    return { sid: result.sid, status };
  }

  private async post(endpoint: string, input: { to: string; body: string; statusCallback: string; templateVariables: { sender: string; subject: string } }, useTemplate: boolean): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    const form = new URLSearchParams({
      To: providerDestination(input.to),
      StatusCallback: input.statusCallback,
    });
    if (this.settings.messagingServiceSid) form.set("MessagingServiceSid", this.settings.messagingServiceSid);
    else form.set("From", this.settings.phoneNumber);
    if (useTemplate) {
      form.set("ContentSid", this.settings.approvedTemplateSid);
      form.set("ContentVariables", JSON.stringify({ "1": input.templateVariables.sender, "2": input.templateVariables.subject }));
    } else {
      form.set("Body", input.body);
    }
    try {
      return await this.fetcher(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${this.credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: controller.signal,
      });
    } catch {
      throw new HttpError(503, "Twilio Messaging is temporarily unavailable", "PROVIDER_UNAVAILABLE", true);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readError(response: Response): Promise<{ code: number | null; message: string }> {
    let body: MessagingResponse = {};
    try { body = await response.json() as MessagingResponse; } catch { /* provider body is not required for classification */ }
    return { code: typeof body.code === "number" ? body.code : null, message: typeof body.message === "string" ? body.message : "Twilio rejected the notification" };
  }

  private providerError(error: { code: number | null; message: string }): HttpError {
    const safeCode = error.code === null ? "" : ` (code ${error.code})`;
    return new HttpError(503, `Twilio Messaging rejected the notification${safeCode}`, "PROVIDER_REJECTED", true);
  }
}

export function notificationBody(sender: string, subject: string): string {
  const clean = (value: string, max: number) => {
    const points = [...value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()];
    return points.length <= max ? points.join("") : `${points.slice(0, max - 1).join("")}…`;
  };
  const safeSender = clean(sender, 100) || "a PhoneMail user";
  const safeSubject = clean(subject, 250) || "(no subject)";
  const complete = `You have received an email from ${safeSender}. Subject: ${safeSubject}.`;
  const points = [...complete];
  return points.length <= 800 ? complete : `${points.slice(0, 799).join("")}…`;
}
