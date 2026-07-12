/**
 * Stable code stamped onto errors that mean "the LLM/Mesh account has no
 * remaining balance / credit". Frontends key off this to prompt the user to
 * update their key or top up funds.
 */
export const INSUFFICIENT_FUNDS_CODE = "insufficient_funds";

/** Stable failure identity for loop detection across changing ids, paths and counts. */
export function getErrorFingerprint(input: unknown): string {
  const any = input as any;
  const status = String(any?.status ?? any?.statusCode ?? any?.response?.status ?? "");
  const code = String(any?.code ?? any?.error?.code ?? "").toLowerCase();
  const type = String(any?.type ?? any?.error?.type ?? "").toLowerCase();
  const name = String(any?.name ?? "error").toLowerCase();
  const message = String(typeof input === "string" ? input : any?.message ?? input ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/(?:[a-z]:)?[\\/](?:[^\s:]+[\\/])*[^\s:]*/gi, "<path>")
    .replace(/\s+/g, " ")
    .trim();
  return [name, status, code, type, message].join("|");
}

/**
 * Best-effort classifier for "out of money / quota" failures coming back from
 * the model gateway. Providers wrap their errors in wildly different shapes, so
 * we check HTTP 402, common error `type`/`code` values, and message keywords.
 *
 * Accepts an Error, an API-error-like object, or a plain string (e.g. a
 * failure summary that has already been stringified upstream).
 */
export function isInsufficientFundsError(input: unknown): boolean {
  if (!input) return false;
  const any = input as any;

  const status = any?.status ?? any?.statusCode ?? any?.response?.status;
  if (status === 402) return true;

  const code = String(any?.code ?? any?.error?.code ?? "").toLowerCase();
  if (code === INSUFFICIENT_FUNDS_CODE) return true;

  const type = String(any?.type ?? any?.error?.type ?? "").toLowerCase();
  if (type.includes("insufficient_quota") || type.includes("insufficient_funds")) {
    return true;
  }

  const msg = (typeof input === "string" ? input : (any?.message ?? "")).toString().toLowerCase();
  const patterns: RegExp[] = [
    /insufficient (funds|balance|quota|credits?|tokens?)/,
    /not enough (funds|balance|credits?|tokens?)/,
    /payment required/,
    /quota (exceeded|reached)/,
    /exceeded your current quota/,
    /usage (limit|cap|exceeded)/,
    /billing (hard )?limit/,
    /(ran |run )?out of (credits?|funds|tokens?|balance|usage)/,
    /add (funds|credits?|money)/,
    /top ?up/,
    /no (remaining )?(balance|credits?|tokens?|usage)/,
    /(no|0|zero) (tokens?|credits?|balance|usage)( left| remaining)/,
    /(tokens?|credits?|balance|usage) (left|remaining)[:\s]+0\b/,
  ];
  return patterns.some((p) => p.test(msg));
}

/**
 * Best-effort classifier for transient API errors (rate limits, timeouts, 5xx)
 * that should be retried with backoff.
 */
export function isTransientError(input: unknown): boolean {
  if (!input) return false;
  const any = input as any;

  const status = any?.status ?? any?.statusCode ?? any?.response?.status;
  if (status === 408 || status === 429 || (typeof status === "number" && status >= 500 && status < 600)) return true;

  const msg = (typeof input === "string" ? input : (any?.message ?? "")).toString().toLowerCase();
  const code = String(any?.code ?? "").toLowerCase();
  const type = String(any?.type ?? "").toLowerCase();
  
  if (code.includes("upstream_error") || type.includes("upstream_error")) return true;

  const patterns: RegExp[] = [
    /rate limit/,
    /too many requests/,
    /timeout/,
    /timed out/,
    /connection error/,
    /network error/,
    /service unavailable/,
    /bad gateway/,
    /gateway timeout/,
    /try again later/,
    /temporarily unavailable/,
    /provider_error/,
    /temporary_error/,
  ];
  return patterns.some((p) => p.test(msg));
}
