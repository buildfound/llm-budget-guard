import { microUsdToUsd } from './pricing.js';
import {
  BudgetExceededError,
  ConcurrencyLimitError,
  RateLimitError,
  type BudgetSnapshot,
} from './types.js';

export interface BudgetErrorResponseOptions {
  /** HTTP status returned on BudgetExceededError (default: 402 Payment Required). */
  budgetExceededStatus?: number;
}

export function budgetHeaders(snapshot: BudgetSnapshot): Record<string, string> {
  return {
    'X-Budget-Limit-Usd': microUsdToUsd(snapshot.limitMicroUsd).toFixed(6),
    'X-Budget-Spent-Usd': microUsdToUsd(snapshot.spentMicroUsd).toFixed(6),
    'X-Budget-Remaining-Usd': microUsdToUsd(snapshot.remainingMicroUsd).toFixed(6),
    'X-Budget-Reset-At': new Date(snapshot.windowResetAtMs).toISOString(),
  };
}

/**
 * Maps BudgetGuard errors to standard Web Fetch Responses suitable for
 * Next.js App Router route handlers, Hono, Cloudflare Workers, or Node fetch handlers.
 * Returns null if the error is not a guard limit error so callers can rethrow.
 */
export function toBudgetErrorResponse(
  error: unknown,
  options: BudgetErrorResponseOptions = {},
): Response | null {
  if (error instanceof BudgetExceededError) {
    const status = options.budgetExceededStatus ?? 402;
    return Response.json(
      {
        error: error.code,
        message: error.message,
        remainingUsd: microUsdToUsd(error.snapshot.remainingMicroUsd),
        resetAt: new Date(error.snapshot.windowResetAtMs).toISOString(),
      },
      {
        status,
        headers: budgetHeaders(error.snapshot),
      },
    );
  }

  if (error instanceof RateLimitError) {
    const retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
    return Response.json(
      {
        error: error.code,
        message: error.message,
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          ...budgetHeaders(error.snapshot),
          'Retry-After': String(retryAfterSeconds),
        },
      },
    );
  }

  if (error instanceof ConcurrencyLimitError) {
    return Response.json(
      {
        error: error.code,
        message: error.message,
        maxConcurrent: error.maxConcurrent,
      },
      {
        status: 429,
        headers: {
          ...budgetHeaders(error.snapshot),
          'Retry-After': '1',
        },
      },
    );
  }

  return null;
}
