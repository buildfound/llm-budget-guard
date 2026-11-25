import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PRICING,
  calculateCostMicroUsd,
  estimatePromptTokens,
  formatMicroUsd,
  microUsdToUsd,
  resolveModelRate,
  usdToMicroUsd,
} from '../src/pricing.js';
import { BudgetGuardError } from '../src/types.js';

describe('pricing math', () => {
  it('converts USD to integer microdollars without float drift', () => {
    assert.equal(usdToMicroUsd(0.1) + usdToMicroUsd(0.2), usdToMicroUsd(0.3));
    assert.equal(usdToMicroUsd(1.5), 1_500_000);
    assert.equal(microUsdToUsd(150_000), 0.15);
    assert.equal(formatMicroUsd(150), '$0.000150');
  });

  it('calculates exact token costs and rounds fractional microdollars up', () => {
    const mini = resolveModelRate('gpt-4o-mini', DEFAULT_PRICING);
    // 1,000,000 input @ $0.15/1M + 1,000,000 output @ $0.60/1M = $0.75 = 750,000 microUsd
    assert.equal(
      calculateCostMicroUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, mini),
      750_000,
    );

    // 10 input tokens @ $0.15/1M = 1.5 microUsd -> rounds up to 2 microUsd
    assert.equal(calculateCostMicroUsd({ inputTokens: 10, outputTokens: 0 }, mini), 2);
  });

  it('prices cached input tokens at the cached rate when provided', () => {
    const sonnet = resolveModelRate('claude-sonnet-4', DEFAULT_PRICING);
    // 1000 input (800 cached @ $0.30/1M = 240, 200 uncached @ $3.00/1M = 600) + 100 output @ $15/1M = 1500
    const cost = calculateCostMicroUsd(
      { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100 },
      sonnet,
    );
    assert.equal(cost, 2_340);
  });

  it('rejects invalid token counts and unknown models', () => {
    const mini = resolveModelRate('gpt-4o-mini', DEFAULT_PRICING);
    assert.throws(
      () => calculateCostMicroUsd({ inputTokens: 10, cachedInputTokens: 20, outputTokens: 0 }, mini),
      (err: unknown) => err instanceof BudgetGuardError && err.code === 'INVALID_CONFIG',
    );
    assert.throws(
      () => resolveModelRate('non-existent-model', DEFAULT_PRICING),
      (err: unknown) => err instanceof BudgetGuardError && err.code === 'UNKNOWN_MODEL',
    );
  });

  it('estimates prompt tokens conservatively for ASCII and multibyte UTF-8 text', () => {
    assert.equal(estimatePromptTokens(''), 0);
    const shortEstimate = estimatePromptTokens('Hello world');
    assert.ok(shortEstimate >= 15);
    const utf8Estimate = estimatePromptTokens('こんにちは世界'.repeat(10));
    assert.ok(utf8Estimate > estimatePromptTokens('a'.repeat(70)));
  });
});
