import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  BudgetExceededError,
  ConcurrencyLimitError,
  RateLimitError,
  type BudgetSnapshot,
  type Reservation,
  type ResolvedTenantPolicy,
} from './types.js';

export interface StoredReservation {
  id: string;
  model: string;
  reservedMicroUsd: number;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface TenantState {
  windowStartMs: number;
  spentMicroUsd: number;
  requestTimestampsMs: number[];
  reservations: Record<string, StoredReservation>;
}

export interface ReserveParams {
  tenantId: string;
  model: string;
  estimatedMicroUsd: number;
  policy: ResolvedTenantPolicy;
  nowMs: number;
}

export interface ReconcileParams {
  tenantId: string;
  reservationId: string;
  actualMicroUsd: number;
  policy: ResolvedTenantPolicy;
  nowMs: number;
}

export interface ReleaseParams {
  tenantId: string;
  reservationId: string;
  partialMicroUsd?: number;
  policy: ResolvedTenantPolicy;
  nowMs: number;
}

export interface BudgetStore {
  reserve(params: ReserveParams): Promise<{ reservation: Reservation; snapshot: BudgetSnapshot }>;
  reconcile(params: ReconcileParams): Promise<BudgetSnapshot>;
  release(params: ReleaseParams): Promise<BudgetSnapshot>;
  getSnapshot(tenantId: string, policy: ResolvedTenantPolicy, nowMs: number): Promise<BudgetSnapshot>;
}

function getWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

function sweepTenantState(
  state: TenantState | undefined,
  policy: ResolvedTenantPolicy,
  nowMs: number,
): TenantState {
  const currentWindowStart = getWindowStart(nowMs, policy.budgetWindowMs);
  const next: TenantState = state
    ? {
        windowStartMs: state.windowStartMs,
        spentMicroUsd: state.spentMicroUsd,
        requestTimestampsMs: [...state.requestTimestampsMs],
        reservations: { ...state.reservations },
      }
    : {
        windowStartMs: currentWindowStart,
        spentMicroUsd: 0,
        requestTimestampsMs: [],
        reservations: {},
      };

  // Roll over spent counter when entering a new budget window.
  if (next.windowStartMs !== currentWindowStart) {
    next.windowStartMs = currentWindowStart;
    next.spentMicroUsd = 0;
  }

  // Drop expired reservations so crashed requests never lock budget or concurrency forever.
  for (const [id, reservation] of Object.entries(next.reservations)) {
    if (reservation.expiresAtMs <= nowMs) {
      delete next.reservations[id];
    }
  }

  // Drop request timestamps outside the sliding rate window.
  const rateCutoff = nowMs - policy.rateWindowMs;
  next.requestTimestampsMs = next.requestTimestampsMs.filter((ts) => ts > rateCutoff);

  return next;
}

function buildSnapshot(
  tenantId: string,
  state: TenantState,
  policy: ResolvedTenantPolicy,
): BudgetSnapshot {
  const activeReservations = Object.values(state.reservations);
  const reservedMicroUsd = activeReservations.reduce((sum, r) => sum + r.reservedMicroUsd, 0);
  const remainingMicroUsd = Math.max(
    0,
    policy.budgetMicroUsd - state.spentMicroUsd - reservedMicroUsd,
  );

  return {
    tenantId,
    windowStartMs: state.windowStartMs,
    windowResetAtMs: state.windowStartMs + policy.budgetWindowMs,
    limitMicroUsd: policy.budgetMicroUsd,
    spentMicroUsd: state.spentMicroUsd,
    reservedMicroUsd,
    remainingMicroUsd,
    activeReservations: activeReservations.length,
    requestsInRateWindow: state.requestTimestampsMs.length,
  };
}

function applyReserve(
  current: TenantState | undefined,
  params: ReserveParams,
): { state: TenantState; reservation: Reservation; snapshot: BudgetSnapshot } {
  const state = sweepTenantState(current, params.policy, params.nowMs);
  const snapshotBefore = buildSnapshot(params.tenantId, state, params.policy);

  if (
    params.policy.maxRequestsPerWindow !== null &&
    state.requestTimestampsMs.length >= params.policy.maxRequestsPerWindow
  ) {
    const oldestTs = state.requestTimestampsMs[0] ?? params.nowMs;
    const retryAfterMs = Math.max(1, oldestTs + params.policy.rateWindowMs - params.nowMs);
    throw new RateLimitError(params.tenantId, retryAfterMs, snapshotBefore);
  }

  if (
    params.policy.maxConcurrent !== null &&
    snapshotBefore.activeReservations >= params.policy.maxConcurrent
  ) {
    throw new ConcurrencyLimitError(params.tenantId, params.policy.maxConcurrent, snapshotBefore);
  }

  const projectedMicroUsd =
    state.spentMicroUsd + snapshotBefore.reservedMicroUsd + params.estimatedMicroUsd;
  if (projectedMicroUsd > params.policy.budgetMicroUsd) {
    throw new BudgetExceededError(params.tenantId, params.estimatedMicroUsd, snapshotBefore);
  }

  const id = randomUUID();
  const stored: StoredReservation = {
    id,
    model: params.model,
    reservedMicroUsd: params.estimatedMicroUsd,
    createdAtMs: params.nowMs,
    expiresAtMs: params.nowMs + params.policy.reservationTtlMs,
  };

  state.reservations[id] = stored;
  state.requestTimestampsMs.push(params.nowMs);

  const reservation: Reservation = {
    id,
    tenantId: params.tenantId,
    model: params.model,
    reservedMicroUsd: stored.reservedMicroUsd,
    createdAtMs: stored.createdAtMs,
    expiresAtMs: stored.expiresAtMs,
  };

  return {
    state,
    reservation,
    snapshot: buildSnapshot(params.tenantId, state, params.policy),
  };
}

function applyReconcile(
  current: TenantState | undefined,
  params: ReconcileParams,
): { state: TenantState; snapshot: BudgetSnapshot } {
  const state = sweepTenantState(current, params.policy, params.nowMs);
  delete state.reservations[params.reservationId];
  state.spentMicroUsd += params.actualMicroUsd;
  return {
    state,
    snapshot: buildSnapshot(params.tenantId, state, params.policy),
  };
}

function applyRelease(
  current: TenantState | undefined,
  params: ReleaseParams,
): { state: TenantState; snapshot: BudgetSnapshot } {
  const state = sweepTenantState(current, params.policy, params.nowMs);
  delete state.reservations[params.reservationId];
  if (params.partialMicroUsd && params.partialMicroUsd > 0) {
    state.spentMicroUsd += params.partialMicroUsd;
  }
  return {
    state,
    snapshot: buildSnapshot(params.tenantId, state, params.policy),
  };
}

/**
 * Fast, synchronous-mutation in-memory store for single-process servers and unit tests.
 */
export class MemoryBudgetStore implements BudgetStore {
  private readonly tenants = new Map<string, TenantState>();

  async reserve(
    params: ReserveParams,
  ): Promise<{ reservation: Reservation; snapshot: BudgetSnapshot }> {
    const result = applyReserve(this.tenants.get(params.tenantId), params);
    this.tenants.set(params.tenantId, result.state);
    return { reservation: result.reservation, snapshot: result.snapshot };
  }

  async reconcile(params: ReconcileParams): Promise<BudgetSnapshot> {
    const result = applyReconcile(this.tenants.get(params.tenantId), params);
    this.tenants.set(params.tenantId, result.state);
    return result.snapshot;
  }

  async release(params: ReleaseParams): Promise<BudgetSnapshot> {
    const result = applyRelease(this.tenants.get(params.tenantId), params);
    this.tenants.set(params.tenantId, result.state);
    return result.snapshot;
  }

  async getSnapshot(
    tenantId: string,
    policy: ResolvedTenantPolicy,
    nowMs: number,
  ): Promise<BudgetSnapshot> {
    const state = sweepTenantState(this.tenants.get(tenantId), policy, nowMs);
    this.tenants.set(tenantId, state);
    return buildSnapshot(tenantId, state, policy);
  }
}

interface PersistedFileShape {
  version: 1;
  tenants: Record<string, TenantState>;
}

/**
 * Single-node JSON file store with serialized in-process writes and atomic renames.
 * Survives process restarts without external infrastructure; swap for a Redis or
 * Postgres store when running multiple application replicas.
 */
export class JsonFileBudgetStore implements BudgetStore {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readAll(): Promise<Record<string, TenantState>> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedFileShape>;
      if (parsed && parsed.version === 1 && parsed.tenants && typeof parsed.tenants === 'object') {
        return parsed.tenants;
      }
      return {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  private async writeAll(tenants: Record<string, TenantState>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: PersistedFileShape = { version: 1, tenants };
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tempPath, this.filePath);
  }

  async reserve(
    params: ReserveParams,
  ): Promise<{ reservation: Reservation; snapshot: BudgetSnapshot }> {
    return this.enqueue(async () => {
      const tenants = await this.readAll();
      const result = applyReserve(tenants[params.tenantId], params);
      tenants[params.tenantId] = result.state;
      await this.writeAll(tenants);
      return { reservation: result.reservation, snapshot: result.snapshot };
    });
  }

  async reconcile(params: ReconcileParams): Promise<BudgetSnapshot> {
    return this.enqueue(async () => {
      const tenants = await this.readAll();
      const result = applyReconcile(tenants[params.tenantId], params);
      tenants[params.tenantId] = result.state;
      await this.writeAll(tenants);
      return result.snapshot;
    });
  }

  async release(params: ReleaseParams): Promise<BudgetSnapshot> {
    return this.enqueue(async () => {
      const tenants = await this.readAll();
      const result = applyRelease(tenants[params.tenantId], params);
      tenants[params.tenantId] = result.state;
      await this.writeAll(tenants);
      return result.snapshot;
    });
  }

  async getSnapshot(
    tenantId: string,
    policy: ResolvedTenantPolicy,
    nowMs: number,
  ): Promise<BudgetSnapshot> {
    return this.enqueue(async () => {
      const tenants = await this.readAll();
      const state = sweepTenantState(tenants[tenantId], policy, nowMs);
      tenants[tenantId] = state;
      await this.writeAll(tenants);
      return buildSnapshot(tenantId, state, policy);
    });
  }
}
