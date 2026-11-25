import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetGuard } from '../src/guard.js';
import { budgetHeaders, toBudgetErrorResponse } from '../src/http.js';

describe('HTTP helpers', () => {
  it('maps BudgetExceededError to HTTP 402 with budget headers', async () => {
    const guard = new BudgetGuard({
      defaultPolicy: { budgetUsd: 0.0001 },
    });

    let caught: unknown;
    try {
      await guard.reserve({
        tenantId: 'org_http',
        model: 'gpt-4o',
        estimatedInputTokens: 500,
        maxOutputTokens: 500,
      });
    } catch (error) {
      caught = error;
    }

    const res = toBudgetErrorResponse(caught);
    assert.ok(res);
    assert.equal(res.status, 402);
    assert.equal(res.headers.get('X-Budget-Limit-Usd'), '0.000100');
    assert.equal(res.headers.get('X-Budget-Remaining-Usd'), '0.000100');

    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'BUDGET_EXCEEDED');
  });

  it('maps RateLimitError and ConcurrencyLimitError to HTTP 429 with Retry-After', async () => {
    let nowMs = 1_700_000_000_000;
    const guard = new BudgetGuard({
      defaultPolicy: {
        budgetUsd: 1.0,
        maxRequestsPerWindow: 1,
        rateWindowMs: 30_000,
      },
      now: () => nowMs,
    });

    const first = await guard.reserve({
      tenantId: 'org_429',
      model: 'gpt-4o-mini',
      estimatedInputTokens: 10,
      maxOutputTokens: 10,
    });
    await guard.reconcile(first.reservation, { inputTokens: 10, outputTokens: 10 });

    nowMs += 5_000;
    let rateErr: unknown;
    try {
      await guard.reserve({
        tenantId: 'org_429',
        model: 'gpt-4o-mini',
        estimatedInputTokens: 10,
        maxOutputTokens: 10,
      });
    } catch (error) {
      rateErr = error;
    }

    const res = toBudgetErrorResponse(rateErr);
    assert.ok(res);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '25');
  });

  it('returns null for non-guard errors and formats snapshot headers', async () => {
    assert.equal(toBudgetErrorResponse(new Error('unrelated')), null);

    const guard = new BudgetGuard({
      defaultPolicy: { budgetUsd: 2.5 },
      now: () => 1_700_000_000_000,
    });
    const snapshot = await guard.getSnapshot('org_headers');
    const headers = budgetHeaders(snapshot);

    assert.equal(headers['X-Budget-Limit-Usd'], '2.500000');
    assert.equal(headers['X-Budget-Spent-Usd'], '0.000000');
    assert.equal(headers['X-Budget-Remaining-Usd'], '2.500000');
    assert.ok(headers['X-Budget-Reset-At']);
  });
});
