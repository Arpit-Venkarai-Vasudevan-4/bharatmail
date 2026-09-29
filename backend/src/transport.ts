import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type StreamTransport from "nodemailer/lib/stream-transport";
import type Mail from "nodemailer/lib/mailer";
import { config } from "./config";

export type MailAttachment = {
  filename: string;
  contentType: string;
  path?: string;
  content?: Buffer;
};

export type OutgoingMail = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  messageId: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  envelope?: { from: string; to: string[] };
  attachments?: MailAttachment[];
};

export type RecipientDeliveryError = {
  address: string;
  code: number;
  message: string;
};

export type MailSendResult = {
  messageId: string;
  accepted: string[];
  rejected: string[];
  rejectedDetails: RecipientDeliveryError[];
  response: string;
};

export interface MailTransport {
  send(message: OutgoingMail): Promise<MailSendResult>;
  close(): Promise<void>;
  verify?(): Promise<void>;
}

function nodemailerMessage(message: OutgoingMail): Mail.Options {
  return {
    from: message.from,
    to: message.to,
    ...(message.cc?.length ? { cc: message.cc } : {}),
    subject: message.subject,
    text: message.text,
    messageId: message.messageId,
    date: message.date,
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references?.length ? { references: message.references } : {}),
    ...(message.envelope ? { envelope: message.envelope } : {}),
    attachments: message.attachments?.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      ...(attachment.path ? { path: attachment.path } : {}),
      ...(attachment.content ? { content: attachment.content } : {}),
    })),
  };
}

function resultOf(info: SMTPTransport.SentMessageInfo | StreamTransport.SentMessageInfo): MailSendResult {
  const addressOf = (address: string | Mail.Address) => typeof address === "string" ? address : address.address ?? "";
  const rejectedDetails = ((info as SMTPTransport.SentMessageInfo & {
    rejectedErrors?: Array<{
      recipient?: string;
      code?: string | number;
      responseCode?: number;
      message?: string;
    }>;
  }).rejectedErrors ?? []).map((error) => ({
    address: error.recipient ?? "",
    code: Number(error.responseCode ?? (typeof error.code === "number" ? error.code : 0)),
    message: String(error.message ?? ""),
  })).filter((entry) => entry.address || entry.code || entry.message);
  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map(addressOf).filter(Boolean),
    rejected: (info.rejected ?? []).map(addressOf).filter(Boolean),
    rejectedDetails,
    response: String(info.response ?? "").slice(0, 300),
  };
}

/** Explicit local file simulation; Nodemailer creates the MIME rather than hand-built headers. */
export class LocalSmtpAdapter implements MailTransport {
  private readonly transporter: Transporter<StreamTransport.SentMessageInfo>;

  constructor(private readonly directory: string) {
    this.transporter = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "windows",
    });
  }

  async send(message: OutgoingMail): Promise<MailSendResult> {
    await mkdir(this.directory, { recursive: true });
    const info = await this.transporter.sendMail(nodemailerMessage(message));
    const id = randomUUID();
    await appendFile(join(this.directory, `${id}.eml`), info.message, { flag: "wx" });
    return { ...resultOf(info), messageId: message.messageId };
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

/** One bounded, pooled SMTP connection manager per API worker process. */
export class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;

  constructor() {
    if (config.mailTransportMode !== "smtp" || !config.smtp.host) {
      throw new Error("SMTP transport is not configured");
    }
    this.transporter = nodemailer.createTransport({
      pool: true,
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      ...(config.smtp.username ? { auth: { user: config.smtp.username, pass: config.smtp.password } } : {}),
      requireTLS: config.smtp.requireTls && !config.smtp.secure,
      ignoreTLS: false,
      tls: { minVersion: "TLSv1.2" },
      maxConnections: config.smtp.maxConnections,
      maxMessages: 100,
      connectionTimeout: config.smtp.timeoutMs,
      greetingTimeout: config.smtp.timeoutMs,
      socketTimeout: config.smtp.timeoutMs,
    });
  }

  async send(message: OutgoingMail): Promise<MailSendResult> {
    const info = await this.transporter.sendMail(nodemailerMessage(message));
    return resultOf(info);
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

export function createConfiguredMailTransport(): MailTransport | null {
  if (config.mailTransportMode === "disabled") return null;
  if (config.mailTransportMode === "file") return new LocalSmtpAdapter(config.localMailDir);
  return new SmtpMailTransport();
}
