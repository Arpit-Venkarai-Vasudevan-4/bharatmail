export type NotificationChannel = "sms" | "ivr";

export type NotificationCapabilities = {
  sms: boolean;
  ivr: boolean;
};

export type NotificationRequest = {
  id: string;
  channel: NotificationChannel;
  phone: string;
  body: string;
  createdAt: number;
};

export type ProviderEvent = {
  id: string;
  requestId: string;
  status: "queued" | "sent" | "delivered" | "failed";
  sequence: number;
  occurredAt: number;
};

export interface NotificationProvider {
  readonly name: string;
  readonly capabilities: NotificationCapabilities;
  send(request: Omit<NotificationRequest, "id" | "createdAt">): Promise<NotificationRequest>;
  handleWebhookEvent(event: ProviderEvent): Promise<"applied" | "duplicate" | "stale">;
}
