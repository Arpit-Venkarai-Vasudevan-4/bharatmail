import { claimOutbox, finishOutbox, type OutboxJob } from "./outbox";
import { HttpError } from "./httpError";

export type OutboxHandler = (job: OutboxJob) => Promise<void>;

export type WorkerOptions = {
  limit?: number;
  handler: OutboxHandler;
};

export async function processClaimedOutbox(
  jobs: OutboxJob[],
  handler: OutboxHandler,
): Promise<{ claimed: number; sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await handler(job);
      if (await finishOutbox(job.id, job.leaseToken, true)) sent++;
    } catch (error) {
      const message = error instanceof HttpError
        ? `${error.code}: ${error.message}`
        : `OUTBOX_HANDLER_FAILED: ${error instanceof Error ? error.name : "UnknownError"}`;
      if (await finishOutbox(job.id, job.leaseToken, false, message)) failed++;
    }
  }
  return { claimed: jobs.length, sent, failed };
}

export async function processOutboxOnce(options: WorkerOptions): Promise<{ claimed: number; sent: number; failed: number }> {
  const jobs = await claimOutbox(options.limit ?? 10);
  return processClaimedOutbox(jobs, options.handler);
}

export function startOutboxWorker(options: WorkerOptions & {
  intervalMs?: number;
  processBatch?: (options: WorkerOptions) => ReturnType<typeof processOutboxOnce>;
}) {
  let stopped = false;
  let activeTick: Promise<void> | undefined;
  const intervalMs = options.intervalMs ?? 5000;
  const tick = () => {
    if (stopped || activeTick) return;
    activeTick = (options.processBatch ?? processOutboxOnce)({ ...options, limit: options.limit ?? 1 })
      .then((stats) => {
        if (stats.claimed) console.info(JSON.stringify({ level: "info", event: "outbox_batch", ...stats }));
      })
      .catch((error) => {
        console.error(JSON.stringify({
          level: "error",
          event: "outbox_worker_tick_failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }));
      })
      .finally(() => { activeTick = undefined; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async (drainTimeoutMs = 120_000): Promise<boolean> => {
    stopped = true;
    clearInterval(timer);
    const active = activeTick;
    if (!active) return true;
    let timeout: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      active.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), drainTimeoutMs);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return drained;
  };
}
