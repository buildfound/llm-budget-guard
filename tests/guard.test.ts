import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BudgetGuard } from '../src/guard.js';
import { JsonFileBudgetStore, MemoryBudgetStore } from '../src/store.js';
import {
  BudgetExceededError,
  ConcurrencyLimitError,
  RateLimitError,
} from '../src/types.js';

describe('BudgetGuard', () => {
  it('reserves worst-case spend and reconciles to actual spend', async () => {
    let nowMs = 1_700_000_000_000;
    const guard = new BudgetGuard({
      defaultPolicy: { budgetUsd: 0.01 },
      now: () => nowMs,
    });

    const { reservation, snapshot: afterReserve } = await guard.reserve({
      tenantId: 'org_1',
      model: 'gpt-4o-mini',
      estimatedInputTokens: 1000,
      maxOutputTokens: 2000,
    });

    // 1000 * 0.15 + 2000 * 0.60 = 150 + 1200 = 1350 microUsd
    assert.equal(reservation.reservedMicroUsd, 1_350);
    assert.equal(afterReserve.reservedMicroUsd, 1_350);
    assert.equal(afterReserve.spentMicroUsd, 0);
    assert.equal(afterReserve.remainingMicroUsd, 10_000 - 1_350);

    const receipt = await guard.reconcile(reservation, {
      inputTokens: 900,
      outputTokens: 100,
    });

    // 900 * 0.15 + 100 * 0.60 = 135 + 60 = 195 microUsd
    assert.equal(receipt.actualMicroUsd, 195);
    assert.equal(receipt.snapshot.reservedMicroUsd, 0);
    assert.equal(receipt.snapshot.spentMicroUsd, 195);
    assert.equal(receipt.snapshot.remainingMicroUsd, 10_000 - 195);
    assert.equal(receipt.snapshot.activeReservations, 0);
  });

  it('prevents concurrent requests from overspending the budget', async () => {
    const guard = new BudgetGuard({
      // Budget fits 1 reservation of 1000 output tokens on gpt-4o ($0.01), not 2 ($0.02)
      defaultPolicy: { budgetUsd: 0.015 },
    });

    const first = await guard.reserve({
      tenantId: 'org_race',
      model: 'gpt-4o',
      estimatedInputTokens: 0,
      maxOutputTokens: 1000, // $0.010
    });

    await assert.rejects(
      () =>
        guard.reserve({
          tenantId: 'org_race',
          model: 'gpt-4o',
          estimatedInputTokens: 0,
          maxOutputTokens: 1000, // would push reserved to $0.020 > $0.015
        }),
      (err: unknown) => err instanceof BudgetExceededError && err.code === 'BUDGET_EXCEEDED',
    );

    // Reconcile the first call to tiny actual usage ($0.001) so the second now fits.
    await guard.reconcile(first.reservation, { inputTokens: 0, outputTokens: 100 });

    const second = await guard.reserve({
      tenantId: 'org_race',
      model: 'gpt-4o',
      estimatedInputTokens: 0,
      maxOutputTokens: 1000,
    });
    assert.equal(second.snapshot.spentMicroUsd, 1_000);
    assert.equal(second.snapshot.reservedMicroUsd, 10_000);
  });

  it('releases reservation automatically when guard.run callback throws', async () => {
    const guard = new BudgetGuard({
      defaultPolicy: { budgetUsd: 0.01, maxConcurrent: 1 },
    });

    await assert.rejects(
      () =>
        guard.run(
          {
            tenantId: 'org_err',
            model: 'gpt-4o-mini',
            estimatedInputTokens: 500,
            maxOutputTokens: 500,
          },
          async () => {
            throw new Error('provider down');
          },
        ),
      /provider down/,
    );

    const snapshot = await guard.getSnapshot('org_err');
    assert.equal(snapshot.spentMicroUsd, 0);
    assert.equal(snapshot.reservedMicroUsd, 0);
    assert.equal(snapshot.activeReservations, 0);
  });

  it('charges partial tokens when release is called with partial usage', async () => {
    const guard = new BudgetGuard({
      defaultPolicy: { budgetUsd: 0.05 },
    });

    const { reservation } = await guard.reserve({
      tenantId: 'org_stream',
      model: 'gpt-4o-mini',
      estimatedInputTokens: 1000,
      maxOutputTokens: 4000,
    });

    const snapshot = await guard.release(reservation, {
      inputTokens: 1000,
      outputTokens: 50,
    });

    // 1000 * 0.15 + 50 * 0.60 = 150 + 30 = 180 microUsd
    assert.equal(snapshot.spentMicroUsd, 180);
    assert.equal(snapshot.reservedMicroUsd, 0);
  });

  it('enforces sliding-window rate limits and recovers as timestamps age out', async () => {
    let nowMs = 1_700_000_000_000;
    const guard = new BudgetGuard({
      defaultPolicy: {
        budgetUsd: 1.0,
        maxRequestsPerWindow: 2,
        rateWindowMs: 10_000,
      },
      now: () => nowMs,
    });

    const r1 = await guard.reserve({
      tenantId: 'org_rl',
      model: 'gpt-4o-mini',
      estimatedInputTokens: 10,
      maxOutputTokens: 10,
    });
    await guard.reconcile(r1.reservation, { inputTokens: 10, outputTokens: 5 });

    nowMs += 3_000;
    const r2 = await guard.reserve({
      tenantId: 'org_rl',
      model: 'gpt-4o-mini',
      estimatedInputTokens: 10,
      maxOutputTokens: 10,
    });
    await guard.reconcile(r2.reservation, { inputTokens: 10, outputTokens: 5 });

    nowMs += 1_000;
    await assert.rejects(
      () =>
        guard.reserve({
          tenantId: 'org_rl',
          model: 'gpt-4o-mini',
          estimatedInputTokens: 10,
          maxOutputTokens: 10,
        }),
      (err: unknown) => err instanceof RateLimitError && err.retryAfterMs === 6_000,
    );

    // Advance past the first request's 10s window
    nowMs += 6_001;
    const r3 = await guard.reserve({
      tenantId: 'org_rl',
      model: 'gpt-4o-mini',
      estimatedInputTokens: 10,
      maxOutputTokens: 10,
    });
    assert.equal(r3.snapshot.requestsInRateWindow, 2);
  });

  it('enforces maxConcurrent and sweeps expired reservations after TTL', async () => {
    let nowMs = 1_700_000_000_000;
    const guard = new BudgetGuard({
      defaultPolicy: {
        budgetUsd: 1.0,
        maxConcurrent: 1,
        reservationTtlMs: 30_000,
      },
      now: () => nowMs,
    });

    await guard.reserve({
      tenantId: 'org_conc',
      model: 'gpt-4o-mini',
      estimatedInputTokens: 100,
      maxOutputTokens: 100,
    });

    await assert.rejects(
      () =>
        guard.reserve({
          tenantId: 'org_conc',
          model: 'gpt-4o-mini',
          estimatedInputTokens: 100,
          maxOutputTokens: 100,
        }),
      (err: unknown) => err instanceof ConcurrencyLimitError && err.maxConcurrent === 1,
    );

    // Simulate crashed request whose reservation expires after TTL
    nowMs += 30_000;
    const recovered = await guard.reserve({
      tenantId: 'org_conc',
      model: 'gpt-4o-mini',
      estimatedInputTokens: 100,
      maxOutputTokens: 100,
    });
    assert.equal(recovered.snapshot.activeReservations, 1);
  });

  it('resets spent budget when crossing into a new budget window', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    let nowMs = dayMs * 20_000 + 1_000;
    const guard = new BudgetGuard({
      defaultPolicy: { budgetUsd: 0.001, budgetWindowMs: dayMs },
      now: () => nowMs,
    });

    const { reservation } = await guard.reserve({
      tenantId: 'org_day',
      model: 'gpt-4o-mini',
      estimatedInputTokens: 0,
      maxOutputTokens: 1000,
    });
    await guard.reconcile(reservation, { inputTokens: 0, outputTokens: 1000 });

    const beforeRollover = await guard.getSnapshot('org_day');
    assert.equal(beforeRollover.spentMicroUsd, 600);

    nowMs += dayMs;
    const afterRollover = await guard.getSnapshot('org_day');
    assert.equal(afterRollover.spentMicroUsd, 0);
    assert.equal(afterRollover.remainingMicroUsd, 1_000);
  });

  it('persists tenant spend across restarts with JsonFileBudgetStore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-budget-guard-'));
    const filePath = join(dir, 'budget-state.json');

    try {
      const nowMs = 1_700_000_000_000;
      const storeA = new JsonFileBudgetStore(filePath);
      const guardA = new BudgetGuard({
        defaultPolicy: { budgetUsd: 0.05 },
        store: storeA,
        now: () => nowMs,
      });

      const runA = await guardA.run(
        {
          tenantId: 'org_file',
          model: 'gpt-4o-mini',
          estimatedInputTokens: 1000,
          maxOutputTokens: 1000,
        },
        async () => ({
          result: 'persisted',
          usage: { inputTokens: 1000, outputTokens: 500 },
        }),
      );
      assert.equal(runA.result, 'persisted');

      // New store instance reading from the same file
      const storeB = new JsonFileBudgetStore(filePath);
      const guardB = new BudgetGuard({
        defaultPolicy: { budgetUsd: 0.05 },
        store: storeB,
        now: () => nowMs + 1_000,
      });

      const snapshot = await guardB.getSnapshot('org_file');
      // 1000 * 0.15 + 500 * 0.60 = 150 + 300 = 450 microUsd
      assert.equal(snapshot.spentMicroUsd, 450);
      assert.equal(snapshot.remainingMicroUsd, 50_000 - 450);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports custom model pricing and per-tenant policy overrides', async () => {
    const guard = new BudgetGuard({
      defaultPolicy: { budgetUsd: 0.001 },
      pricing: {
        'custom-small': {
          inputPerMillionUsd: 0.5,
          outputPerMillionUsd: 1.0,
        },
      },
      store: new MemoryBudgetStore(),
    });

    const { receipt } = await guard.run(
      {
        tenantId: 'org_enterprise',
        model: 'custom-small',
        estimatedInputTokens: 10_000,
        maxOutputTokens: 5_000,
        policy: { budgetUsd: 10.0 },
      },
      async () => ({
        result: 'ok',
        usage: { inputTokens: 2_000, outputTokens: 1_000 },
      }),
    );

    // 2000 * 0.5 + 1000 * 1.0 = 2000 microUsd
    assert.equal(receipt.actualMicroUsd, 2_000);
    assert.equal(receipt.snapshot.limitMicroUsd, 10_000_000);
  });
});
