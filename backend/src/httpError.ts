export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = status === 401 ? "UNAUTHORIZED" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "BAD_REQUEST",
    public retryable = false,
    public fields?: Record<string, string>
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const DEPENDENCY_FAILURE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND",
  "57P01", "57P02", "57P03", "53300",
]);

export function isDependencyUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code.startsWith("08") || DEPENDENCY_FAILURE_CODES.has(code);
}

export function asyncHandler(
  fn: (
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction
  ) => Promise<unknown>
) {
  return (
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction
  ) => {
    fn(req, res, next).catch(next);
  };
}
