export interface ModelRate {
  /** USD per 1,000,000 input tokens */
  inputPerMillionUsd: number;
  /** USD per 1,000,000 output tokens */
  outputPerMillionUsd: number;
  /** Optional USD per 1,000,000 cached input tokens */
  cachedInputPerMillionUsd?: number;
}

export type PricingTable = Record<string, ModelRate>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface TenantPolicy {
  /** Maximum spend allowed per budget window, in USD (e.g. 5.00). */
  budgetUsd: number;
  /** Budget window length in milliseconds (default: 24 hours). */
  budgetWindowMs?: number;
  /** Maximum requests allowed within the rate-limit sliding window. */
  maxRequestsPerWindow?: number;
  /** Rate-limit sliding window length in milliseconds (default: 60 seconds). */
  rateWindowMs?: number;
  /** Maximum in-flight requests per tenant at the same time. */
  maxConcurrent?: number;
  /** How long a reservation holds budget/concurrency before expiring (default: 120 seconds). */
  reservationTtlMs?: number;
}

export interface ResolvedTenantPolicy {
  budgetMicroUsd: number;
  budgetWindowMs: number;
  maxRequestsPerWindow: number | null;
  rateWindowMs: number;
  maxConcurrent: number | null;
  reservationTtlMs: number;
}

export interface ReserveRequest {
  tenantId: string;
  model: string;
  /** Either pass promptText (estimated automatically) or explicit estimatedInputTokens. */
  promptText?: string;
  estimatedInputTokens?: number;
  /** Worst-case output token cap passed to the model (e.g. max_tokens). */
  maxOutputTokens: number;
  /** Optional policy override for this tenant/request. */
  policy?: TenantPolicy;
}

export interface Reservation {
  id: string;
  tenantId: string;
  model: string;
  reservedMicroUsd: number;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface BudgetSnapshot {
  tenantId: string;
  windowStartMs: number;
  windowResetAtMs: number;
  limitMicroUsd: number;
  spentMicroUsd: number;
  reservedMicroUsd: number;
  remainingMicroUsd: number;
  activeReservations: number;
  requestsInRateWindow: number;
}

export interface SpendReceipt {
  reservationId: string;
  tenantId: string;
  model: string;
  reservedMicroUsd: number;
  actualMicroUsd: number;
  usage: TokenUsage;
  snapshot: BudgetSnapshot;
}

export interface GuardRunResult<T> {
  result: T;
  receipt: SpendReceipt;
}

export type GuardErrorCode =
  | 'BUDGET_EXCEEDED'
  | 'RATE_LIMITED'
  | 'CONCURRENCY_LIMIT'
  | 'UNKNOWN_MODEL'
  | 'INVALID_CONFIG';

export class BudgetGuardError extends Error {
  readonly code: GuardErrorCode;

  constructor(code: GuardErrorCode, message: string) {
    super(message);
    this.name = 'BudgetGuardError';
    this.code = code;
  }
}

export class BudgetExceededError extends BudgetGuardError {
  readonly tenantId: string;
  readonly requestedMicroUsd: number;
  readonly snapshot: BudgetSnapshot;

  constructor(tenantId: string, requestedMicroUsd: number, snapshot: BudgetSnapshot) {
    const remainingUsd = (snapshot.remainingMicroUsd / 1_000_000).toFixed(6);
    const requestedUsd = (requestedMicroUsd / 1_000_000).toFixed(6);
    super(
      'BUDGET_EXCEEDED',
      `Tenant "${tenantId}" budget exceeded: needed $${requestedUsd}, remaining $${remainingUsd}.`,
    );
    this.name = 'BudgetExceededError';
    this.tenantId = tenantId;
    this.requestedMicroUsd = requestedMicroUsd;
    this.snapshot = snapshot;
  }
}

export class RateLimitError extends BudgetGuardError {
  readonly tenantId: string;
  readonly retryAfterMs: number;
  readonly snapshot: BudgetSnapshot;

  constructor(tenantId: string, retryAfterMs: number, snapshot: BudgetSnapshot) {
    const retrySeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super(
      'RATE_LIMITED',
      `Tenant "${tenantId}" hit rate limit. Retry after ${retrySeconds}s.`,
    );
    this.name = 'RateLimitError';
    this.tenantId = tenantId;
    this.retryAfterMs = retryAfterMs;
    this.snapshot = snapshot;
  }
}

export class ConcurrencyLimitError extends BudgetGuardError {
  readonly tenantId: string;
  readonly maxConcurrent: number;
  readonly snapshot: BudgetSnapshot;

  constructor(tenantId: string, maxConcurrent: number, snapshot: BudgetSnapshot) {
    super(
      'CONCURRENCY_LIMIT',
      `Tenant "${tenantId}" reached max concurrency (${maxConcurrent}).`,
    );
    this.name = 'ConcurrencyLimitError';
    this.tenantId = tenantId;
    this.maxConcurrent = maxConcurrent;
    this.snapshot = snapshot;
  }
}
