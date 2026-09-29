import { randomUUID } from "node:crypto";
import type {
  NotificationProvider,
  NotificationRequest,
  ProviderEvent,
} from "./provider";

export class LocalNotificationAdapter implements NotificationProvider {
  readonly name = "local";
  readonly capabilities = { sms: true, ivr: false };
  private readonly requests = new Map<string, NotificationRequest>();
  private readonly events = new Map<string, ProviderEvent>();
  private readonly latestSequence = new Map<string, number>();

  async send(input: Omit<NotificationRequest, "id" | "createdAt">): Promise<NotificationRequest> {
    const request = { ...input, id: randomUUID(), createdAt: Date.now() };
    this.requests.set(request.id, request);
    return request;
  }

  async handleWebhookEvent(event: ProviderEvent): Promise<"applied" | "duplicate" | "stale"> {
    if (this.events.has(event.id)) return "duplicate";
    const latest = this.latestSequence.get(event.requestId) ?? -1;
    this.events.set(event.id, event);
    if (event.sequence <= latest) return "stale";
    this.latestSequence.set(event.requestId, event.sequence);
    return "applied";
  }

  getRequest(id: string): NotificationRequest | undefined {
    return this.requests.get(id);
  }

  listRequests(): NotificationRequest[] {
    return [...this.requests.values()];
  }
}
