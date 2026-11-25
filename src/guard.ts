import {
  DEFAULT_PRICING,
  calculateCostMicroUsd,
  estimatePromptTokens,
  resolveModelRate,
  usdToMicroUsd,
} from './pricing.js';
import { MemoryBudgetStore, type BudgetStore } from './store.js';
import {
  BudgetGuardError,
  type BudgetSnapshot,
  type GuardRunResult,
  type PricingTable,
  type Reservation,
  type ReserveRequest,
  type ResolvedTenantPolicy,
  type SpendReceipt,
  type TenantPolicy,
  type TokenUsage,
} from './types.js';

const DEFAULT_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_RESERVATION_TTL_MS = 2 * 60 * 1000;

export interface BudgetGuardOptions {
  defaultPolicy: TenantPolicy;
  store?: BudgetStore;
  pricing?: PricingTable;
  now?: () => number;
}

export interface RunCallbackResult<T> {
  result: T;
  usage: TokenUsage;
}

function validatePositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BudgetGuardError('INVALID_CONFIG', `${name} must be a positive integer, got ${value}.`);
  }
  return value;
}

export function resolvePolicy(policy: TenantPolicy): ResolvedTenantPolicy {
  const budgetMicroUsd = usdToMicroUsd(policy.budgetUsd);
  const budgetWindowMs = validatePositiveInt(
    'budgetWindowMs',
    policy.budgetWindowMs ?? DEFAULT_BUDGET_WINDOW_MS,
  );
  const rateWindowMs = validatePositiveInt(
    'rateWindowMs',
    policy.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS,
  );
  const reservationTtlMs = validatePositiveInt(
    'reservationTtlMs',
    policy.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS,
  );

  const maxRequestsPerWindow =
    policy.maxRequestsPerWindow !== undefined
      ? validatePositiveInt('maxRequestsPerWindow', policy.maxRequestsPerWindow)
      : null;

  const maxConcurrent =
    policy.maxConcurrent !== undefined
      ? validatePositiveInt('maxConcurrent', policy.maxConcurrent)
      : null;

  return {
    budgetMicroUsd,
    budgetWindowMs,
    maxRequestsPerWindow,
    rateWindowMs,
    maxConcurrent,
    reservationTtlMs,
  };
}

export class BudgetGuard {
  private readonly defaultPolicy: ResolvedTenantPolicy;
  private readonly store: BudgetStore;
  private readonly pricing: PricingTable;
  private readonly now: () => number;

  constructor(options: BudgetGuardOptions) {
    this.defaultPolicy = resolvePolicy(options.defaultPolicy);
    this.store = options.store ?? new MemoryBudgetStore();
    this.pricing = { ...DEFAULT_PRICING, ...options.pricing };
    this.now = options.now ?? (() => Date.now());
  }

  private getPolicy(override?: TenantPolicy): ResolvedTenantPolicy {
    return override ? resolvePolicy(override) : this.defaultPolicy;
  }

  /**
   * Phase 1: Reserve worst-case spend and a concurrency slot before calling the model.
   */
  async reserve(
    request: ReserveRequest,
  ): Promise<{ reservation: Reservation; snapshot: BudgetSnapshot }> {
    if (!request.tenantId.trim()) {
      throw new BudgetGuardError('INVALID_CONFIG', 'tenantId must be a non-empty string.');
    }
    if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 0) {
      throw new BudgetGuardError(
        'INVALID_CONFIG',
        `maxOutputTokens must be a non-negative integer, got ${request.maxOutputTokens}.`,
      );
    }

    const rate = resolveModelRate(request.model, this.pricing);
    const inputTokens =
      request.estimatedInputTokens ?? estimatePromptTokens(request.promptText ?? '');
    const estimatedMicroUsd = calculateCostMicroUsd(
      { inputTokens, outputTokens: request.maxOutputTokens },
      rate,
    );

    const policy = this.getPolicy(request.policy);
    return this.store.reserve({
      tenantId: request.tenantId,
      model: request.model,
      estimatedMicroUsd,
      policy,
      nowMs: this.now(),
    });
  }

  /**
   * Phase 2 (success): Replace a reservation with actual provider token usage.
   */
  async reconcile(
    reservation: Reservation,
    usage: TokenUsage,
    policyOverride?: TenantPolicy,
  ): Promise<SpendReceipt> {
    const rate = resolveModelRate(reservation.model, this.pricing);
    const actualMicroUsd = calculateCostMicroUsd(usage, rate);
    const policy = this.getPolicy(policyOverride);

    const snapshot = await this.store.reconcile({
      tenantId: reservation.tenantId,
      reservationId: reservation.id,
      actualMicroUsd,
      policy,
      nowMs: this.now(),
    });

    return {
      reservationId: reservation.id,
      tenantId: reservation.tenantId,
      model: reservation.model,
      reservedMicroUsd: reservation.reservedMicroUsd,
      actualMicroUsd,
      usage,
      snapshot,
    };
  }

  /**
   * Phase 2 (failure/abort): Release an active reservation, optionally charging partial tokens.
   */
  async release(
    reservation: Reservation,
    partialUsage?: TokenUsage,
    policyOverride?: TenantPolicy,
  ): Promise<BudgetSnapshot> {
    const policy = this.getPolicy(policyOverride);
    let partialMicroUsd: number | undefined;

    if (partialUsage) {
      const rate = resolveModelRate(reservation.model, this.pricing);
      partialMicroUsd = calculateCostMicroUsd(partialUsage, rate);
    }

    const releaseParams =
      partialMicroUsd !== undefined
        ? {
            tenantId: reservation.tenantId,
            reservationId: reservation.id,
            partialMicroUsd,
            policy,
            nowMs: this.now(),
          }
        : {
            tenantId: reservation.tenantId,
            reservationId: reservation.id,
            policy,
            nowMs: this.now(),
          };

    return this.store.release(releaseParams);
  }

  /**
   * Read the current tenant budget snapshot without mutating spend or rate limits.
   */
  async getSnapshot(tenantId: string, policyOverride?: TenantPolicy): Promise<BudgetSnapshot> {
    return this.store.getSnapshot(tenantId, this.getPolicy(policyOverride), this.now());
  }

  /**
   * High-level wrapper that runs reserve -> fn -> reconcile, and automatically calls
   * release() if fn throws.
   */
  async run<T>(
    request: ReserveRequest,
    fn: (reservation: Reservation) => Promise<RunCallbackResult<T>>,
  ): Promise<GuardRunResult<T>> {
    const { reservation } = await this.reserve(request);
    try {
      const { result, usage } = await fn(reservation);
      const receipt = await this.reconcile(reservation, usage, request.policy);
      return { result, receipt };
    } catch (error) {
      await this.release(reservation, undefined, request.policy);
      throw error;
    }
  }
}
