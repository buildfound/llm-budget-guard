import { BudgetGuardError, type ModelRate, type PricingTable, type TokenUsage } from './types.js';

export const MICRO_USD_PER_USD = 1_000_000;
const NANO_USD_PER_MICRO_USD = 1_000;

/**
 * Default reference rates in USD per 1M tokens.
 * Override or extend with your provider's current contract pricing.
 */
export const DEFAULT_PRICING: PricingTable = {
  'gpt-4o-mini': {
    inputPerMillionUsd: 0.15,
    outputPerMillionUsd: 0.6,
    cachedInputPerMillionUsd: 0.075,
  },
  'gpt-4o': {
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 10.0,
    cachedInputPerMillionUsd: 1.25,
  },
  'gpt-4.1-mini': {
    inputPerMillionUsd: 0.4,
    outputPerMillionUsd: 1.6,
    cachedInputPerMillionUsd: 0.1,
  },
  'claude-3-5-haiku': {
    inputPerMillionUsd: 0.8,
    outputPerMillionUsd: 4.0,
    cachedInputPerMillionUsd: 0.08,
  },
  'claude-sonnet-4': {
    inputPerMillionUsd: 3.0,
    outputPerMillionUsd: 15.0,
    cachedInputPerMillionUsd: 0.3,
  },
  'gemini-2.5-flash': {
    inputPerMillionUsd: 0.3,
    outputPerMillionUsd: 2.5,
    cachedInputPerMillionUsd: 0.075,
  },
};

export function usdToMicroUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new BudgetGuardError('INVALID_CONFIG', `Invalid USD amount: ${usd}`);
  }
  return Math.round(usd * MICRO_USD_PER_USD);
}

export function microUsdToUsd(microUsd: number): number {
  return microUsd / MICRO_USD_PER_USD;
}

export function formatMicroUsd(microUsd: number): string {
  return `$${microUsdToUsd(microUsd).toFixed(6)}`;
}

/**
 * Conservative pre-flight token estimator for UTF-8 text when a tokenizer is not loaded.
 * Uses a ~3.5 chars/token heuristic plus a small framing overhead so reservations
 * err slightly upward rather than under-reserving before a call.
 */
export function estimatePromptTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const byteLength = Buffer.byteLength(text, 'utf8');
  return Math.ceil(byteLength / 3.5) + 12;
}

function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new BudgetGuardError('INVALID_CONFIG', `${name} must be a non-negative integer, got ${value}.`);
  }
}

function rateToNanoUsdPerToken(ratePerMillionUsd: number): number {
  if (!Number.isFinite(ratePerMillionUsd) || ratePerMillionUsd < 0) {
    throw new BudgetGuardError('INVALID_CONFIG', `Model rate must be >= 0, got ${ratePerMillionUsd}.`);
  }
  // $1.00 / 1M tokens == 1 microUsd / token == 1000 nanoUsd / token
  return Math.round(ratePerMillionUsd * NANO_USD_PER_MICRO_USD);
}

export function calculateCostMicroUsd(usage: TokenUsage, rate: ModelRate): number {
  assertNonNegativeInt('inputTokens', usage.inputTokens);
  assertNonNegativeInt('outputTokens', usage.outputTokens);
  const cachedTokens = usage.cachedInputTokens ?? 0;
  assertNonNegativeInt('cachedInputTokens', cachedTokens);

  if (cachedTokens > usage.inputTokens) {
    throw new BudgetGuardError(
      'INVALID_CONFIG',
      `cachedInputTokens (${cachedTokens}) cannot exceed inputTokens (${usage.inputTokens}).`,
    );
  }

  const uncachedInputTokens = usage.inputTokens - cachedTokens;
  const inputNano = uncachedInputTokens * rateToNanoUsdPerToken(rate.inputPerMillionUsd);
  const cachedRate = rate.cachedInputPerMillionUsd ?? rate.inputPerMillionUsd;
  const cachedNano = cachedTokens * rateToNanoUsdPerToken(cachedRate);
  const outputNano = usage.outputTokens * rateToNanoUsdPerToken(rate.outputPerMillionUsd);

  const totalNano = inputNano + cachedNano + outputNano;
  return Math.ceil(totalNano / NANO_USD_PER_MICRO_USD);
}

export function resolveModelRate(model: string, pricing: PricingTable): ModelRate {
  if (!Object.hasOwn(pricing, model)) {
    throw new BudgetGuardError('UNKNOWN_MODEL', `No pricing configured for model "${model}".`);
  }
  const rate = pricing[model];
  if (!rate) {
    throw new BudgetGuardError('UNKNOWN_MODEL', `No pricing configured for model "${model}".`);
  }
  return rate;
}
